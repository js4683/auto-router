import type { ModelEntry } from "@auto-router/router-core";
import type { EvalDatasetV1, EvalTurnV1 } from "./types.js";

export function modelRuntimeId(model: ModelEntry): string {
  return model.runtimeId ?? model.id;
}

export function eligibleModels(dataset: EvalDatasetV1, turn: EvalTurnV1): ModelEntry[] {
  const required = turn.requiredCapabilities ?? [];
  const margin = dataset.config.guards.contextFitMarginTokens;
  return dataset.catalog.models.filter((model) => {
    if (turn.sessionState.lifetimeTokens + margin > model.windowTokens) return false;
    const capabilities = dataset.capabilities?.[modelRuntimeId(model)] ?? dataset.capabilities?.[model.id] ?? [];
    return required.every((capability) => capabilities.includes(capability));
  });
}

function requireEligible(dataset: EvalDatasetV1, turn: EvalTurnV1): ModelEntry[] {
  const eligible = eligibleModels(dataset, turn);
  if (!eligible.length) throw new Error(`no eligible model for turn ${turn.id}`);
  return eligible;
}

export function selectFrontier(dataset: EvalDatasetV1, turn: EvalTurnV1): ModelEntry {
  return [...requireEligible(dataset, turn)].sort(
    (a, b) => b.codingIndex - a.codingIndex || b.value - a.value || modelRuntimeId(a).localeCompare(modelRuntimeId(b))
  )[0];
}

export function selectCheap(dataset: EvalDatasetV1, turn: EvalTurnV1): ModelEntry {
  return [...requireEligible(dataset, turn)].sort(
    (a, b) => a.blendedPrice - b.blendedPrice || b.codingIndex - a.codingIndex || modelRuntimeId(a).localeCompare(modelRuntimeId(b))
  )[0];
}
