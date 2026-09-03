import { describe, expect, it } from "vitest";
import { bootstrapRetentionInterval, evaluateQualityGate } from "../src/metrics.js";

describe("live quality confidence", () => {
  it("produces a deterministic seeded bootstrap interval", () => {
    const cases = [
      { routerScore: 0.8, frontierScore: 1, weight: 1 },
      { routerScore: 1, frontierScore: 0.9, weight: 2 },
      { routerScore: 0.7, frontierScore: 0.8, weight: 1 },
    ];
    const first = bootstrapRetentionInterval(cases, "fixture-seed", 1000);
    const second = bootstrapRetentionInterval(cases, "fixture-seed", 1000);

    expect(first).toEqual(second);
    expect(first.lower).toBeLessThanOrEqual(first.upper);
    expect(first.samples).toBe(1000);
  });

  it("requires 30 complete cases and 95 percent point retention", () => {
    const passingCases = Array.from({ length: 30 }, () => ({ routerScore: 0.95, frontierScore: 1, weight: 1 }));
    const tooFewCases = passingCases.slice(0, 29);

    expect(evaluateQualityGate(passingCases)).toMatchObject({ passed: true, sampleSize: 30, retention: 0.95 });
    expect(evaluateQualityGate(tooFewCases)).toMatchObject({ passed: false, sampleSize: 29, reason: "requires at least 30 complete live cases" });
    expect(evaluateQualityGate(passingCases.map((item) => ({ ...item, routerScore: 0.94 })))).toMatchObject({
      passed: false,
      retention: 0.94,
      reason: "quality retention is below 0.95",
    });
  });
});
