import { checkModelEligibility, filterEligibleModels, SelectionConstraintError } from "./eligibility.js";
import type { AvengersProPrediction, Catalog, ModelEntry, ModelMap, RouterConfig, RouterState, SelectionRequirements, SessionState, SelectionResult, TaskStrategy, Tier } from "./types.js";
import { classify, detectBoundary, tierRank } from "./classify.js";
import { passesContextFit, isUpgrade } from "./guards.js";
import { resolveTaskType } from "./task-type.js";
import { resolveMappedModels } from "./model-map.js";

function fitsContext(session: SessionState, model: ModelEntry, config: RouterConfig): boolean {
  return passesContextFit(session.lifetimeTokens, model, config).pass;
}

function bestModelForTier(catalog: Catalog, minQuality: number, strategy: TaskStrategy, session: SessionState, config: RouterConfig): ModelEntry | null {
  const eligible = catalog.models.filter((m) => m.codingIndex >= minQuality && fitsContext(session, m, config));
  if (!eligible.length) return null;

  if (strategy !== "quality") {
    const freeEligible = eligible.filter((m) => m.isFree);
    if (freeEligible.length) {
      return freeEligible.sort((a, b) => b.codingIndex - a.codingIndex || b.value - a.value)[0];
    }
  }

  if (strategy === "lowest-cost") {
    return eligible.sort((a, b) => a.blendedPrice - b.blendedPrice || b.codingIndex - a.codingIndex)[0];
  }
  if (strategy === "quality") {
    return eligible.sort((a, b) => b.codingIndex - a.codingIndex || b.value - a.value)[0];
  }
  return eligible.sort((a, b) => b.value - a.value || b.codingIndex - a.codingIndex)[0];
}

function modelRuntimeId(model: ModelEntry): string {
  return model.runtimeId ?? model.id;
}

interface LearnedCandidate {
  model: ModelEntry;
  predictedQuality: number;
}

function runtimeIdCompare(a: LearnedCandidate, b: LearnedCandidate): number {
  const aId = modelRuntimeId(a.model);
  const bId = modelRuntimeId(b.model);
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

function learnedCandidates(
  prediction: AvengersProPrediction,
  modelMap: ModelMap,
  catalog: Catalog,
  minQuality: number,
  session: SessionState,
  config: RouterConfig,
): LearnedCandidate[] {
  const candidates: LearnedCandidate[] = [];
  for (const entry of resolveMappedModels(prediction.paperIds, modelMap, catalog)) {
    const model = catalog.models.find((item) => modelRuntimeId(item) === entry.runtimeId || item.id === entry.runtimeId);
    const predictedQuality = prediction.predictedQuality[entry.paperId];
    if (!model || !(model.codingIndex >= minQuality) || !Number.isFinite(predictedQuality) || !fitsContext(session, model, config)) continue;
    candidates.push({ model, predictedQuality });
  }
  return candidates;
}

function bestLearnedModel(candidates: LearnedCandidate[], strategy: TaskStrategy): ModelEntry | null {
  if (strategy === "quality") {
    return [...candidates].sort(
      (a, b) => b.predictedQuality - a.predictedQuality || b.model.codingIndex - a.model.codingIndex || runtimeIdCompare(a, b)
    )[0]?.model ?? null;
  }
  if (strategy === "lowest-cost") {
    return [...candidates].sort(
      (a, b) => a.model.blendedPrice - b.model.blendedPrice || b.predictedQuality - a.predictedQuality || runtimeIdCompare(a, b)
    )[0]?.model ?? null;
  }

  const freeCandidates = candidates.filter((candidate) => candidate.model.isFree);
  if (freeCandidates.length) {
    return freeCandidates.sort((a, b) => b.predictedQuality - a.predictedQuality || runtimeIdCompare(a, b))[0].model;
  }
  const paidCandidates = candidates.filter(
    (candidate) => Number.isFinite(candidate.model.blendedPrice) && candidate.model.blendedPrice > 0
  );
  return paidCandidates.sort(
    (a, b) =>
      b.predictedQuality / b.model.blendedPrice - a.predictedQuality / a.model.blendedPrice ||
      b.predictedQuality - a.predictedQuality ||
      runtimeIdCompare(a, b)
  )[0]?.model ?? null;
}

function selectionRequirements(session: SessionState): SelectionRequirements | undefined {
  if (!session.requiredCapabilities && !session.transport) return undefined;
  return {
    lifetimeTokens: session.lifetimeTokens,
    requiredCapabilities: session.requiredCapabilities ?? ["text"],
    transport: session.transport ?? "chat",
  };
}

function noEligibleModelError(catalog: Catalog, requirements: SelectionRequirements, config: RouterConfig): Error {
  const firstFailure = catalog.models
    .map((model) => checkModelEligibility(model, requirements, config))
    .find((result) => !result.pass);
  const detail = firstFailure && !firstFailure.pass ? `${firstFailure.code}: ${firstFailure.reason}` : "catalog is empty";
  return new Error(`no eligible model (${detail})`);
}

/**
 * Apply the shared hard-eligibility contract before the ranking/stickiness
 * transition. Callers without request requirements retain the legacy API.
 */
export function selectModel(
  session: SessionState,
  catalog: Catalog,
  config: RouterConfig,
  state: RouterState,
  prevAgent?: string,
  prevMessage?: string,
  avengers?: AvengersProPrediction,
  requirements?: SelectionRequirements,
): SelectionResult {
  const effectiveRequirements = requirements ?? selectionRequirements(session);
  if (!effectiveRequirements) return selectFromEligibleCatalog(session, catalog, config, state, prevAgent, prevMessage, avengers);

  const eligible = filterEligibleModels(catalog, effectiveRequirements, config);
  if (!eligible.length) throw noEligibleModelError(catalog, effectiveRequirements, config);

  const boundary = detectBoundary(session, prevAgent, prevMessage);
  if (state.currentModel && !boundary.isBoundary) {
    const current = catalog.models.find((model) => model.id === state.currentModel || modelRuntimeId(model) === state.currentModel);
    if (!current) throw new Error(`sticky model ${state.currentModel} is unavailable`);
    const eligibility = checkModelEligibility(current, effectiveRequirements, config);
    if (!eligibility.pass) throw new SelectionConstraintError(eligibility.code, eligibility.reason);
  }

  return selectFromEligibleCatalog(
    session,
    { ...catalog, models: eligible },
    config,
    state,
    prevAgent,
    prevMessage,
    avengers,
  );
}

function selectFromEligibleCatalog(
  session: SessionState,
  catalog: Catalog,
  config: RouterConfig,
  state: RouterState,
  prevAgent?: string,
  prevMessage?: string,
  avengers?: AvengersProPrediction,
): SelectionResult {
  const cls = classify(session, config);
  const boundary = detectBoundary(session, prevAgent, prevMessage);
  const taskTypeRes = resolveTaskType(session, config);

  const taskType = taskTypeRes.type;
  const taskPolicy = taskType ? config.taskTypeModels[taskType] : undefined;
  const minQuality = Math.max(config.tiers[cls.tier].minQuality, taskPolicy?.minQuality ?? 0);
  const strategy = taskPolicy?.strategy ?? "value";

  // Step 2: task-type prefer candidate
  let candidate: ModelEntry | null = null;
  let via: SelectionResult["via"] = "value";
  let reason = "";

  if (taskType && config.taskTypeModels[taskType]?.prefer) {
    const preferredId = config.taskTypeModels[taskType]!.prefer!;
    const preferred = catalog.models.find((m) => m.id === preferredId || m.runtimeId === preferredId);
    if (preferred && preferred.codingIndex >= minQuality && fitsContext(session, preferred, config)) {
      candidate = preferred;
      via = "taskType-prefer";
      reason = `taskType ${taskType} prefer ${preferredId} clears tier ${cls.tier} (quality ${preferred.codingIndex} >= ${minQuality})`;
    } else if (preferred) {
      reason = `taskType prefer ${preferredId} rejected: quality ${preferred.codingIndex} < ${minQuality} for tier ${cls.tier}`;
    }
  }

  if (!candidate && avengers?.paperIds?.length && config.modelMap) {
    candidate = bestLearnedModel(learnedCandidates(avengers, config.modelMap, catalog, minQuality, session, config), strategy);
    if (candidate) {
      via = strategy === "value" || !taskPolicy?.strategy ? "avengers-pro" : candidate.isFree && strategy !== "quality" ? "free-first" : strategy;
      reason = `avengers-pro mapped ${candidate.id}`;
    }
  }

  // Step 3: tier-default (free-first)
  if (!candidate) {
    // If taskType but no prefer, reason already set; keep
    candidate = bestModelForTier(catalog, minQuality, strategy, session, config);
    if (candidate) {
      via = candidate.isFree && strategy !== "quality" ? "free-first" : strategy;
      reason = reason ? `${reason}; fallback ${via} ${candidate.id} (value ${candidate.value.toFixed(2)})` : `${via} ${candidate.id} for tier ${cls.tier}`;
    }
  }

  // Fallback if nothing eligible (e.g., minQuality too high)
  if (!candidate) {
    const fitting = catalog.models.filter((model) => fitsContext(session, model, config));
    candidate = [...fitting].sort((a, b) => b.codingIndex - a.codingIndex)[0] ?? null;
    via = "fallback";
    reason = `no model clears minQuality ${minQuality}, fallback to highest quality ${candidate?.id}`;
  }

  if (!candidate) {
    throw new Error("catalog empty — no models available");
  }

  // Step 4: guards
  const wouldDowngradeTier = state.currentTier ? tierRank(cls.tier) < tierRank(state.currentTier) : false;

  // Stickiness: hold model within task until confident boundary or upgrade
  // Downgrade needs downgradeAfter confident boundaries; upgrade bypasses.
  const upgrade = state.currentTier ? isUpgrade(state.currentTier, cls.tier) : false;
  const hardUpgradeSignal = (session.currentTask.priorErrors ?? 0) > 0 || /why doesn't|not working|error.*retry/i.test(session.currentTask.lastUserMessage);

  const current = state.currentModel
    ? catalog.models.find((model) => model.id === state.currentModel || modelRuntimeId(model) === state.currentModel)
    : undefined;
  if (state.currentModel && !boundary.isBoundary && !upgrade && !hardUpgradeSignal && (!current || fitsContext(session, current, config))) {
    // Not a boundary, not upgrade, not hard signal -> stay sticky
    return {
      modelId: state.currentModel,
      tier: cls.tier,
      taskType,
      confidence: cls.confidence,
      reason: `sticky hold ${state.currentModel}: no confident boundary (conf ${boundary.confidence.toFixed(2)}), not upgrade`,
      via: "stay-sticky",
      catalogSource: catalog.source,
      score: cls.score,
      boundary,
    };
  }

  if (wouldDowngradeTier && !upgrade) {
    // Downgrade gate: needs counter
    if (state.downgradeCounter + 1 < config.stickiness.downgradeAfter) {
      // Not enough consecutive downgrade boundaries — hold
      return {
        modelId: state.currentModel ?? modelRuntimeId(candidate),
        tier: cls.tier,
        taskType,
        confidence: cls.confidence,
        reason: `downgrade gated ${state.downgradeCounter + 1}/${config.stickiness.downgradeAfter}: would downgrade ${state.currentTier} -> ${cls.tier} but need more boundaries`,
        via: "stay-sticky",
        blockedDowngrade: true,
        catalogSource: catalog.source,
        score: cls.score,
        boundary,
      };
    }
    // else allow downgrade — counter will reset to 0 in caller
  }

  // Upgrade immediate bypasses stickiness
  if (upgrade && config.stickiness.upgradeImmediate) {
    reason += " [upgrade immediate bypass]";
  }
  if (hardUpgradeSignal) {
    reason += " [hard-signal upgrade bypass]";
  }

  // Commit candidate
  return {
    modelId: modelRuntimeId(candidate),
    tier: cls.tier,
    taskType,
    confidence: cls.confidence,
    reason: reason || `selected ${candidate.id}`,
    via,
    catalogSource: catalog.source,
    score: cls.score,
    boundary,
  };
}
