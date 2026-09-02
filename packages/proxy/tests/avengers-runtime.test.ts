import { describe, expect, it, vi } from "vitest";
import type { RouterConfig } from "@auto-router/router-core";
import { createAvengersRuntime } from "../src/avengers-runtime.js";

function disabledConfig(): RouterConfig {
  return {
    tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
    scorer: { weights: { promptTokens: 1, sessionTokens: 0, filesTouched: 0, diffHunks: 0, toolDepth: 0, keywords: 0 }, thresholds: { simpleMax: 0.4, mediumMax: 0.7 } },
    stickiness: { downgradeAfter: 3, upgradeImmediate: true },
    guards: { contextFitMarginTokens: 8000 },
    taskTypeModels: { implement: { prefer: null } },
    providerFreeSet: [],
    windowRegistry: {},
    catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
    avengersPro: { enabled: false, artifactDir: "./packages/router-core/artifacts/avengers-pro/fixture", timeoutMs: 400, maxInputChars: 16000 },
  };
}

function enabledFixtureConfig(): RouterConfig {
  return {
    ...disabledConfig(),
    avengersPro: {
      enabled: true,
      artifactDir: "./packages/router-core/artifacts/avengers-pro/fixture",
      embedding: { baseUrl: "https://embed.test/v1", apiKeyEnv: "EMBED_KEY", model: "fixture" },
      timeoutMs: 400,
      maxInputChars: 16000,
    },
  };
}

describe("createAvengersRuntime", () => {
  it("returns no runtime when Tier 1 is disabled", () => {
    const warn = vi.fn();
    expect(createAvengersRuntime({ config: disabledConfig(), env: {}, warn })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a synthetic or ineligible artifact without stopping the proxy", () => {
    const warn = vi.fn();
    const runtime = createAvengersRuntime({ config: enabledFixtureConfig(), env: { EMBED_KEY: "secret" }, warn });
    expect(runtime).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "artifact-ineligible" }));
  });
});
