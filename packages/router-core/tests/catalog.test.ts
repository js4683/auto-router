import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { checkModelEligibility } from "../src/eligibility.js";
import { buildCatalog, buildCatalogFromProviders, loadCatalogSync } from "../src/catalog.js";
import { selectModel } from "../src/selector.js";
import type { RouterConfig } from "../src/types.js";

const cfg: RouterConfig = {
  tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
  scorer: { weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 }, thresholds: { simpleMax: 0.4, mediumMax: 0.7 } },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: { code_review: { prefer: null }, run_tests: { prefer: null }, monitoring: { prefer: null }, planning: { prefer: null }, implement: { prefer: null }, debug: { prefer: null } },
  providerFreeSet: ["free-model"],
  windowRegistry: { "model-a": 128000, "free-model": 100000 },
  catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
};

describe("catalog build", () => {
  it("value = codingIndex / blendedPrice", () => {
    const cat = buildCatalog(
      [
        { id: "model-a", evaluations: { artificial_analysis_coding_index: 80 }, pricing: { price_1m_blended_3_to_1: 4 } },
        { id: "free-model", evaluations: { artificial_analysis_coding_index: 60 }, pricing: { price_1m_blended_3_to_1: 2 } },
      ],
      cfg
    );
    const a = cat.models.find((m) => m.id === "model-a")!;
    expect(a.value).toBeCloseTo(20);
    const f = cat.models.find((m) => m.id === "free-model")!;
    expect(f.isFree).toBe(true);
    expect(a.windowTokens).toBe(128000);
    expect(a.capabilities).toEqual(["text"]);
    expect(a.transports).toEqual(["chat"]);
  });

  it("free join is case-insensitive", () => {
    const cat = buildCatalog([{ id: "Free-Model", evaluations: { artificial_analysis_coding_index: 70 }, pricing: { price_1m_blended_3_to_1: 1 } }], cfg);
    expect(cat.models[0].isFree).toBe(true);
  });

  it("fallback window when not in registry", () => {
    const cat = buildCatalog([{ id: "unknown", evaluations: { artificial_analysis_coding_index: 50 }, pricing: { price_1m_blended_3_to_1: 1 } }], cfg);
    expect(cat.models[0].windowTokens).toBe(128000);
  });

  it("blended price computed from input/output when blended missing", () => {
    const cat = buildCatalog(
      [{ id: "x", evaluations: { artificial_analysis_coding_index: 80 }, pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 5 } }],
      cfg
    );
    // (1*1 +5*3)/4 = 16/4=4
    expect(cat.models[0].blendedPrice).toBe(4);
    expect(cat.models[0].value).toBe(20);
  });

  it("builds a catalog from connected OpenCode providers", () => {
    const cat = buildCatalogFromProviders(
      {
        connected: ["opencode"],
        all: [
          {
            id: "opencode",
            models: {
              "muse-spark-1.2-contributor-free": {
                id: "muse-spark-1.2-contributor-free",
                name: "Muse Spark 1.2 Free",
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 1048576, output: 131072 },
                status: "active",
              },
            },
          },
          { id: "not-connected", models: { ignored: {} } },
        ],
      },
      cfg,
    );

    expect(cat.source).toBe("live");
    expect(cat.models).toHaveLength(1);
    expect(cat.models[0]).toMatchObject({
      id: "muse-spark-1.2-contributor-free",
      runtimeId: "opencode/muse-spark-1.2-contributor-free",
      isFree: true,
      windowTokens: 1048576,
      capabilities: ["text"],
      transports: ["responses"],
    });
  });

  it("normalizes a previous-schema cache before transport eligibility", () => {
    const root = mkdtempSync(join(tmpdir(), "ar-catalog-cache-"));
    const path = join(root, "catalog.json");
    writeFileSync(path, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      source: "aa",
      models: [{
        id: "gpt-4",
        runtimeId: "openai/gpt-4",
        codingIndex: 80,
        blendedPrice: 1,
        value: 80,
        windowTokens: 128000,
        isFree: false,
      }],
    }));

    try {
      const loaded = loadCatalogSync({ ...cfg, catalog: { ...cfg.catalog, cachePath: path } });
      expect(loaded.source).toBe("cache");
      expect(loaded.models[0].transports).toEqual(["chat", "responses"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives fallback transports after applying a mapped runtime ID", () => {
    const root = mkdtempSync(join(tmpdir(), "ar-catalog-fallback-"));
    try {
      const loaded = loadCatalogSync(
        {
          ...cfg,
          modelMap: { "paper/model-a": [{ runtimeId: "openai/model-a", source: "hand" }] },
        },
        join(root, "missing.json"),
      );
      const model = loaded.models.find((entry) => entry.id === "model-a");
      expect(model?.runtimeId).toBe("openai/model-a");
      expect(checkModelEligibility(model!, {
        lifetimeTokens: 1_000,
        requiredCapabilities: ["text"],
        transport: "responses",
      }, cfg)).toMatchObject({ pass: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects the cheapest provider-qualified OpenAI fallback for verification", () => {
    const root = mkdtempSync(join(tmpdir(), "ar-openai-fallback-"));
    const fallbackConfig: RouterConfig = {
      ...cfg,
      taskTypeModels: { ...cfg.taskTypeModels, run_tests: { prefer: null, strategy: "lowest-cost" } },
      windowRegistry: { "gpt-5.3-codex-spark": 100000, "gpt-5.6-sol": 272000 },
      modelMap: { "openai/gpt-5-medium": [{ runtimeId: "openai/gpt-5.6-sol", source: "hand" }] },
    };

    try {
      const fallback = loadCatalogSync(fallbackConfig, join(root, "missing.json"));
      const result = selectModel(
        {
          lifetimeTokens: 1,
          currentTask: { promptTokens: 1, taskTokens: 1, filesTouched: 0, diffHunks: 0, toolDepth: 0, lastUserMessage: "run verification" },
          userTag: "run_tests",
          isNewSession: true,
        },
        fallback,
        fallbackConfig,
        { currentModel: null, currentTier: null, downgradeCounter: 0 },
        undefined,
        undefined,
        undefined,
        { lifetimeTokens: 1, requiredCapabilities: ["text"], transport: "chat" },
      );

      expect(result.modelId).toBe("openai/gpt-5.3-codex-spark");
      expect(result.via).toBe("lowest-cost");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only marks OpenCode models free when pricing says they are free", () => {
    const cat = buildCatalogFromProviders(
      {
        connected: ["opencode"],
        all: [
          {
            id: "opencode",
            models: {
              "paid-zen": { id: "paid-zen", cost: { input: 1, output: 4 } },
              "free-zen": { id: "free-zen", cost: { input: 0, output: 0 } },
            },
          },
        ],
      },
      { ...cfg, providerFreeSet: [] },
    );

    expect(cat.models.find((model) => model.id === "paid-zen")?.isFree).toBe(false);
    expect(cat.models.find((model) => model.id === "free-zen")?.isFree).toBe(true);
  });

  it("infers high capability for Sol, Fable, and Opus model families", () => {
    const cat = buildCatalogFromProviders(
      {
        connected: ["openai", "anthropic"],
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.6-sol": { id: "gpt-5.6-sol", cost: { input: 3, output: 12 } },
              "fable-latest": { id: "fable-latest", cost: { input: 2, output: 8 } },
            },
          },
          {
            id: "anthropic",
            models: {
              "claude-opus-4-1": { id: "claude-opus-4-1", cost: { input: 5, output: 25 } },
            },
          },
        ],
      },
      cfg,
    );

    expect(cat.models).toHaveLength(3);
    expect(cat.models.every((model) => model.codingIndex >= 85)).toBe(true);
  });
});
