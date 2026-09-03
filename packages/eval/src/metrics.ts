import type {
  ConfidenceInterval,
  EvalPrice,
  EvalUsage,
  QualityCaseScore,
  QualityGateResult,
  StrategyMetrics,
  StrategyReplayResult,
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

export function bootstrapRetentionInterval(cases: QualityCaseScore[], seed: string, samples = 10_000): ConfidenceInterval {
  if (!cases.length) throw new Error("bootstrap requires quality cases");
  if (!Number.isInteger(samples) || samples <= 0) throw new Error("bootstrap samples must be a positive integer");
  const random = seededRandom(seed);
  const retained: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const selected = Array.from({ length: cases.length }, () => cases[Math.floor(random() * cases.length)]);
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
