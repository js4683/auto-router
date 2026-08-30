import type { Catalog, ModelEntry, RouterConfig, RouterState, SessionState, SelectionResult, TaskStrategy, Tier } from "./types.js";
import { classify, detectBoundary, tierRank } from "./classify.js";
import { passesContextFit, isUpgrade } from "./guards.js";
import { resolveTaskType } from "./task-type.js";
import { resolveMappedModels } from "./model-map.js";

function bestModelForTier(catalog: Catalog, minQuality: number, strategy: TaskStrategy): ModelEntry | null {
  const eligible = catalog.models.filter((m) => m.codingIndex >= minQuality);
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

/**
 * Two-axis selectModel (grill Q8):
 *  1. resolve task type (explicit / gated auto)
 *  2. candidate = taskTypeModels[type].prefer if set and clears tier's minQuality
 *  3. else free-first within tier, then best value
 *  4. apply guards: context-fit, then stickiness/downgrade counter, then commit (or keep current)
 */
export function selectModel(
  session: SessionState,
  catalog: Catalog,
  config: RouterConfig,
  state: RouterState,
  prevAgent?: string,
  prevMessage?: string,
  avengers?: { paperIds: string[] }
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
    if (preferred && preferred.codingIndex >= minQuality) {
      candidate = preferred;
      via = "taskType-prefer";
      reason = `taskType ${taskType} prefer ${preferredId} clears tier ${cls.tier} (quality ${preferred.codingIndex} >= ${minQuality})`;
    } else if (preferred) {
      reason = `taskType prefer ${preferredId} rejected: quality ${preferred.codingIndex} < ${minQuality} for tier ${cls.tier}`;
    }
  }

  if (!candidate && avengers?.paperIds?.length && config.modelMap) {
    const mapped = resolveMappedModels(avengers.paperIds, config.modelMap, catalog)
      .map((entry) => catalog.models.find((m) => (m.runtimeId ?? m.id) === entry.runtimeId || m.id === entry.runtimeId))
      .filter((m): m is ModelEntry => !!m && m.codingIndex >= minQuality);
    if (strategy === "lowest-cost") {
      const free = mapped.filter((m) => m.isFree);
      candidate = (free[0] ?? [...mapped].sort((a, b) => a.blendedPrice - b.blendedPrice)[0]) ?? null;
    } else if (strategy === "quality") {
      candidate = [...mapped].sort((a, b) => b.codingIndex - a.codingIndex)[0] ?? null;
    } else {
      candidate = mapped[0] ?? null;
    }
    if (candidate) {
      via = strategy === "value" || !taskPolicy?.strategy ? "avengers-pro" : candidate.isFree && strategy !== "quality" ? "free-first" : strategy;
      reason = `avengers-pro mapped ${candidate.id}`;
    }
  }

  // Step 3: tier-default (free-first)
  if (!candidate) {
    // If taskType but no prefer, reason already set; keep
    candidate = bestModelForTier(catalog, minQuality, strategy);
    if (candidate) {
      via = candidate.isFree && strategy !== "quality" ? "free-first" : strategy;
      reason = reason ? `${reason}; fallback ${via} ${candidate.id} (value ${candidate.value.toFixed(2)})` : `${via} ${candidate.id} for tier ${cls.tier}`;
    }
  }

  // Fallback if nothing eligible (e.g., minQuality too high)
  if (!candidate) {
    // pick highest quality available
    candidate = catalog.models.sort((a, b) => b.codingIndex - a.codingIndex)[0] ?? null;
    via = "fallback";
    reason = `no model clears minQuality ${minQuality}, fallback to highest quality ${candidate?.id}`;
  }

  if (!candidate) {
    throw new Error("catalog empty — no models available");
  }

  // Step 4: guards
  // Context-fit: refuse downgrade if session won't fit target window + margin
  // candidate derived from cls.tier, so downgrade = cls.tier < state.currentTier
  const wouldDowngradeTier = state.currentTier ? tierRank(cls.tier) < tierRank(state.currentTier) : false;

  // If wouldDowngrade, check context fit for the candidate target
  if (wouldDowngradeTier) {
    const fit = passesContextFit(session.lifetimeTokens, candidate, config);
    if (!fit.pass) {
      // block downgrade — stay on current model
      return {
        modelId: state.currentModel ?? modelRuntimeId(candidate),
        tier: cls.tier,
        taskType,
        confidence: cls.confidence,
        reason: `context-fit block: ${fit.reason}; staying on ${state.currentModel ?? candidate.id}`,
        via: "context-fit-block",
        blockedDowngrade: true,
        catalogSource: catalog.source,
        score: cls.score,
        boundary,
      };
    }
  }

  // Stickiness: hold model within task until confident boundary or upgrade
  // Downgrade needs downgradeAfter confident boundaries; upgrade bypasses.
  const upgrade = state.currentTier ? isUpgrade(state.currentTier, cls.tier) : false;
  const hardUpgradeSignal = (session.currentTask.priorErrors ?? 0) > 0 || /why doesn't|not working|error.*retry/i.test(session.currentTask.lastUserMessage);

  if (state.currentModel && !boundary.isBoundary && !upgrade && !hardUpgradeSignal) {
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
