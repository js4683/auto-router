import { selectModel, type AvengersProPrediction, type Catalog, type ModelEntry, type RouterState, type RoutingCapability, type RoutingTransport, type SelectionRequirements, type SelectionResult } from "@auto-router/router-core";
import { liveTransportFor } from "./live.js";
import { modelRuntimeId, selectCheap, selectFrontier } from "./strategies.js";
import type { EvalDatasetV1, EvalTurnV1, ReplayResult, ReplayTurnResult, StrategyReplayResult } from "./types.js";

export function advanceRouterState(state: RouterState, result: SelectionResult): RouterState {
  if (result.via !== "stay-sticky" && result.via !== "context-fit-block") {
    return { currentModel: result.modelId, currentTier: result.tier, downgradeCounter: 0 };
  }
  if (result.blockedDowngrade) return { ...state, downgradeCounter: state.downgradeCounter + 1 };
  return state;
}

function modelForId(dataset: EvalDatasetV1, modelId: string): ModelEntry {
  const model = dataset.catalog.models.find((candidate) => candidate.id === modelId || modelRuntimeId(candidate) === modelId);
  if (!model) throw new Error(`selected model ${modelId} is absent from catalog`);
  return model;
}

function baselineTurn(sessionId: string, turn: EvalTurnV1, model: ModelEntry, strategy: "always-frontier" | "always-cheap"): ReplayTurnResult {
  return {
    sessionId,
    turnId: turn.id,
    modelId: modelRuntimeId(model),
    tier: null,
    taskType: null,
    via: strategy,
    reason: strategy === "always-frontier" ? "highest eligible coding index" : "lowest eligible blended price",
    codingIndex: model.codingIndex,
    usage: turn.usage,
    weight: turn.weight ?? 1,
    terminalState: turn.terminalState,
    contentTruncated: turn.contentTruncated,
  };
}

function turnCompletenessReasons(sessionId: string, turn: EvalTurnV1): string[] {
  return [
    ...(turn.terminalState === "completed" ? [] : [`recorded turn ${sessionId}/${turn.id} has terminal state ${turn.terminalState}`]),
    ...(turn.contentTruncated ? [`recorded turn ${sessionId}/${turn.id} has truncated content`] : []),
  ];
}

function addIncompleteReasons(result: StrategyReplayResult, reasons: string[]): void {
  for (const reason of reasons) if (!result.incompleteReasons.includes(reason)) result.incompleteReasons.push(reason);
}

function emptyResult(): ReplayResult {
  return {
    strategies: {
      router: { name: "router", turns: [], incompleteReasons: [] },
      "always-frontier": { name: "always-frontier", turns: [], incompleteReasons: [] },
      "always-cheap": { name: "always-cheap", turns: [], incompleteReasons: [] },
    },
  };
}

function appendBaseline(result: StrategyReplayResult, sessionId: string, turn: EvalTurnV1, select: () => ModelEntry): void {
  try {
    result.turns.push(baselineTurn(sessionId, turn, select(), result.name as "always-frontier" | "always-cheap"));
  } catch (error) {
    result.incompleteReasons.push(error instanceof Error ? error.message : "baseline selection failed");
  }
}

export interface ReplayRouterStep {
  selection: SelectionResult;
  state: RouterState;
  previousAgent?: string;
  previousMessage?: string;
}

function replayRequirements(dataset: EvalDatasetV1, turn: EvalTurnV1): SelectionRequirements {
  const requiredCapabilities: RoutingCapability[] = turn.requiredCapabilities.length
    ? turn.requiredCapabilities as RoutingCapability[]
    : ["text"];
  return {
    lifetimeTokens: turn.sessionState.lifetimeTokens,
    requiredCapabilities,
    transport: liveTransportFor(dataset) as RoutingTransport,
  };
}

function replayCatalog(dataset: EvalDatasetV1): Catalog {
  return {
    ...dataset.catalog,
    models: dataset.catalog.models.map((model) => {
      const runtimeId = modelRuntimeId(model);
      const capabilities = dataset.capabilities?.[runtimeId] ?? dataset.capabilities?.[model.id];
      const transport = dataset.liveTransports?.[runtimeId] ?? dataset.liveTransports?.[model.id];
      return {
        ...model,
        ...(capabilities !== undefined ? { capabilities: capabilities as RoutingCapability[] } : {}),
        ...(transport !== undefined
          ? { transports: [transport as RoutingTransport] }
          : model.transports === undefined
            ? { transports: [liveTransportFor(dataset, runtimeId) as RoutingTransport] }
            : {}),
      };
    }),
  };
}

export function selectReplayRouterStep(
  dataset: EvalDatasetV1,
  turn: EvalTurnV1,
  state: RouterState,
  previousAgent?: string,
  previousMessage?: string,
  avengers?: AvengersProPrediction
): ReplayRouterStep {
  const requirements = replayRequirements(dataset, turn);
  const selection = selectModel(
    turn.sessionState,
    replayCatalog(dataset),
    dataset.config,
    state,
    turn.prevAgent ?? previousAgent,
    turn.prevMessage ?? previousMessage,
    avengers,
    requirements,
  );
  return {
    selection,
    state: advanceRouterState(state, selection),
    previousAgent: turn.sessionState.activeAgent,
    previousMessage: turn.sessionState.currentTask.lastUserMessage,
  };
}

export function replayDataset(dataset: EvalDatasetV1): ReplayResult {
  const replay = emptyResult();
  for (const session of dataset.sessions) {
    let state: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    let previousAgent: string | undefined;
    let previousMessage: string | undefined;
    for (const turn of session.turns) {
      const completenessReasons = turnCompletenessReasons(session.id, turn);
      for (const strategy of Object.values(replay.strategies)) addIncompleteReasons(strategy, completenessReasons);
      const step = selectReplayRouterStep(dataset, turn, state, previousAgent, previousMessage);
      const model = modelForId(dataset, step.selection.modelId);
      replay.strategies.router.turns.push({
        sessionId: session.id,
        turnId: turn.id,
        modelId: step.selection.modelId,
        tier: step.selection.tier,
        taskType: step.selection.taskType,
        via: step.selection.via,
        reason: step.selection.reason,
        codingIndex: model.codingIndex,
        usage: turn.usage,
        weight: turn.weight ?? 1,
        terminalState: turn.terminalState,
        contentTruncated: turn.contentTruncated,
      });
      state = step.state;
      previousAgent = step.previousAgent;
      previousMessage = step.previousMessage;
      appendBaseline(replay.strategies["always-frontier"], session.id, turn, () => selectFrontier(dataset, turn));
      appendBaseline(replay.strategies["always-cheap"], session.id, turn, () => selectCheap(dataset, turn));
    }
  }
  return replay;
}
