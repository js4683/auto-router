import { describe, it, expect } from "vitest";
import { selectModel } from "../src/selector.js";
import type { AvengersProPrediction, Catalog, RouterConfig, RouterState, SessionState, TaskStrategy } from "../src/types.js";

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

const learnedCatalog: Catalog = {
  fetchedAt: new Date().toISOString(),
  source: "live",
  models: [
    { id: "frontier", runtimeId: "provider/frontier", codingIndex: 92, blendedPrice: 10, value: 9.2, windowTokens: 272000, isFree: false },
    { id: "cheap", runtimeId: "provider/cheap", codingIndex: 88, blendedPrice: 1, value: 88, windowTokens: 128000, isFree: false },
  ],
};

const learned: AvengersProPrediction = {
  paperIds: ["paper/frontier", "paper/cheap"],
  predictedQuality: { "paper/frontier": 0.95, "paper/cheap": 0.8 },
};

function selectFor(strategy: TaskStrategy, prediction = learned, candidateCatalog = learnedCatalog) {
  return selectModel(
    sess({ lastUserMessage: "implement the feature", userTag: "implement", forceTier: "medium", isNewSession: true }),
    candidateCatalog,
    {
      ...cfg,
      taskTypeModels: { ...cfg.taskTypeModels, implement: { prefer: null, strategy } },
      modelMap: {
        "paper/frontier": [{ runtimeId: "provider/frontier", source: "hand" }],
        "paper/cheap": [{ runtimeId: "provider/cheap", source: "hand" }],
      },
    },
    { currentModel: null, currentTier: null, downgradeCounter: 0 },
    undefined,
    undefined,
    prediction
  );
}

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

  it("orders learned quality candidates by predicted quality", () => {
    expect(selectFor("quality").modelId).toBe("provider/frontier");
  });

  it("orders learned lowest-cost candidates by blended price", () => {
    expect(selectFor("lowest-cost").modelId).toBe("provider/cheap");
  });

  it("orders learned paid value candidates by predicted quality per price", () => {
    expect(selectFor("value").modelId).toBe("provider/cheap");
  });

  it("uses catalog quality and runtime ID to break learned quality ties", () => {
    const tiedPrediction: AvengersProPrediction = {
      paperIds: ["paper/lower-catalog", "paper/z", "paper/a"],
      predictedQuality: { "paper/lower-catalog": 0.9, "paper/z": 0.9, "paper/a": 0.9 },
    };
    const tiedCatalog: Catalog = {
      fetchedAt: "t",
      source: "live",
      models: [
        { id: "lower-catalog", runtimeId: "provider/0", codingIndex: 90, blendedPrice: 1, value: 90, windowTokens: 128000, isFree: false },
        { id: "z", runtimeId: "provider/z", codingIndex: 91, blendedPrice: 1, value: 91, windowTokens: 128000, isFree: false },
        { id: "a", runtimeId: "provider/a", codingIndex: 91, blendedPrice: 1, value: 91, windowTokens: 128000, isFree: false },
      ],
    };
    const modelMap = {
      "paper/lower-catalog": [{ runtimeId: "provider/0", source: "hand" as const }],
      "paper/z": [{ runtimeId: "provider/z", source: "hand" as const }],
      "paper/a": [{ runtimeId: "provider/a", source: "hand" as const }],
    };
    const result = selectModel(
      sess({ userTag: "implement", forceTier: "medium", isNewSession: true }),
      tiedCatalog,
      { ...cfg, taskTypeModels: { ...cfg.taskTypeModels, implement: { prefer: null, strategy: "quality" } }, modelMap },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      tiedPrediction
    );

    expect(result.modelId).toBe("provider/a");
  });

  it("uses predicted quality and runtime ID to break learned lowest-cost ties", () => {
    const tiedPrediction: AvengersProPrediction = {
      paperIds: ["paper/lower-quality", "paper/z", "paper/a"],
      predictedQuality: { "paper/lower-quality": 0.8, "paper/z": 0.9, "paper/a": 0.9 },
    };
    const tiedCatalog: Catalog = {
      fetchedAt: "t",
      source: "live",
      models: [
        { id: "lower-quality", runtimeId: "provider/0", codingIndex: 90, blendedPrice: 1, value: 90, windowTokens: 128000, isFree: false },
        { id: "z", runtimeId: "provider/z", codingIndex: 90, blendedPrice: 1, value: 90, windowTokens: 128000, isFree: false },
        { id: "a", runtimeId: "provider/a", codingIndex: 90, blendedPrice: 1, value: 90, windowTokens: 128000, isFree: false },
      ],
    };
    const modelMap = {
      "paper/lower-quality": [{ runtimeId: "provider/0", source: "hand" as const }],
      "paper/z": [{ runtimeId: "provider/z", source: "hand" as const }],
      "paper/a": [{ runtimeId: "provider/a", source: "hand" as const }],
    };
    const result = selectModel(
      sess({ userTag: "implement", forceTier: "medium", isNewSession: true }),
      tiedCatalog,
      { ...cfg, taskTypeModels: { ...cfg.taskTypeModels, implement: { prefer: null, strategy: "lowest-cost" } }, modelMap },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      tiedPrediction
    );

    expect(result.modelId).toBe("provider/a");
  });

  it("prefers learned free value candidates by predicted quality and runtime ID", () => {
    const prediction: AvengersProPrediction = {
      paperIds: ["paper/paid", "paper/z", "paper/a"],
      predictedQuality: { "paper/paid": 0.99, "paper/z": 0.8, "paper/a": 0.8 },
    };
    const valueCatalog: Catalog = {
      fetchedAt: "t",
      source: "live",
      models: [
        { id: "paid", runtimeId: "provider/paid", codingIndex: 90, blendedPrice: 1, value: 90, windowTokens: 128000, isFree: false },
        { id: "z", runtimeId: "provider/z", codingIndex: 90, blendedPrice: 0, value: 900, windowTokens: 128000, isFree: true },
        { id: "a", runtimeId: "provider/a", codingIndex: 90, blendedPrice: 0, value: 900, windowTokens: 128000, isFree: true },
      ],
    };
    const modelMap = {
      "paper/paid": [{ runtimeId: "provider/paid", source: "hand" as const }],
      "paper/z": [{ runtimeId: "provider/z", source: "hand" as const }],
      "paper/a": [{ runtimeId: "provider/a", source: "hand" as const }],
    };
    const result = selectModel(
      sess({ userTag: "implement", forceTier: "medium", isNewSession: true }),
      valueCatalog,
      { ...cfg, modelMap },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      prediction
    );

    expect(result.modelId).toBe("provider/a");
  });

  it("uses predicted quality and runtime ID to break learned paid value-ratio ties", () => {
    const prediction: AvengersProPrediction = {
      paperIds: ["paper/lower-quality", "paper/z", "paper/a"],
      predictedQuality: { "paper/lower-quality": 0.4, "paper/z": 0.8, "paper/a": 0.8 },
    };
    const valueCatalog: Catalog = {
      fetchedAt: "t",
      source: "live",
      models: [
        { id: "lower-quality", runtimeId: "provider/0", codingIndex: 90, blendedPrice: 1, value: 90, windowTokens: 128000, isFree: false },
        { id: "z", runtimeId: "provider/z", codingIndex: 90, blendedPrice: 2, value: 45, windowTokens: 128000, isFree: false },
        { id: "a", runtimeId: "provider/a", codingIndex: 90, blendedPrice: 2, value: 45, windowTokens: 128000, isFree: false },
      ],
    };
    const modelMap = {
      "paper/lower-quality": [{ runtimeId: "provider/0", source: "hand" as const }],
      "paper/z": [{ runtimeId: "provider/z", source: "hand" as const }],
      "paper/a": [{ runtimeId: "provider/a", source: "hand" as const }],
    };
    const result = selectModel(
      sess({ userTag: "implement", forceTier: "medium", isNewSession: true }),
      valueCatalog,
      { ...cfg, modelMap },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      prediction
    );

    expect(result.modelId).toBe("provider/a");
  });

  it("does not admit an unmapped model through its learned score", () => {
    const result = selectModel(
      sess({ userTag: "implement", forceTier: "medium", isNewSession: true }),
      learnedCatalog,
      {
        ...cfg,
        taskTypeModels: { ...cfg.taskTypeModels, implement: { prefer: null, strategy: "quality" } },
        modelMap: { "paper/cheap": [{ runtimeId: "provider/cheap", source: "hand" }] },
      },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      learned
    );

    expect(result.modelId).toBe("provider/cheap");
  });

  it("does not admit a learned model below the global quality floor", () => {
    const floorCatalog: Catalog = {
      ...learnedCatalog,
      models: [
        { ...learnedCatalog.models[0], codingIndex: 84 },
        { ...learnedCatalog.models[1], codingIndex: 88 },
      ],
    };
    const result = selectModel(
      sess({ lastUserMessage: "plan the architecture", userTag: "planning", forceTier: "simple", isNewSession: true }),
      floorCatalog,
      {
        ...cfg,
        modelMap: {
          "paper/frontier": [{ runtimeId: "provider/frontier", source: "hand" }],
          "paper/cheap": [{ runtimeId: "provider/cheap", source: "hand" }],
        },
      },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      learned
    );

    expect(result.modelId).toBe("provider/cheap");
  });

  it("does not admit a mapped model with non-finite catalog quality", () => {
    const invalidQualityCatalog: Catalog = {
      ...learnedCatalog,
      models: [
        { ...learnedCatalog.models[0], codingIndex: Number.NaN },
        learnedCatalog.models[1],
      ],
    };

    expect(selectFor("quality", learned, invalidQualityCatalog).modelId).toBe("provider/cheap");
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    "does not admit a paid learned value candidate with price %s",
    (price) => {
      const invalidPriceCatalog: Catalog = {
        ...learnedCatalog,
        models: [
          { ...learnedCatalog.models[0], blendedPrice: price },
          learnedCatalog.models[1],
        ],
      };

      expect(selectFor("value", learned, invalidPriceCatalog).modelId).toBe("provider/cheap");
    }
  );

  it("applies context-fit guards after learned candidate ordering", () => {
    const prediction: AvengersProPrediction = {
      paperIds: ["paper/small-window"],
      predictedQuality: { "paper/small-window": 0.99 },
    };
    const result = selectModel(
      sess({ lifetimeTokens: 5000, forceTier: "simple", isCompacted: true }),
      catalog,
      { ...cfg, modelMap: { "paper/small-window": [{ runtimeId: "small-window", source: "hand" }] } },
      { currentModel: "frontier", currentTier: "complex", downgradeCounter: 3 },
      undefined,
      undefined,
      prediction
    );

    expect(result.modelId).toBe("frontier");
    expect(result.via).toBe("context-fit-block");
  });

  it("uses the first mapped Avengers-Pro paper id on a new task", () => {
    const r = selectModel(
      sess({ lastUserMessage: "implement the feature", isNewSession: true }),
      catalog,
      { ...cfg, modelMap: { "qwen/qwen3": [{ runtimeId: "free-medium", source: "hand" }] } },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      { paperIds: ["qwen/qwen3"], predictedQuality: { "qwen/qwen3": 0.9 } }
    );
    expect(r.modelId).toBe("free-medium");
    expect(r.via).toBe("avengers-pro");
  });

  it("planning overlay still rejects mapped models below quality 85", () => {
    const r = selectModel(
      sess({ lastUserMessage: "plan the architecture", userTag: "planning", forceTier: "simple", isNewSession: true }),
      catalog,
      { ...cfg, modelMap: { "qwen/qwen3": [{ runtimeId: "free-medium", source: "hand" }] } },
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      undefined,
      { paperIds: ["qwen/qwen3"], predictedQuality: { "qwen/qwen3": 0.9 } }
    );
    expect(r.modelId).toBe("frontier");
    expect(r.via).toBe("quality");
  });

  it("preserves the Tier-0 result when no learned candidate remains", () => {
    const session = sess({ lastUserMessage: "hello", isNewSession: true });
    const state: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    const tierZero = selectModel(session, catalog, cfg, state);
    const withUnmappedPrediction = selectModel(session, catalog, cfg, state, undefined, undefined, {
      paperIds: ["missing/model"],
      predictedQuality: { "missing/model": 1 },
    });

    expect(withUnmappedPrediction).toEqual(tierZero);
  });
});
