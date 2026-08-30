import { describe, it, expect } from "vitest";
import { selectModel } from "../src/selector.js";
import type { Catalog, RouterConfig, RouterState, SessionState } from "../src/types.js";

const cfg: RouterConfig = {
  tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
  scorer: {
    weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 },
    thresholds: { simpleMax: 0.4, mediumMax: 0.7 },
  },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: {
    code_review: { prefer: "cheap-review" },
    run_tests: { prefer: null, strategy: "lowest-cost" },
    monitoring: { prefer: null },
    planning: { prefer: null, strategy: "quality", minQuality: 85 },
    implement: { prefer: null },
    debug: { prefer: null },
  },
  providerFreeSet: ["free-medium"],
  windowRegistry: {
    "free-medium": 128000,
    "cheap-review": 128000,
    "paid-mid": 128000,
    "frontier": 272000,
    "small-window": 12000,
  },
  catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
  agentTaskTypeMap: { review: "code_review" },
};

const catalog: Catalog = {
  fetchedAt: new Date().toISOString(),
  source: "fallback",
  models: [
    { id: "free-medium", codingIndex: 72, blendedPrice: 0.5, value: 144, windowTokens: 128000, isFree: true },
    { id: "paid-mid", codingIndex: 75, blendedPrice: 2, value: 37.5, windowTokens: 128000, isFree: false },
    { id: "cheap-review", codingIndex: 68, blendedPrice: 1, value: 68, windowTokens: 128000, isFree: false },
    { id: "frontier", codingIndex: 92, blendedPrice: 10, value: 9.2, windowTokens: 272000, isFree: false },
    { id: "small-window", codingIndex: 65, blendedPrice: 0.3, value: 216, windowTokens: 12000, isFree: true },
  ],
};

function sess(over: Partial<SessionState> & Partial<SessionState["currentTask"]> = {}): SessionState {
  return {
    lifetimeTokens: (over as any).lifetimeTokens ?? 5000,
    currentTask: {
      promptTokens: (over as any).promptTokens ?? 100,
      taskTokens: (over as any).taskTokens ?? 1000,
      filesTouched: (over as any).filesTouched ?? 1,
      diffHunks: (over as any).diffHunks ?? 0,
      toolDepth: (over as any).toolDepth ?? 1,
      lastUserMessage: (over as any).lastUserMessage ?? "implement feature",
      priorErrors: (over as any).priorErrors,
    },
    userTag: (over as any).userTag,
    activeAgent: (over as any).activeAgent,
    forceTier: (over as any).forceTier,
    isCompacted: (over as any).isCompacted,
    isNewSession: (over as any).isNewSession,
  };
}

describe("selector — two axes + guards + stickiness", () => {
  it("free-first within tier when no taskType prefer (simple -> free)", () => {
    // simple prompt should select free-small? But simple tier minQuality 0, free-medium is eligible but small-window has higher value (216) and is free.
    // However small-window is free and higher value; but it will be chosen for simple where small-window fits.
    const s = sess({ lastUserMessage: "fix typo", forceTier: "simple" });
    const state: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    const r = selectModel(s, catalog, cfg, state);
    // taskType null, so free-first within simple (minQuality 0) picks best free by value or quality
    // free models: free-medium (72) value144, small-window (65) value216 -> small-window wins on value
    expect(["small-window", "free-medium"]).toContain(r.modelId);
    expect(r.via).toMatch(/free-first|value/);
  });

  it("returns the provider-qualified runtime ID when one is available", () => {
    const liveCatalog: Catalog = {
      ...catalog,
      models: [{ ...catalog.models[0], id: "muse-spark-1.2-contributor-free", runtimeId: "opencode/muse-spark-1.2-contributor-free" }],
    };
    const r = selectModel(sess({ lastUserMessage: "fix typo", forceTier: "simple" }), liveCatalog, cfg, {
      currentModel: null,
      currentTier: null,
      downgradeCounter: 0,
    });

    expect(r.modelId).toBe("opencode/muse-spark-1.2-contributor-free");
  });

  it("taskType prefer wins if clears tier bar (code_review + medium)", () => {
    // Force medium tier but with review tag -> should prefer cheap-review (68 >=60)
    const s = sess({ lastUserMessage: "review pr", userTag: "code_review", forceTier: "medium" });
    const state: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    const r = selectModel(s, catalog, cfg, state);
    expect(r.modelId).toBe("cheap-review");
    expect(r.via).toBe("taskType-prefer");
  });

  it("taskType prefer rejected if fails quality bar -> fallback to free-first", () => {
    // cheap-review 68 < complex minQuality 80 -> rejected, should fallback to free-medium? but free-medium 72 <80 also fails, so picks frontier
    const s = sess({ lastUserMessage: "review complex architecture", userTag: "code_review", forceTier: "complex" });
    const state: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    const r = selectModel(s, catalog, cfg, state);
    expect(r.modelId).not.toBe("cheap-review");
    // for complex, only frontier (92) qualifies, so via should be free-first/value but picks frontier
    expect(r.modelId).toBe("frontier");
  });

  it("selects the lowest-cost eligible paid model for verification", () => {
    const paidCatalog: Catalog = {
      fetchedAt: new Date().toISOString(),
      source: "live",
      models: [
        { id: "paid-low-cost", codingIndex: 60, blendedPrice: 4, value: 15, windowTokens: 128000, isFree: false },
        { id: "paid-high-value", codingIndex: 90, blendedPrice: 5, value: 18, windowTokens: 128000, isFree: false },
      ],
    };

    const r = selectModel(sess({ lastUserMessage: "run no-mistakes", userTag: "run_tests", forceTier: "medium" }), paidCatalog, cfg, {
      currentModel: null,
      currentTier: null,
      downgradeCounter: 0,
    });

    expect(r.modelId).toBe("paid-low-cost");
    expect(r.via).toBe("lowest-cost");
  });

  it("selects the highest-quality model above the planning floor", () => {
    const planningCatalog: Catalog = {
      fetchedAt: new Date().toISOString(),
      source: "live",
      models: [
        { id: "free-below-floor", codingIndex: 84, blendedPrice: 0, value: 840, windowTokens: 128000, isFree: true },
        { id: "fable", codingIndex: 88, blendedPrice: 2, value: 44, windowTokens: 128000, isFree: false },
        { id: "sol", codingIndex: 92, blendedPrice: 12, value: 7.67, windowTokens: 272000, isFree: false },
      ],
    };

    const r = selectModel(sess({ lastUserMessage: "plan the architecture", userTag: "planning", forceTier: "simple" }), planningCatalog, cfg, {
      currentModel: null,
      currentTier: null,
      downgradeCounter: 0,
    });

    expect(r.modelId).toBe("sol");
    expect(r.via).toBe("quality");
  });

  it("context-fit blocks downgrade (large lifetimeTokens + small window)", () => {
    // Simulate downgrade: currentTier complex with frontier (272k), candidate simple would be free-medium (128k) but lifetime 200k won't fit even with margin
    // Highest free by quality is free-medium (72), not small-window, and 200k+8k=208k >128k fails fit -> block
    const s = sess({ lifetimeTokens: 200000, lastUserMessage: "typo", forceTier: "simple" });
    const state: RouterState = { currentModel: "frontier", currentTier: "complex", downgradeCounter: 3 };
    // Need a confident boundary to get past sticky to the context-fit check. Context-fit is checked before sticky, but we force boundary to ensure downgrade path evaluated
    const sBoundary = { ...s, isCompacted: true } as SessionState;
    const r = selectModel(sBoundary, catalog, cfg, state);
    expect(r.via).toBe("context-fit-block");
    expect(r.blockedDowngrade).toBe(true);
    expect(r.modelId).toBe("frontier"); // stayed
  });

  it("anti-thrash: no boundary + not upgrade => stay-sticky", () => {
    const s = sess({ lastUserMessage: "continue same task", forceTier: "simple" });
    const state: RouterState = { currentModel: "frontier", currentTier: "complex", downgradeCounter: 0 };
    const r = selectModel(s, catalog, cfg, state, "implement", "continue same task");
    // No boundary, simple would be downgrade but needs 3 counters and context-fit not blocked — should stay sticky
    expect(r.via).toBe("stay-sticky");
    expect(r.modelId).toBe("frontier");
  });

  it("upgradeImmediate bypasses stickiness (simple -> complex)", () => {
    const s = sess({ lastUserMessage: "refactor architecture race concurrency", forceTier: "complex" });
    const state: RouterState = { currentModel: "free-medium", currentTier: "simple", downgradeCounter: 0 };
    const r = selectModel(s, catalog, cfg, state, "implement", "typo");
    expect(r.via).not.toBe("stay-sticky");
    expect(r.modelId).toBe("frontier");
  });

  it("hard signal upgrade bypasses stickiness even without boundary", () => {
    const s = sess({ lastUserMessage: "why doesn't this work error retry", forceTier: "complex", priorErrors: 1 } as any);
    const state: RouterState = { currentModel: "free-medium", currentTier: "simple", downgradeCounter: 0 };
    const r = selectModel(s, catalog, cfg, state);
    expect(r.modelId).toBe("frontier");
  });

  it("downgradeAfter=3 gate: first 2 downgrade attempts blocked, 3rd allowed", () => {
    // We'll simulate downgrade from complex to medium. Create catalog where medium picks paid-mid/free-medium
    const s = sess({ lastUserMessage: "typo small", forceTier: "medium" });
    // Need boundary to propose downgrade
    const boundaryState: RouterState = { currentModel: "frontier", currentTier: "complex", downgradeCounter: 0 };
    // For v0, we need to set isCompacted to true to force boundary, otherwise classify may not trigger boundary
    const sBoundary = { ...s, isCompacted: true } as SessionState;
    const r1 = selectModel(sBoundary, catalog, cfg, boundaryState);
    expect(r1.via).toBe("stay-sticky");
    expect(r1.blockedDowngrade).toBe(true);
    // second attempt with counter 1
    const r2 = selectModel(sBoundary, catalog, cfg, { ...boundaryState, downgradeCounter: 1 });
    expect(r2.via).toBe("stay-sticky");
    // third with counter 2 should allow
    const r3 = selectModel(sBoundary, catalog, cfg, { ...boundaryState, downgradeCounter: 2 });
    expect(r3.via).not.toBe("stay-sticky");
    expect(["free-medium", "paid-mid", "small-window"]).toContain(r3.modelId);
  });
});
