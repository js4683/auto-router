import type {
  ConfidenceInterval,
  EvalPrice,
  EvalUsage,
  GroupedQualityCaseScore,
  QualityCaseScore,
  QualityGateResult,
  StrategyMetrics,
  StrategyReplayResult,
  VersionedQualityGate,
  VersionedQualityInput,
} from "./types.js";

export function calculateCost(usage: EvalUsage, price: EvalPrice): number {
  const uncachedInputTokens = usage.inputTokens - usage.cacheReadInputTokens - usage.cacheWriteInputTokens;
  if (uncachedInputTokens < 0) throw new Error("cache token total must not exceed inputTokens");
  return (
    uncachedInputTokens * price.inputPerMillion +
    usage.outputTokens * price.outputPerMillion +
    usage.cacheReadInputTokens * price.cacheReadPerMillion +
    usage.cacheWriteInputTokens * price.cacheWritePerMillion
  ) / 1_000_000;
}

export function projectUsage(usage: EvalUsage, hasReusablePrefix: boolean): EvalUsage {
  if (hasReusablePrefix) return { ...usage };
  return {
    ...usage,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens + usage.cacheReadInputTokens,
  };
}

export function calculateStrategyMetrics(result: StrategyReplayResult, prices: Record<string, EvalPrice>): StrategyMetrics {
  let totalCostUsd = 0;
  let switchCount = 0;
  let cacheReadTokens = 0;
  let cacheMissTokens = 0;
  let previousSession: string | undefined;
  let previousModel: string | undefined;
  const incompleteReasons = [...result.incompleteReasons];

  for (const turn of result.turns) {
    if (turn.terminalState !== "completed") {
      const reason = `recorded turn ${turn.sessionId}/${turn.turnId} has terminal state ${turn.terminalState}`;
      if (!incompleteReasons.includes(reason)) incompleteReasons.push(reason);
    }
    if (turn.contentTruncated) {
      const reason = `recorded turn ${turn.sessionId}/${turn.turnId} has truncated content`;
      if (!incompleteReasons.includes(reason)) incompleteReasons.push(reason);
    }
    const sameSession = previousSession === turn.sessionId;
    const hasReusablePrefix = sameSession && previousModel === turn.modelId;
    if (sameSession && previousModel !== turn.modelId) switchCount += 1;
    if (!hasReusablePrefix) cacheMissTokens += turn.usage.cacheReadInputTokens;
    const projected = projectUsage(turn.usage, hasReusablePrefix);
    cacheReadTokens += projected.cacheReadInputTokens;
    const price = prices[turn.modelId];
    if (price) totalCostUsd += calculateCost(projected, price);
    else incompleteReasons.push(`missing price for model ${turn.modelId}`);
    previousSession = turn.sessionId;
    previousModel = turn.modelId;
  }

  const hasIncompleteTurn = result.turns.some((turn) => turn.terminalState !== "completed" || turn.contentTruncated);

  return {
    isEstimated: true,
    totalCostUsd: incompleteReasons.length ? null : totalCostUsd,
    switchCount,
    cacheReadTokens,
    cacheMissTokens,
    qualityProxy: hasIncompleteTurn
      ? null
      : rounded(weightedMean(result.turns.map((turn) => ({ score: turn.codingIndex / 100, weight: turn.weight })))),
    incompleteReasons,
  };
}

export function compositeQuality(deterministic: number | null, judge: number): number {
  return deterministic === null ? judge : Number((0.8 * deterministic + 0.2 * judge).toFixed(12));
}

export function weightedMean(values: Array<{ score: number; weight: number }>): number | null {
  const totalWeight = values.reduce((total, value) => total + value.weight, 0);
  if (totalWeight === 0) return null;
  return values.reduce((total, value) => total + value.score * value.weight, 0) / totalWeight;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(12));
}

export function qualityRetained(routerQuality: number, frontierQuality: number): number | null {
  if (frontierQuality === 0) return null;
  return routerQuality / frontierQuality;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function caseRetention(cases: QualityCaseScore[]): number | null {
  const router = weightedMean(cases.map((item) => ({ score: item.routerScore, weight: item.weight })));
  const frontier = weightedMean(cases.map((item) => ({ score: item.frontierScore, weight: item.weight })));
  if (router === null || frontier === null) return null;
  return qualityRetained(router, frontier);
}

function groupQualityCases(cases: QualityCaseScore[]): QualityCaseScore[] {
  const groups = new Map<string, QualityCaseScore[]>();
  for (const [index, item] of cases.entries()) {
    const group = groups.get(item.groupId ?? `case-${index}`) ?? [];
    group.push(item);
    groups.set(item.groupId ?? `case-${index}`, group);
  }
  return [...groups.values()].flatMap((group) => {
    const routerScore = weightedMean(group.map((item) => ({ score: item.routerScore, weight: item.weight })));
    const frontierScore = weightedMean(group.map((item) => ({ score: item.frontierScore, weight: item.weight })));
    if (routerScore === null || frontierScore === null) return [];
    return [{ routerScore, frontierScore, weight: group.reduce((total, item) => total + item.weight, 0) }];
  });
}

export function bootstrapRetentionInterval(cases: QualityCaseScore[], seed: string, samples = 10_000): ConfidenceInterval {
  if (!cases.length) throw new Error("bootstrap requires quality cases");
  if (!Number.isInteger(samples) || samples <= 0) throw new Error("bootstrap samples must be a positive integer");
  const groups = groupQualityCases(cases);
  if (!groups.length) throw new Error("bootstrap has no valid quality groups");
  const random = seededRandom(seed);
  const retained: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const selected = Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]);
    const value = caseRetention(selected);
    if (value !== null) retained.push(value);
  }
  if (!retained.length) throw new Error("bootstrap has no valid frontier quality");
  retained.sort((a, b) => a - b);
  return {
    lower: retained[Math.floor((retained.length - 1) * 0.025)],
    upper: retained[Math.floor((retained.length - 1) * 0.975)],
    samples,
    seed,
  };
}

function groupCount(cases: GroupedQualityCaseScore[]): number {
  return new Set(cases.map((item) => item.groupId)).size;
}

function validateVersionedInput(input: VersionedQualityInput): string | undefined {
  const overallGroups = new Set(input.overall.map((item) => item.groupId));
  const assigned = new Map<string, string>();
  for (const [cohort, cases] of Object.entries(input.cohorts)) {
    for (const item of cases) {
      if (item.cohort !== cohort) return `group ${item.groupId} cohort field does not match ${cohort}`;
      const previous = assigned.get(item.groupId);
      if (previous && previous !== cohort) return `group ${item.groupId} is assigned to multiple cohorts`;
      assigned.set(item.groupId, cohort);
    }
  }
  if ([...overallGroups].some((groupId) => !assigned.has(groupId))) return "overall evidence is missing cohort assignments";
  if ([...assigned.keys()].some((groupId) => !overallGroups.has(groupId))) return "cohort evidence is not present in overall evidence";
  return undefined;
}

function versionedCohortResult(cases: GroupedQualityCaseScore[], seed: string, minGroups: number, minRetention: number): VersionedQualityGate["cohortResults"][string] {
  const independentGroups = groupCount(cases);
  if (independentGroups < minGroups) {
    return { passed: false, lowerBound: null, independentGroups, reason: `requires at least ${minGroups} independent groups` };
  }
  const interval = bootstrapRetentionInterval(cases, seed);
  if (interval.lower < minRetention) {
    return { passed: false, lowerBound: interval.lower, independentGroups, reason: `quality retention lower bound is below ${minRetention}` };
  }
  return { passed: true, lowerBound: interval.lower, independentGroups, reason: "quality retention lower bound meets threshold" };
}

export function evaluateVersionedQualityGate(
  input: VersionedQualityInput,
  options: { seed?: string; minIndependentGroups?: number; minCohortGroups?: number; minRetention?: number } = {},
): VersionedQualityGate {
  const seed = options.seed ?? "auto-router-quality-v2";
  const minIndependentGroups = options.minIndependentGroups ?? 200;
  const minCohortGroups = options.minCohortGroups ?? 100;
  const minRetention = options.minRetention ?? 0.95;
  const invalidInput = validateVersionedInput(input);
  if (invalidInput) {
    return { passed: false, reason: invalidInput, lowerBound: null, independentGroups: groupCount(input.overall), cohortResults: {} };
  }
  if ((input.incompleteCases ?? 0) > 0) {
    return {
      passed: false,
      reason: `${input.incompleteCases} incomplete cases prevent activation evidence`,
      lowerBound: null,
      independentGroups: groupCount(input.overall),
      cohortResults: {},
    };
  }
  const independentGroups = groupCount(input.overall);
  if (independentGroups < minIndependentGroups) {
    return { passed: false, reason: `requires at least ${minIndependentGroups} independent groups`, lowerBound: null, independentGroups, cohortResults: {} };
  }
  const overallInterval = bootstrapRetentionInterval(input.overall, seed);
  if (overallInterval.lower < minRetention) {
    return { passed: false, reason: `overall quality retention lower bound is below ${minRetention}`, lowerBound: overallInterval.lower, independentGroups, cohortResults: {} };
  }
  const requiredCohorts = input.criticalCohorts ?? Object.keys(input.cohorts);
  const cohortResults = Object.fromEntries(requiredCohorts.map((cohort) => {
    const cases = input.cohorts[cohort];
    return [
      cohort,
      cases
        ? versionedCohortResult(cases, `${seed}:${cohort}`, minCohortGroups, minRetention)
        : { passed: false, lowerBound: null, independentGroups: 0, reason: "cohort is missing" },
    ];
  }));
  const failed = Object.entries(cohortResults).find(([, result]) => !result.passed);
  if (failed) return { passed: false, reason: `cohort ${failed[0]} failed: ${failed[1].reason}`, lowerBound: overallInterval.lower, independentGroups, cohortResults };
  return { passed: true, reason: "overall and cohort quality retention lower bounds meet threshold", lowerBound: overallInterval.lower, independentGroups, cohortResults };
}

export function evaluateQualityGate(cases: QualityCaseScore[]): QualityGateResult {
  const rawRetention = caseRetention(cases);
  const retention = rawRetention === null ? null : Number(rawRetention.toFixed(12));
  const confidenceInterval = cases.length ? bootstrapRetentionInterval(cases, "auto-router-quality-v1") : null;
  if (cases.length < 30) {
    return { passed: false, sampleSize: cases.length, retention, reason: "requires at least 30 complete live cases", confidenceInterval };
  }
  if (retention === null || retention < 0.95) {
    return { passed: false, sampleSize: cases.length, retention, reason: "quality retention is below 0.95", confidenceInterval };
  }
  return { passed: true, sampleSize: cases.length, retention, reason: "quality retention meets 0.95", confidenceInterval };
}
