import { describe, expect, it } from "vitest";
import { checkModelEligibility, filterEligibleModels } from "../src/eligibility.js";
import type { Catalog, ModelEntry, RouterConfig, SelectionRequirements } from "../src/types.js";

const config: RouterConfig = {
  tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
  scorer: {
    weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 },
    thresholds: { simpleMax: 0.4, mediumMax: 0.7 },
  },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: {},
  providerFreeSet: [],
  windowRegistry: {},
  catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
};

const requirements: SelectionRequirements = {
  lifetimeTokens: 12_000,
  requiredCapabilities: ["text", "tools"],
  transport: "chat",
};

const model = (overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  id: "model",
  codingIndex: 80,
  blendedPrice: 1,
  value: 80,
  windowTokens: 128_000,
  isFree: false,
  capabilities: ["text", "tools"],
  transports: ["chat"],
  ...overrides,
});

describe("shared model eligibility", () => {
  it("rejects a model whose context cannot fit the request", () => {
    expect(checkModelEligibility(model({ windowTokens: 16_000 }), requirements, config)).toMatchObject({
      pass: false,
      code: "context-overflow",
    });
  });

  it("rejects a model missing a required capability", () => {
    expect(checkModelEligibility(model({ capabilities: ["text"] }), requirements, config)).toMatchObject({
      pass: false,
      code: "missing-capability",
    });
  });

  it("rejects a model that does not support the requested transport", () => {
    expect(checkModelEligibility(model({ transports: ["responses"] }), requirements, config)).toMatchObject({
      pass: false,
      code: "unsupported-transport",
    });
  });

  it("accepts a model satisfying context, capability, and transport requirements", () => {
    expect(checkModelEligibility(model(), requirements, config)).toMatchObject({ pass: true });
  });

  it("treats omitted capabilities as text-only and omitted transports as unsupported", () => {
    expect(checkModelEligibility(model({ capabilities: undefined, transports: undefined }), {
      ...requirements,
      requiredCapabilities: ["text"],
    }, config)).toMatchObject({ pass: false, code: "unsupported-transport" });
  });

  it("filters the catalog using the same deterministic eligibility result", () => {
    const catalog: Catalog = {
      fetchedAt: "2026-09-09T00:00:00.000Z",
      source: "live",
      models: [
        model({ id: "overflow", windowTokens: 1_000 }),
        model({ id: "wrong-transport", transports: ["responses"] }),
        model({ id: "eligible" }),
      ],
    };

    expect(filterEligibleModels(catalog, requirements, config).map((entry) => entry.id)).toEqual(["eligible"]);
  });
});
