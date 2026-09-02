import { describe, expect, it } from "vitest";
import { artifactDigest, type AvengersProArtifactFiles, type EmbeddingClientConfig } from "@auto-router/router-core";
import { avengersCorpusDigest, parseAvengersCorpus, type AvengersCorpusV1 } from "../src/avengers-corpus.js";
import { validateAvengersArtifact } from "../src/avengers-validation.js";

const embedding: EmbeddingClientConfig = {
  baseUrl: "https://embed.test/v1",
  apiKey: "key",
  model: "embed/test",
  timeoutMs: 400,
};

function outcome(paper: string, runtime: string, quality: number, costUsd: number) {
  return {
    paperModelId: paper,
    runtimeModelId: runtime,
    terminalState: "completed" as const,
    contentTruncated: false,
    quality,
    qualitySource: "deterministic" as const,
    costUsd,
    costSource: "estimated" as const,
  };
}

function example(id: string, group: string, sequence: number, quality = 1, cost = 1) {
  return {
    id,
    sessionGroupId: group,
    sequence,
    weight: 1,
    text: id,
    sessionState: {
      lifetimeTokens: 1,
      isNewSession: sequence === 0,
      currentTask: { promptTokens: 1, taskTokens: 1, filesTouched: 0, diffHunks: 0, toolDepth: 0, lastUserMessage: id },
    },
    requiredCapabilities: ["text"],
    outcomes: [
      outcome("paper/frontier", "provider/frontier", quality, cost * 2),
      outcome("paper/cheap", "provider/cheap", quality, cost * 0.4),
    ],
  };
}

function corpus(count = 40, synthetic = false): AvengersCorpusV1 {
  const examples = Array.from({ length: count }, (_, index) => example(`ex-${index}`, `group-${index}`, 0));
  return parseAvengersCorpus({
    schemaVersion: 1,
    id: "validation-corpus",
    synthetic,
    candidatePaperModelIds: ["paper/frontier", "paper/cheap"],
    routingSnapshot: {
      catalog: {
        fetchedAt: "t",
        source: "cache",
        models: [
          { id: "frontier", runtimeId: "provider/frontier", codingIndex: 95, blendedPrice: 10, value: 9.5, windowTokens: 272000, isFree: false },
          { id: "cheap", runtimeId: "provider/cheap", codingIndex: 70, blendedPrice: 1, value: 70, windowTokens: 128000, isFree: false },
        ],
      },
      config: {
        tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
        scorer: { weights: { promptTokens: 1, sessionTokens: 0, filesTouched: 0, diffHunks: 0, toolDepth: 0, keywords: 0 }, thresholds: { simpleMax: 0.4, mediumMax: 0.7 } },
        stickiness: { downgradeAfter: 3, upgradeImmediate: true },
        guards: { contextFitMarginTokens: 8000 },
        taskTypeModels: { implement: { prefer: null, strategy: "lowest-cost" } },
        providerFreeSet: [],
        windowRegistry: {},
        catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
      },
      prices: {
        "provider/frontier": { inputPerMillion: 10, outputPerMillion: 10, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
        "provider/cheap": { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
      },
      capabilities: { "provider/frontier": ["text"], "provider/cheap": ["text"] },
      modelMap: {
        "paper/frontier": [{ runtimeId: "provider/frontier", source: "hand" }],
        "paper/cheap": [{ runtimeId: "provider/cheap", source: "hand" }],
      },
    },
    examples,
  });
}

function artifactFor(source: AvengersCorpusV1, synthetic = false): AvengersProArtifactFiles {
  const files = {
    metadata: {
      schemaVersion: 2 as const,
      synthetic,
      embeddingModel: "embed/test",
      embeddingDimensions: 2,
      normalizationVersion: "phase4-text-v1" as const,
      maxInputChars: 16000,
      corpusDigest: avengersCorpusDigest(source),
      splitSeed: "seed-1",
      heldOutRatio: 0.4,
      algorithmVersion: "deterministic-kmeans-v1" as const,
      nClusters: 1,
      topK: 1,
      beta: 9,
      minObservations: 1,
      availableModels: ["paper/cheap", "paper/frontier"],
    },
    centers: [[1, 0]],
    clusterModelStats: {
      0: {
        "paper/cheap": { qualityMean: 0.9, completed: 1, failed: 0, observations: 1 },
        "paper/frontier": { qualityMean: 0.1, completed: 1, failed: 0, observations: 1 },
      },
    },
    digest: "",
  };
  files.digest = artifactDigest(files);
  return files;
}

function fetchImpl(): typeof fetch {
  return async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
}

function clock() {
  let now = 0;
  return () => {
    now += 10;
    return now;
  };
}

describe("validateAvengersArtifact", () => {
  it("forces synthetic artifacts ineligible", async () => {
    const source = corpus(40, true);
    const report = await validateAvengersArtifact({
      corpus: source,
      artifact: artifactFor(source, true),
      embedding,
      bootstrapSeed: "boot",
      fetchImpl: fetchImpl(),
      now: clock(),
    });
    expect(report.validation.eligible).toBe(false);
    expect(report.validation.gates.synthetic.passed).toBe(false);
  });

  it("fails the corpus gate without making a network call", async () => {
    const source = corpus();
    const artifact = artifactFor(source);
    artifact.metadata.corpusDigest = "a".repeat(64);
    let called = false;
    const report = await validateAvengersArtifact({
      corpus: source,
      artifact,
      embedding,
      bootstrapSeed: "boot",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(called).toBe(false);
    expect(report.validation.gates.corpus.passed).toBe(false);
    expect(report.validation.eligible).toBe(false);
  });

  it("fails the embedding gate on model mismatch before network", async () => {
    const source = corpus();
    let called = false;
    const report = await validateAvengersArtifact({
      corpus: source,
      artifact: artifactFor(source),
      embedding: { ...embedding, model: "other" },
      bootstrapSeed: "boot",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(called).toBe(false);
    expect(report.validation.gates.embedding.passed).toBe(false);
  });
});
