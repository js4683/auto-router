import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AvengersCorpusExampleV1, AvengersCorpusV1, AvengersOutcomeV1 } from "../src/avengers-corpus.js";
import { avengersCorpusDigest, parseAvengersCorpus, readAvengersCorpus, splitAvengersCorpus } from "../src/avengers-corpus.js";

function validOutcome(overrides: Partial<AvengersOutcomeV1> = {}): AvengersOutcomeV1 {
  return {
    paperModelId: "paper/alpha",
    runtimeModelId: "provider/alpha",
    terminalState: "completed",
    contentTruncated: false,
    quality: 0.8,
    qualitySource: "judge",
    ...overrides,
  };
}

function validExample(overrides: Partial<AvengersCorpusExampleV1> = {}): AvengersCorpusExampleV1 {
  return {
    id: "example-1",
    sessionGroupId: "group-1",
    sequence: 0,
    weight: 1,
    text: "Implement a retry wrapper around the HTTP client.",
    sessionState: {
      lifetimeTokens: 1000,
      currentTask: {
        promptTokens: 20,
        taskTokens: 500,
        filesTouched: 1,
        diffHunks: 0,
        toolDepth: 0,
        lastUserMessage: "Implement a retry wrapper around the HTTP client.",
      },
      isNewSession: true,
    },
    requiredCapabilities: ["text"],
    outcomes: [
      validOutcome({ paperModelId: "paper/alpha", runtimeModelId: "provider/alpha" }),
      validOutcome({ paperModelId: "paper/beta", runtimeModelId: "provider/beta" }),
    ],
    ...overrides,
  };
}

function validCorpus(): AvengersCorpusV1 {
  return {
    schemaVersion: 1,
    id: "fixture-corpus",
    synthetic: true,
    candidatePaperModelIds: ["paper/alpha", "paper/beta"],
    routingSnapshot: {
      catalog: {
        fetchedAt: "2026-08-31T00:00:00.000Z",
        source: "cache",
        models: [
          { id: "paper/alpha", runtimeId: "provider/alpha", codingIndex: 70, blendedPrice: 1, value: 70, windowTokens: 128000, isFree: false },
          { id: "paper/beta", runtimeId: "provider/beta", codingIndex: 90, blendedPrice: 5, value: 18, windowTokens: 128000, isFree: false },
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
        "provider/alpha": { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 },
        "provider/beta": { inputPerMillion: 5, outputPerMillion: 10, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6 },
      },
      capabilities: {
        "provider/alpha": ["text"],
        "provider/beta": ["text"],
      },
      modelMap: {
        "paper/alpha": [{ runtimeId: "provider/alpha", source: "hand" }],
        "paper/beta": [{ runtimeId: "provider/beta", source: "hand" }],
      },
    },
    examples: [validExample()],
  };
}

function corpusWithRepeatedGroups(): AvengersCorpusV1 {
  const corpus = validCorpus();
  corpus.examples = [
    validExample({ id: "ex-1", sessionGroupId: "group-1", sequence: 0 }),
    validExample({ id: "ex-2", sessionGroupId: "group-1", sequence: 1 }),
    validExample({ id: "ex-3", sessionGroupId: "group-2", sequence: 0 }),
    validExample({ id: "ex-4", sessionGroupId: "group-2", sequence: 1 }),
    validExample({ id: "ex-5", sessionGroupId: "group-3", sequence: 0 }),
    validExample({ id: "ex-6", sessionGroupId: "group-13", sequence: 0 }),
  ];
  return corpus;
}

describe("parseAvengersCorpus", () => {
  it("parses a valid corpus", () => {
    expect(() => parseAvengersCorpus(validCorpus())).not.toThrow();
  });

  it("requires failed and incomplete outcomes to have zero quality", () => {
    const value = validCorpus();
    value.examples[0].outcomes[0] = { ...value.examples[0].outcomes[0], terminalState: "failed", quality: 0.7 };
    expect(() => parseAvengersCorpus(value)).toThrow("non-completed outcome quality must be zero");
  });

  it("rejects duplicate example IDs", () => {
    const value = validCorpus();
    value.examples = [validExample({ id: "dup" }), validExample({ id: "dup", sessionGroupId: "group-2" })];
    expect(() => parseAvengersCorpus(value)).toThrow(/duplicate example id/);
  });

  it("rejects duplicate sequence values within a session group", () => {
    const value = validCorpus();
    value.examples = [
      validExample({ id: "ex-1", sessionGroupId: "group-a", sequence: 0 }),
      validExample({ id: "ex-2", sessionGroupId: "group-a", sequence: 0 }),
    ];
    expect(() => parseAvengersCorpus(value)).toThrow(/sequence/);
  });

  it("rejects non-contiguous sequence values within a session group", () => {
    const value = validCorpus();
    value.examples = [
      validExample({ id: "ex-1", sessionGroupId: "group-a", sequence: 0 }),
      validExample({ id: "ex-2", sessionGroupId: "group-a", sequence: 2 }),
    ];
    expect(() => parseAvengersCorpus(value)).toThrow(/sequence/);
  });

  it("rejects duplicate model outcomes within an example", () => {
    const value = validCorpus();
    value.examples[0].outcomes = [validOutcome({ paperModelId: "paper/alpha" }), validOutcome({ paperModelId: "paper/alpha" })];
    expect(() => parseAvengersCorpus(value)).toThrow(/duplicate/i);
  });

  it("rejects an example missing the complete candidate matrix", () => {
    const value = validCorpus();
    value.examples[0].outcomes = [validOutcome({ paperModelId: "paper/alpha" })];
    expect(() => parseAvengersCorpus(value)).toThrow(/candidate/i);
  });

  it("rejects empty text", () => {
    const value = validCorpus();
    value.examples[0] = validExample({ text: "" });
    expect(() => parseAvengersCorpus(value)).toThrow(/text/i);
  });

  it("rejects text over 64 KiB", () => {
    const value = validCorpus();
    value.examples[0] = validExample({ text: "a".repeat(64 * 1024 + 1) });
    expect(() => parseAvengersCorpus(value)).toThrow(/64/);
  });

  it("rejects more than 10000 examples", () => {
    const value = validCorpus();
    const examples: AvengersCorpusExampleV1[] = [];
    for (let i = 0; i < 10001; i++) {
      examples.push(validExample({ id: `ex-${i}`, sessionGroupId: `group-${i}`, sequence: 0 }));
    }
    value.examples = examples;
    expect(() => parseAvengersCorpus(value)).toThrow(/10,?000/);
  }, 20000);

  it("rejects more than 64 outcomes per example", () => {
    const value = validCorpus();
    const outcomes: AvengersOutcomeV1[] = [];
    for (let i = 0; i < 65; i++) {
      outcomes.push(validOutcome({ paperModelId: `paper/m${i}`, runtimeModelId: `provider/m${i}` }));
    }
    value.candidatePaperModelIds = outcomes.map((o) => o.paperModelId);
    value.examples[0].outcomes = outcomes;
    expect(() => parseAvengersCorpus(value)).toThrow(/64/);
  });

  it("rejects non-positive weight", () => {
    const value = validCorpus();
    value.examples[0] = validExample({ weight: 0 });
    expect(() => parseAvengersCorpus(value)).toThrow(/weight/i);
  });

  it("rejects quality outside [0, 1]", () => {
    const value = validCorpus();
    value.examples[0].outcomes[0] = { ...value.examples[0].outcomes[0], quality: 1.5 };
    expect(() => parseAvengersCorpus(value)).toThrow(/quality/i);
  });

  it("rejects truncated content marked completed", () => {
    const value = validCorpus();
    value.examples[0].outcomes[0] = { ...value.examples[0].outcomes[0], contentTruncated: true, terminalState: "completed" };
    expect(() => parseAvengersCorpus(value)).toThrow(/truncated/i);
  });

  it("rejects negative cost", () => {
    const value = validCorpus();
    value.examples[0].outcomes[0] = { ...value.examples[0].outcomes[0], costUsd: -1 };
    expect(() => parseAvengersCorpus(value)).toThrow(/cost/i);
  });

  it("rejects non-finite cost", () => {
    const value = validCorpus();
    value.examples[0].outcomes[0] = { ...value.examples[0].outcomes[0], costUsd: Number.POSITIVE_INFINITY };
    expect(() => parseAvengersCorpus(value)).toThrow(/cost/i);
  });

  it("rejects malformed usage provenance", () => {
    const value = validCorpus();
    value.examples[0].outcomes[0] = {
      ...value.examples[0].outcomes[0],
      usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    } as AvengersOutcomeV1;
    expect(() => parseAvengersCorpus(value)).toThrow(/usageSource/i);
  });

  it("rejects an unknown runtime alias", () => {
    const value = validCorpus();
    value.examples[0].outcomes[0] = { ...value.examples[0].outcomes[0], runtimeModelId: "provider/unknown" };
    expect(() => parseAvengersCorpus(value)).toThrow(/runtime/i);
  });
});

describe("splitAvengersCorpus", () => {
  it("keeps every session group on one side of the split", () => {
    const split = splitAvengersCorpus(corpusWithRepeatedGroups(), "seed-1", 0.4);
    const trainGroups = new Set(split.train.map((item) => item.sessionGroupId));
    expect(split.heldOut.every((item) => !trainGroups.has(item.sessionGroupId))).toBe(true);
  });

  it("rejects a held-out ratio outside (0, 1)", () => {
    expect(() => splitAvengersCorpus(corpusWithRepeatedGroups(), "seed-1", 0)).toThrow(/ratio/i);
    expect(() => splitAvengersCorpus(corpusWithRepeatedGroups(), "seed-1", 1)).toThrow(/ratio/i);
  });

  it("produces stable, sorted output for a literal seed", () => {
    const split = splitAvengersCorpus(corpusWithRepeatedGroups(), "phase-4-fixed-seed", 0.4);
    expect(split.train.length + split.heldOut.length).toBe(6);
    expect(split.train.length).toBeGreaterThan(0);
    expect(split.heldOut.length).toBeGreaterThan(0);
    const again = splitAvengersCorpus(corpusWithRepeatedGroups(), "phase-4-fixed-seed", 0.4);
    expect(again.train.map((e) => e.id)).toEqual(split.train.map((e) => e.id));
    expect(again.heldOut.map((e) => e.id)).toEqual(split.heldOut.map((e) => e.id));
  });
});

describe("avengersCorpusDigest", () => {
  it("is a stable lowercase SHA-256 hex digest", () => {
    const digest = avengersCorpusDigest(parseAvengersCorpus(validCorpus()));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(avengersCorpusDigest(parseAvengersCorpus(validCorpus()))).toBe(digest);
  });
});

describe("phase-4-corpus.v1.json fixture", () => {
  it("loads a synthetic corpus with required coverage", () => {
    const path = fileURLToPath(new URL("../fixtures/phase-4-corpus.v1.json", import.meta.url));
    const corpus = readAvengersCorpus(path);
    expect(corpus.synthetic).toBe(true);
    expect(corpus.candidatePaperModelIds).toHaveLength(3);
    expect(corpus.examples.length).toBeGreaterThanOrEqual(6);
    const groups = new Set(corpus.examples.map((example) => example.sessionGroupId));
    expect(groups.size).toBeGreaterThanOrEqual(4);
    const states = new Set(corpus.examples.flatMap((example) => example.outcomes.map((outcome) => outcome.terminalState)));
    expect(states).toEqual(new Set(["completed", "incomplete", "failed"]));
    const split = splitAvengersCorpus(corpus, "fixture-seed", 0.34);
    expect(split.train.length).toBeGreaterThan(0);
    expect(split.heldOut.length).toBeGreaterThan(0);
  });
});
