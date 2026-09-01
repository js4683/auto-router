import { describe, expect, it } from "vitest";
import type { EvalDatasetV1 } from "../src/types.js";
import { parseDataset } from "../src/schema.js";

function validDataset(): EvalDatasetV1 {
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
          codingIndex: 60,
          blendedPrice: 1,
          value: 60,
          windowTokens: 128000,
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
      taskTypeModels: { implement: { prefer: null } },
      providerFreeSet: [],
      windowRegistry: {},
      catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
    },
    prices: {
      "provider/cheap": {
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheReadPerMillion: 0.1,
        cacheWritePerMillion: 1.25,
      },
    },
    sessions: [
      {
        id: "session-1",
        turns: [
          {
            id: "turn-1",
            sessionState: {
              lifetimeTokens: 100,
              currentTask: {
                promptTokens: 10,
                taskTokens: 100,
                filesTouched: 0,
                diffHunks: 0,
                toolDepth: 0,
                lastUserMessage: "Implement the fixture",
              },
              isNewSession: true,
            },
            messages: [{ role: "user", content: "Implement the fixture" }],
            usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
          },
        ],
      },
    ],
  };
}

describe("parseDataset", () => {
  it("accepts a complete version 1 dataset", () => {
    expect(parseDataset(validDataset())).toEqual(validDataset());
  });

  it("rejects an unsupported schema version", () => {
    expect(() => parseDataset({ ...validDataset(), schemaVersion: 2 })).toThrow("unsupported schemaVersion 2");
  });

  it("rejects an empty session list", () => {
    expect(() => parseDataset({ ...validDataset(), sessions: [] })).toThrow("sessions must not be empty");
  });

  it("rejects duplicate session and turn IDs", () => {
    const dataset = validDataset();
    const duplicateSession = { ...dataset.sessions[0], turns: [...dataset.sessions[0].turns, dataset.sessions[0].turns[0]] };
    expect(() => parseDataset({ ...dataset, sessions: [duplicateSession] })).toThrow("duplicate turn id turn-1");
    expect(() => parseDataset({ ...dataset, sessions: [dataset.sessions[0], dataset.sessions[0]] })).toThrow("duplicate session id session-1");
  });

  it("rejects invalid usage", () => {
    const dataset = validDataset();
    const turn = { ...dataset.sessions[0].turns[0], usage: { ...dataset.sessions[0].turns[0].usage, inputTokens: -1 } };
    expect(() => parseDataset({ ...dataset, sessions: [{ ...dataset.sessions[0], turns: [turn] }] })).toThrow(
      "inputTokens must be non-negative"
    );

    const invalidCache = { ...dataset.sessions[0].turns[0], usage: { ...dataset.sessions[0].turns[0].usage, cacheReadInputTokens: 101 } };
    expect(() => parseDataset({ ...dataset, sessions: [{ ...dataset.sessions[0], turns: [invalidCache] }] })).toThrow(
      "cache token total must not exceed inputTokens"
    );
  });

  it("rejects oversized content and datasets above 1000 turns", () => {
    const dataset = validDataset();
    const oversized = { ...dataset.sessions[0].turns[0], messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 1) }] };
    expect(() => parseDataset({ ...dataset, sessions: [{ ...dataset.sessions[0], turns: [oversized] }] })).toThrow(
      "message content exceeds 1048576 bytes"
    );

    const turns = Array.from({ length: 1001 }, (_, index) => ({ ...dataset.sessions[0].turns[0], id: `turn-${index}` }));
    expect(() => parseDataset({ ...dataset, sessions: [{ ...dataset.sessions[0], turns }] })).toThrow("dataset exceeds 1000 turns");
  });

  it("allows missing prices for incomplete-metric reporting", () => {
    expect(parseDataset({ ...validDataset(), prices: {} }).prices).toEqual({});
  });
});
