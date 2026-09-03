import { describe, expect, it } from "vitest";
import {
  calculateCost,
  calculateStrategyMetrics,
  compositeQuality,
  projectUsage,
  qualityRetained,
  weightedMean,
} from "../src/metrics.js";
import type { ReplayTurnResult, StrategyReplayResult } from "../src/types.js";

describe("cost metrics", () => {
  it("charges uncached input, output, cache reads, and cache writes separately", () => {
    expect(
      calculateCost(
        { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 200_000, cacheWriteInputTokens: 50_000 },
        { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 }
      )
    ).toBeCloseTo(2.665, 10);
  });

  it("converts cache reads to writes when no reusable prefix exists", () => {
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 400, cacheWriteInputTokens: 100 };
    expect(projectUsage(usage, true)).toEqual(usage);
    expect(projectUsage(usage, false)).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 500,
    });
  });

  it("counts switches and cache misses without counting the first model", () => {
    const turns: StrategyReplayResult = {
      name: "router",
      incompleteReasons: [],
      turns: [
        turn("session-1", "turn-1", "provider/cheap"),
        turn("session-1", "turn-2", "provider/cheap"),
        turn("session-1", "turn-3", "provider/frontier"),
        turn("session-2", "turn-1", "provider/frontier"),
      ],
    };
    const prices = {
      "provider/cheap": { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 },
      "provider/frontier": { inputPerMillion: 10, outputPerMillion: 30, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5 },
    };

    const metrics = calculateStrategyMetrics(turns, prices);

    expect(metrics.switchCount).toBe(1);
    expect(metrics.cacheReadTokens).toBe(400);
    expect(metrics.cacheMissTokens).toBe(1200);
    expect(metrics.totalCostUsd).not.toBeNull();
    expect(metrics.isEstimated).toBe(true);
  });

  it("reports missing model prices as incomplete instead of free", () => {
    const result: StrategyReplayResult = { name: "router", incompleteReasons: [], turns: [turn("session-1", "turn-1", "missing")] };
    const metrics = calculateStrategyMetrics(result, {});
    expect(metrics.totalCostUsd).toBeNull();
    expect(metrics.incompleteReasons).toEqual(["missing price for model missing"]);
  });

  it("uses replay weights and excludes incomplete turns from quality", () => {
    const weighted: StrategyReplayResult = {
      name: "router",
      incompleteReasons: [],
      turns: [
        turn("session-1", "turn-1", "provider/cheap", { codingIndex: 100, weight: 1 }),
        turn("session-1", "turn-2", "provider/cheap", { codingIndex: 0, weight: 3 }),
      ],
    };
    const prices = {
      "provider/cheap": { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 },
    };
    expect(calculateStrategyMetrics(weighted, prices).qualityProxy).toBe(0.25);

    const incomplete: StrategyReplayResult = {
      ...weighted,
      turns: [turn("session-1", "turn-1", "provider/cheap", { terminalState: "failed" })],
    };
    const metrics = calculateStrategyMetrics(incomplete, prices);
    expect(metrics.qualityProxy).toBeNull();
    expect(metrics.totalCostUsd).toBeNull();
    expect(metrics.incompleteReasons).toContain("recorded turn session-1/turn-1 has terminal state failed");
  });
});

describe("quality metrics", () => {
  it("combines deterministic and judge scores with approved weights", () => {
    expect(compositeQuality(1, 0.5)).toBeCloseTo(0.9);
    expect(compositeQuality(null, 0.5)).toBe(0.5);
  });

  it("calculates weighted means and retained quality", () => {
    expect(weightedMean([{ score: 1, weight: 3 }, { score: 0, weight: 1 }])).toBe(0.75);
    expect(weightedMean([])).toBeNull();
    expect(qualityRetained(0.95, 1)).toBe(0.95);
    expect(qualityRetained(1.1, 1)).toBe(1.1);
    expect(qualityRetained(0.5, 0)).toBeNull();
  });
});

function turn(sessionId: string, turnId: string, modelId: string, overrides: Partial<ReplayTurnResult> = {}): ReplayTurnResult {
  return {
    sessionId,
    turnId,
    modelId,
    tier: "simple" as const,
    taskType: null,
    via: "value" as const,
    reason: "fixture",
    codingIndex: 70,
    weight: 1,
    terminalState: "completed",
    contentTruncated: false,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 400, cacheWriteInputTokens: 0 },
    ...overrides,
  };
}
