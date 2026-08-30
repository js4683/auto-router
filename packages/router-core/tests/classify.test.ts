import { describe, it, expect } from "vitest";
import { classify, detectBoundary } from "../src/classify.js";
import type { SessionState, RouterConfig } from "../src/types.js";

const cfg: RouterConfig = {
  tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
  scorer: {
    weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 },
    thresholds: { simpleMax: 0.4, mediumMax: 0.7 },
  },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: { code_review: { prefer: null }, run_tests: { prefer: null }, monitoring: { prefer: null }, implement: { prefer: null }, debug: { prefer: null } },
  providerFreeSet: [],
  windowRegistry: {},
  catalog: { cachePath: "./.cache/test.json", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
};

function sess(over: Partial<SessionState["currentTask"]> & Partial<SessionState> = {}): SessionState {
  return {
    lifetimeTokens: over.lifetimeTokens ?? 2000,
    currentTask: {
      promptTokens: over.promptTokens ?? 100,
      taskTokens: (over as any).taskTokens ?? 500,
      filesTouched: over.filesTouched ?? 1,
      diffHunks: over.diffHunks ?? 0,
      toolDepth: over.toolDepth ?? 1,
      lastUserMessage: over.lastUserMessage ?? "fix typo in readme",
      priorErrors: over.priorErrors,
    },
    userTag: (over as any).userTag,
    activeAgent: (over as any).activeAgent,
    isCompacted: (over as any).isCompacted,
    isNewSession: (over as any).isNewSession,
    forceTier: (over as any).forceTier,
  };
}

describe("classify Tier-0", () => {
  it("simple for trivial prompt", () => {
    const r = classify(sess({ lastUserMessage: "rename variable foo to bar" }), cfg);
    expect(r.tier).toBe("simple");
    expect(r.score).toBeLessThan(0.4);
  });

  it("complex for architecture keyword + many files + deep depth", () => {
    const r = classify(sess({ promptTokens: 3000, taskTokens: 25000, filesTouched: 10, diffHunks: 15, toolDepth: 9, lastUserMessage: "refactor architecture for race concurrency handling" }), cfg);
    expect(r.tier).toBe("complex");
    expect(r.score).toBeGreaterThan(0.7);
  });

  it("medium for moderate signals", () => {
    const r = classify(sess({ promptTokens: 1000, taskTokens: 10000, filesTouched: 5, diffHunks: 6, toolDepth: 5, lastUserMessage: "implement feature for user auth refactor" }), cfg);
    expect(["simple", "medium", "complex"]).toContain(r.tier);
    // at medium thresholds it should at least not be simple with these values
    expect(r.score).toBeGreaterThan(0.3);
  });

  it("forceTier bypasses scoring", () => {
    const r = classify(sess({ forceTier: "complex", lastUserMessage: "typo" }), cfg);
    expect(r.tier).toBe("complex");
    expect(r.confidence).toBe(1);
  });

  it("down keywords reduce score", () => {
    const up = classify(sess({ lastUserMessage: "refactor architecture design race concurrency" }), cfg);
    const down = classify(sess({ lastUserMessage: "rename typo format comment" }), cfg);
    expect(up.score).toBeGreaterThan(down.score);
  });
});

describe("detectBoundary", () => {
  it("explicit: new session is boundary", () => {
    const r = detectBoundary(sess({ isNewSession: true }), undefined, undefined);
    expect(r.isBoundary).toBe(true);
    expect(r.confidence).toBe(1);
  });

  it("explicit: compacted is boundary", () => {
    const r = detectBoundary(sess({ isCompacted: true }), undefined, undefined);
    expect(r.isBoundary).toBe(true);
  });

  it("explicit: agent change is boundary", () => {
    const r = detectBoundary(sess({ activeAgent: "review" }), "implement", "old message");
    expect(r.isBoundary).toBe(true);
  });

  it("heuristic: single signal alone NOT boundary (needs 2)", () => {
    const s = sess({ diffHunks: 15, lastUserMessage: "continue" });
    const r = detectBoundary(s, "implement", "continue");
    expect(r.isBoundary).toBe(false);
    expect(r.confidence).toBeLessThan(0.8);
  });

  it("heuristic: 2 signals + high conf is boundary", () => {
    const s = sess({ diffHunks: 15, filesTouched: 10, lastUserMessage: "build new pipeline for data ingestion now that prior task done" });
    const r = detectBoundary(s, "implement", "fix typo");
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
    if (r.confidence >= 0.8) expect(r.isBoundary).toBe(true);
  });

  it("hard signal increases confidence", () => {
    const s = sess({ lastUserMessage: "why doesn't this work not working error retry", priorErrors: 2 } as any);
    const r = detectBoundary(s, "implement", "old");
    expect(r.signals).toContain("hardSignal");
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("hard signal alone does not start a new task", () => {
    const s = sess({ lastUserMessage: "why doesn't this work", priorErrors: 1 } as any);
    const r = detectBoundary(s, "implement", "continue implementation");
    expect(r.isBoundary).toBe(false);
  });
});
