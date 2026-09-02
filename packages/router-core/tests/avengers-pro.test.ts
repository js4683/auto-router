import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAvengersProArtifact, type AvengersProArtifactFiles } from "../src/avengers-pro-artifacts.js";
import { rankAvengersPro, scoreAvengersPro } from "../src/avengers-pro.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/avengers-pro/fixture");

function artifactWithTwoClusters(): AvengersProArtifactFiles {
  return {
    metadata: {
      schemaVersion: 2,
      synthetic: false,
      embeddingModel: "embed/test",
      embeddingDimensions: 2,
      normalizationVersion: "phase4-text-v1",
      maxInputChars: 16_000,
      corpusDigest: "a".repeat(64),
      splitSeed: "split-test-v1",
      heldOutRatio: 0.2,
      algorithmVersion: "deterministic-kmeans-v1",
      nClusters: 2,
      topK: 2,
      beta: 9,
      minObservations: 1,
      availableModels: ["paper/cheap", "paper/frontier"],
    },
    centers: [
      [1, 0],
      [0, 1],
    ],
    clusterModelStats: {
      0: {
        "paper/cheap": { qualityMean: 0.8, completed: 1, failed: 0, observations: 1 },
        "paper/frontier": { qualityMean: 0.9, completed: 1, failed: 0, observations: 1 },
      },
      1: {
        "paper/cheap": { qualityMean: 0.3, completed: 1, failed: 0, observations: 1 },
        "paper/frontier": { qualityMean: 0.6, completed: 1, failed: 0, observations: 1 },
      },
    },
    digest: "c".repeat(64),
  };
}

function artifactWithMissingClusterStat(): AvengersProArtifactFiles {
  const artifact = artifactWithTwoClusters();
  delete artifact.clusterModelStats[0]["paper/cheap"];
  artifact.clusterModelStats[1]["paper/cheap"].qualityMean = 0.8;
  return artifact;
}

describe("avengers-pro inference", () => {
  it("ranks the nearest cluster's top paper model first", async () => {
    const artifacts = loadAvengersProArtifact(fixtureDir);
    const result = await rankAvengersPro("write a cheap unit test", artifacts, async () => [1, 0]);
    expect(result.paperIds[0]).toBe("paper/frontier");
  });

  it("aggregates cluster quality means by top-K softmax probability", () => {
    const prediction = scoreAvengersPro([Math.SQRT1_2, Math.SQRT1_2], artifactWithTwoClusters());
    expect(prediction.paperIds).toEqual(["paper/frontier", "paper/cheap"]);
    expect(prediction.predictedQuality["paper/frontier"]).toBeCloseTo(0.75, 8);
    expect(prediction.predictedQuality["paper/cheap"]).toBeCloseTo(0.55, 8);
  });

  it("renormalizes probability over clusters that observed a model", () => {
    const prediction = scoreAvengersPro([1, 0], artifactWithMissingClusterStat());
    expect(prediction.predictedQuality["paper/cheap"]).toBe(0.8);
  });

  it("omits a model with no observations in the selected clusters", () => {
    const artifact = artifactWithTwoClusters();
    artifact.metadata.topK = 1;
    delete artifact.clusterModelStats[0]["paper/cheap"];
    expect(scoreAvengersPro([1, 0], artifact)).toEqual({
      paperIds: ["paper/frontier"],
      predictedQuality: { "paper/frontier": 0.9 },
    });
  });

  it("uses canonical model ID as the deterministic quality tie-breaker", () => {
    const artifact = artifactWithTwoClusters();
    artifact.clusterModelStats[0]["paper/cheap"].qualityMean = 0.9;
    artifact.clusterModelStats[1]["paper/cheap"].qualityMean = 0.6;
    expect(scoreAvengersPro([Math.SQRT1_2, Math.SQRT1_2], artifact).paperIds).toEqual(["paper/cheap", "paper/frontier"]);
  });

  it("normalizes a finite query vector without overflowing", () => {
    const prediction = scoreAvengersPro([Number.MAX_VALUE, Number.MAX_VALUE], artifactWithTwoClusters());
    expect(prediction.predictedQuality["paper/frontier"]).toBeCloseTo(0.75, 8);
  });

  it.each([
    ["empty", [], "query vector is empty"],
    ["zero", [0, 0], "query vector has zero norm"],
    ["non-finite", [Number.NaN, 0], "query vector contains a non-finite value"],
    ["dimension-mismatched", [1], "query vector dimension does not match artifact"],
    ["over-dimensioned", [1, 0, 0], "query vector dimension does not match artifact"],
  ])("rejects a %s query vector", (_name, vector, message) => {
    expect(() => scoreAvengersPro(vector as number[], artifactWithTwoClusters())).toThrow(message);
  });
});
