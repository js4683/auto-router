import type { EvalDatasetV1, EvalTurnV1 } from "../src/types.js";

export function fixtureTurn(overrides: Partial<EvalTurnV1> = {}): EvalTurnV1 {
  return {
    id: "turn-1",
    sessionState: {
      lifetimeTokens: 1000,
      currentTask: {
        promptTokens: 20,
        taskTokens: 1000,
        filesTouched: 1,
        diffHunks: 0,
        toolDepth: 0,
        lastUserMessage: "Implement the fixture",
      },
      isNewSession: true,
      forceTier: "simple",
    },
    messages: [{ role: "user", content: "Implement the fixture" }],
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    terminalState: "completed",
    contentTruncated: false,
    requiredCapabilities: ["text"],
    ...overrides,
  };
}

export function fixtureDataset(turns: EvalTurnV1[] = [fixtureTurn()]): EvalDatasetV1 {
  return {
    schemaVersion: 1,
    id: "fixture",
    description: "Synthetic eval fixture",
    catalog: {
      fetchedAt: "2026-08-31T00:00:00.000Z",
      source: "cache",
      models: [
        {
          id: "cheap",
          runtimeId: "provider/cheap",
          codingIndex: 70,
          blendedPrice: 1,
          value: 70,
          windowTokens: 128000,
          isFree: false,
        },
        {
          id: "frontier",
          runtimeId: "provider/frontier",
          codingIndex: 95,
          blendedPrice: 10,
          value: 9.5,
          windowTokens: 256000,
          isFree: false,
        },
      ],
    },
    config: {
      tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
      scorer: {
        weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 },
        thresholds: { simpleMax: 0.4, mediumMax: 0.7 },
      },
      stickiness: { downgradeAfter: 3, upgradeImmediate: true },
      guards: { contextFitMarginTokens: 8000 },
      taskTypeModels: {
        code_review: { prefer: null },
        run_tests: { prefer: null, strategy: "lowest-cost" },
        monitoring: { prefer: null },
        planning: { prefer: null, strategy: "quality", minQuality: 85 },
        implement: { prefer: null },
        debug: { prefer: null },
      },
      providerFreeSet: [],
      windowRegistry: {},
      catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
    },
    prices: {
      "provider/cheap": { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 },
      "provider/frontier": { inputPerMillion: 10, outputPerMillion: 30, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5 },
    },
    capabilities: {
      "provider/cheap": ["text", "tools"],
      "provider/frontier": ["text", "tools"],
    },
    sessions: [{ id: "session-1", turns }],
  };
}
