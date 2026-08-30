import { describe, it, expect } from "vitest";
import { passesContextFit } from "../src/guards.js";
import type { ModelEntry, RouterConfig } from "../src/types.js";

const cfg: RouterConfig = {
  tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
  scorer: { weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 }, thresholds: { simpleMax: 0.4, mediumMax: 0.7 } },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: { code_review: { prefer: null }, run_tests: { prefer: null }, monitoring: { prefer: null }, implement: { prefer: null }, debug: { prefer: null } },
  providerFreeSet: [],
  windowRegistry: {},
  catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
};

function model(id: string, windowTokens: number): ModelEntry {
  return { id, codingIndex: 70, blendedPrice: 2, value: 35, windowTokens, isFree: false };
}

describe("context-fit guard", () => {
  it("passes when fits with margin", () => {
    const r = passesContextFit(50000, model("cheap", 128000), cfg);
    expect(r.pass).toBe(true);
  });

  it("fails when would overflow", () => {
    const r = passesContextFit(125000, model("small", 128000), cfg);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/overflow/);
  });

  it("fail-open on unknown window", () => {
    const r = passesContextFit(999999, model("unknown", 0), cfg);
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/fail-open/);
  });

  it("respects custom margin", () => {
    const cfgSmall: RouterConfig = { ...cfg, guards: { contextFitMarginTokens: 1000 } };
    const r = passesContextFit(127000, model("m", 128000), cfgSmall);
    expect(r.pass).toBe(true); // 127k+1k=128k fits
    const r2 = passesContextFit(127000, model("m", 128000), { ...cfg, guards: { contextFitMarginTokens: 8000 } });
    expect(r2.pass).toBe(false);
  });
});
