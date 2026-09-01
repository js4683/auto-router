import { selectModel, type ModelEntry, type RouterState, type SelectionResult } from "@auto-router/router-core";
import { eligibleModels, modelRuntimeId, selectCheap, selectFrontier } from "./strategies.js";
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
  };
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

export function replayDataset(dataset: EvalDatasetV1): ReplayResult {
  const replay = emptyResult();
  for (const session of dataset.sessions) {
    let state: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    let previousAgent: string | undefined;
    let previousMessage: string | undefined;
    for (const turn of session.turns) {
      const eligible = eligibleModels(dataset, turn);
      if (!eligible.length) throw new Error(`no eligible model for turn ${turn.id}`);
      const eligibleIds = new Set(eligible.flatMap((model) => [model.id, modelRuntimeId(model)]));
      const selectionState = state.currentModel && !eligibleIds.has(state.currentModel)
        ? { currentModel: null, currentTier: null, downgradeCounter: 0 }
        : state;
      const selection = selectModel(
        turn.sessionState,
        { ...dataset.catalog, models: eligible.map((model) => ({ ...model })) },
        dataset.config,
        selectionState,
        turn.prevAgent ?? previousAgent,
        turn.prevMessage ?? previousMessage
      );
      const model = modelForId(dataset, selection.modelId);
      replay.strategies.router.turns.push({
        sessionId: session.id,
        turnId: turn.id,
        modelId: selection.modelId,
        tier: selection.tier,
        taskType: selection.taskType,
        via: selection.via,
        reason: selection.reason,
        codingIndex: model.codingIndex,
        usage: turn.usage,
      });
      state = advanceRouterState(selectionState, selection);
      previousAgent = turn.sessionState.activeAgent;
      previousMessage = turn.sessionState.currentTask.lastUserMessage;
      appendBaseline(replay.strategies["always-frontier"], session.id, turn, () => selectFrontier(dataset, turn));
      appendBaseline(replay.strategies["always-cheap"], session.id, turn, () => selectCheap(dataset, turn));
    }
  }
  return replay;
}
