import { classify, selectModel, tierRank, type AvengersProPrediction, type ModelEntry, type RouterState, type SelectionResult } from "@auto-router/router-core";
import { capabilityEligibleModels, eligibleModels, modelRuntimeId, selectCheap, selectFrontier } from "./strategies.js";
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

export function selectReplayRouterStep(
  dataset: EvalDatasetV1,
  turn: EvalTurnV1,
  state: RouterState,
  previousAgent?: string,
  previousMessage?: string,
  avengers?: AvengersProPrediction
): ReplayRouterStep {
  const eligible = eligibleModels(dataset, turn);
  if (!eligible.length) throw new Error(`no eligible model for turn ${turn.id}`);
  const capabilityEligible = capabilityEligibleModels(dataset, turn);
  const eligibleIds = new Set(eligible.flatMap((model) => [model.id, modelRuntimeId(model)]));
  const selectionState = state.currentModel && !eligibleIds.has(state.currentModel)
    ? { currentModel: null, currentTier: null, downgradeCounter: 0 }
    : state;
  const requestedTier = classify(turn.sessionState, dataset.config).tier;
  const isDowngrade = selectionState.currentTier !== null && tierRank(requestedTier) < tierRank(selectionState.currentTier);
  const routerModels = isDowngrade ? capabilityEligible : eligible;
  const selection = selectModel(
    turn.sessionState,
    { ...dataset.catalog, models: routerModels.map((model) => ({ ...model })) },
    dataset.config,
    selectionState,
    turn.prevAgent ?? previousAgent,
    turn.prevMessage ?? previousMessage,
    avengers
  );
  return {
    selection,
    state: advanceRouterState(selectionState, selection),
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
