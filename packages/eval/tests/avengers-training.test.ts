import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadAvengersProArtifactFiles } from "@auto-router/router-core";
import { parseAvengersCorpus, readAvengersCorpus, splitAvengersCorpus, type AvengersCorpusV1, type AvengersOutcomeV1 } from "../src/avengers-corpus.js";
import { canonicalJson, trainAvengersArtifact, writeAvengersArtifact, type AvengersTrainingOptions } from "../src/avengers-training.js";

const options: AvengersTrainingOptions = {
  embeddingModel: "embed/test",
  embeddingDimensions: 2,
  maxInputChars: 16000,
  splitSeed: "seed-1",
  heldOutRatio: 0.4,
  clusters: 2,
  topK: 1,
  beta: 9,
  minObservations: 1,
};

function outcome(paper: string, quality: number, state: AvengersOutcomeV1["terminalState"] = "completed"): AvengersOutcomeV1 {
  return {
    paperModelId: paper,
    runtimeModelId: `provider/${paper.split("/")[1]}`,
    terminalState: state,
    contentTruncated: state === "incomplete",
    quality,
    qualitySource: "deterministic",
  };
}

function example(id: string, group: string, sequence: number, outcomes: AvengersOutcomeV1[]) {
  return {
    id,
    sessionGroupId: group,
    sequence,
    weight: 1,
    text: id,
    sessionState: {
      lifetimeTokens: 1,
      currentTask: { promptTokens: 1, taskTokens: 1, filesTouched: 0, diffHunks: 0, toolDepth: 0, lastUserMessage: id },
    },
    requiredCapabilities: ["text"],
    outcomes,
  };
}

function trainingCorpus(overrides: Partial<AvengersCorpusV1> = {}): AvengersCorpusV1 {
  return parseAvengersCorpus({
    schemaVersion: 1,
    id: "train-corpus",
    synthetic: true,
    candidatePaperModelIds: ["paper/model"],
    routingSnapshot: {
      catalog: {
        fetchedAt: "t",
        source: "cache",
        models: [{ id: "model", runtimeId: "provider/model", codingIndex: 80, blendedPrice: 1, value: 80, windowTokens: 128000, isFree: false }],
      },
      config: {
        tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
        scorer: { weights: { promptTokens: 1, sessionTokens: 0, filesTouched: 0, diffHunks: 0, toolDepth: 0, keywords: 0 }, thresholds: { simpleMax: 0.4, mediumMax: 0.7 } },
        stickiness: { downgradeAfter: 3, upgradeImmediate: true },
        guards: { contextFitMarginTokens: 8000 },
        taskTypeModels: { implement: { prefer: null } },
        providerFreeSet: [],
        windowRegistry: {},
        catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
      },
      prices: { "provider/model": { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
      capabilities: { "provider/model": ["text"] },
      modelMap: { "paper/model": [{ runtimeId: "provider/model", source: "hand" }] },
    },
    examples: [
      example("ex-1", "group-1", 0, [outcome("paper/model", 1)]),
      example("ex-2", "group-13", 0, [outcome("paper/model", 0, "failed")]),
      example("ex-3", "group-13", 1, [outcome("paper/model", 1)]),
      example("ex-4", "group-21", 0, [outcome("paper/model", 0.25)]),
    ],
    ...overrides,
  });
}

function trainVectors(corpus: AvengersCorpusV1, seed = options.splitSeed, ratio = options.heldOutRatio): Map<string, number[]> {
  const split = splitAvengersCorpus(corpus, seed, ratio);
  return new Map(split.train.map((item, index) => [item.id, index % 2 === 0 ? [1, 0] : [0, 1]]));
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trainAvengersArtifact", () => {
  it("produces byte-identical artifacts across repeated runs", () => {
    const corpus = trainingCorpus();
    const vectors = trainVectors(corpus);
    const first = trainAvengersArtifact(corpus, vectors, options);
    const second = trainAvengersArtifact(corpus, vectors, options);
    expect(canonicalJson(first.metadata)).toBe(canonicalJson(second.metadata));
    expect(canonicalJson(first.centers)).toBe(canonicalJson(second.centers));
    expect(canonicalJson(first.clusterModelStats)).toBe(canonicalJson(second.clusterModelStats));
    expect(first.digest).toBe(second.digest);
  });

  it("scores incomplete and failed observations as zero", () => {
    const corpus = trainingCorpus();
    const trained = trainAvengersArtifact(corpus, trainVectors(corpus), { ...options, clusters: 1 });
    const stats = Object.values(trained.clusterModelStats)[0]["paper/model"];
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    expect(stats.qualityMean).toBeLessThan(1);
    expect(stats.completed + stats.failed).toBeLessThanOrEqual(stats.observations);
  });

  it("rejects vector IDs that do not match the derived train partition", () => {
    const corpus = trainingCorpus();
    expect(() => trainAvengersArtifact(corpus, new Map([["missing", [1, 0]]]), options)).toThrow(/vector IDs/);
  });

  it("rejects a cluster count greater than train examples", () => {
    const corpus = trainingCorpus();
    const vectors = trainVectors(corpus);
    expect(() => trainAvengersArtifact(corpus, vectors, { ...options, clusters: 99 })).toThrow(/greater than train/);
  });

  it("normalizes non-unit input vectors", () => {
    const corpus = trainingCorpus();
    const split = splitAvengersCorpus(corpus, options.splitSeed, options.heldOutRatio);
    const vectors = new Map(split.train.map((item, index) => [item.id, index % 2 === 0 ? [3, 0] : [0, 4]]));
    const trained = trainAvengersArtifact(corpus, vectors, options);
    for (const center of trained.centers) {
      const norm = Math.sqrt(center.reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 8);
    }
  });

  it("writes mode-0600 files that reload through loadAvengersProArtifactFiles", () => {
    const corpus = trainingCorpus();
    const trained = trainAvengersArtifact(corpus, trainVectors(corpus), options);
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    dirs.push(dir);
    writeAvengersArtifact(dir, trained);
    expect(statSync(join(dir, "metadata.json")).mode & 0o777).toBe(0o600);
    const loaded = loadAvengersProArtifactFiles(dir);
    expect(loaded.digest).toBe(trained.digest);
    expect(loaded.metadata.synthetic).toBe(true);
  });

  it("regenerates the synthetic fixture through the trainer", () => {
    const corpusPath = fileURLToPath(new URL("../fixtures/phase-4-corpus.v1.json", import.meta.url));
    const corpus = readAvengersCorpus(corpusPath);
    const fixtureOptions: AvengersTrainingOptions = {
      embeddingModel: "fixture",
      embeddingDimensions: 2,
      maxInputChars: 16000,
      splitSeed: "fixture-seed",
      heldOutRatio: 0.34,
      clusters: 2,
      topK: 1,
      beta: 9,
      minObservations: 1,
    };
    const split = splitAvengersCorpus(corpus, fixtureOptions.splitSeed, fixtureOptions.heldOutRatio);
    const vectors = new Map(split.train.map((item, index) => [item.id, index % 2 === 0 ? [1, 0] : [0, 1]]));
    const trained = trainAvengersArtifact(corpus, vectors, fixtureOptions);
    const dir = mkdtempSync(join(tmpdir(), "fixture-regen-"));
    dirs.push(dir);
    writeAvengersArtifact(dir, trained);
    const fixtureDir = fileURLToPath(new URL("../../router-core/artifacts/avengers-pro/fixture", import.meta.url));
    expect(readFileSync(join(dir, "metadata.json"), "utf8")).toBe(readFileSync(join(fixtureDir, "metadata.json"), "utf8"));
    expect(readFileSync(join(dir, "cluster_centers.json"), "utf8")).toBe(readFileSync(join(fixtureDir, "cluster_centers.json"), "utf8"));
    expect(readFileSync(join(dir, "cluster_model_stats.json"), "utf8")).toBe(readFileSync(join(fixtureDir, "cluster_model_stats.json"), "utf8"));
  });
});
