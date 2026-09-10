import { describe, expect, it } from "vitest";
import { bootstrapRetentionInterval, evaluateQualityGate, evaluateVersionedQualityGate } from "../src/metrics.js";
import type { GroupedQualityCaseScore, VersionedQualityInput } from "../src/types.js";

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

  it("fails closed when a declared critical cohort is missing", () => {
    const input = {
      overall: groups("public"),
      cohorts: { public: groups("public") },
      criticalCohorts: ["public", "consented-production"],
    } as VersionedQualityInput & { criticalCohorts: string[] };

    const result = evaluateVersionedQualityGate(input, {
      minIndependentGroups: 2,
      minCohortGroups: 2,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/consented-production.*missing/i);
  });

  it("fails closed when incomplete cases are excluded from the evidence", () => {
    const result = evaluateVersionedQualityGate({
      overall: groups("public"),
      cohorts: { public: groups("public") },
      incompleteCases: 1,
    }, {
      minIndependentGroups: 2,
      minCohortGroups: 2,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/incomplete/i);
  });

  it("does not allow aggregate-only evidence to pass the versioned gate", () => {
    const result = evaluateVersionedQualityGate({ overall: groups("public"), cohorts: {} }, {
      minIndependentGroups: 2,
      minCohortGroups: 2,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/cohort/i);
  });

  it("rejects a session group assigned to multiple cohorts", () => {
    const duplicated = groups("public")[0];
    const result = evaluateVersionedQualityGate({
      overall: groups("public"),
      cohorts: {
        public: [duplicated],
        "consented-production": [{ ...duplicated, cohort: "consented-production" }],
      },
      criticalCohorts: ["public", "consented-production"],
    }, {
      minIndependentGroups: 2,
      minCohortGroups: 1,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/multiple cohorts/i);
  });
});

function groups(cohort: string): GroupedQualityCaseScore[] {
  return ["group-1", "group-2"].map((groupId) => ({
    groupId,
    cohort,
    routerScore: 1,
    frontierScore: 1,
    weight: 1,
  }));
}
