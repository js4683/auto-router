import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactDigest,
  assertActivationEligible,
  loadAvengersProArtifact,
  loadAvengersProArtifactFiles,
  type ArtifactDigestInput,
  type AvengersProMetadataV2,
  type AvengersProValidationV1,
} from "../src/avengers-pro-artifacts.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/avengers-pro/fixture");
const temporaryDirectories: string[] = [];

function metadata(): AvengersProMetadataV2 {
  return {
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
  };
}

function digestInput(): ArtifactDigestInput {
  return {
    metadata: metadata(),
    centers: [
      [1, 0],
      [0, 1],
    ],
    clusterModelStats: {
      0: {
        "paper/cheap": { qualityMean: 0.4, completed: 1, failed: 0, observations: 1 },
        "paper/frontier": { qualityMean: 0.8, completed: 1, failed: 0, observations: 1 },
      },
      1: {
        "paper/cheap": { qualityMean: 0.3, completed: 1, failed: 0, observations: 1 },
        "paper/frontier": { qualityMean: 0.9, completed: 1, failed: 0, observations: 1 },
      },
    },
  };
}

function validation(files: ArtifactDigestInput): AvengersProValidationV1 {
  return {
    schemaVersion: 1,
    artifactDigest: artifactDigest(files),
    embeddingEndpointDigest: "b".repeat(64),
    embeddingTimeoutMs: 400,
    sampleSize: 30,
    p95EmbeddingLatencyMs: 300,
    metrics: {
      qualityRetentionVsFrontier: 0.96,
      costSavingsVsFrontier: 0.5,
      qualityDeltaVsTier0: 0,
      costDeltaVsTier0: 0,
    },
    qualityRetentionConfidenceInterval: {
      lower: 0.95,
      upper: 0.97,
      samples: 10_000,
      seed: "bootstrap-test-v1",
    },
    gates: {
      sampleSize: { passed: true, reason: "enough held-out cases" },
      corpus: { passed: true, reason: "corpus is valid" },
      embedding: { passed: true, reason: "embedding matches" },
      candidateMatrix: { passed: true, reason: "candidate matrix is complete" },
      qualityRetention: { passed: true, reason: "quality retention meets 0.95" },
      costSavings: { passed: true, reason: "cost savings meets 0.50" },
      tier0Quality: { passed: true, reason: "quality is no lower than Tier 0" },
      tier0Cost: { passed: true, reason: "cost is no higher than Tier 0" },
      uncertainty: { passed: true, reason: "seeded interval is present" },
      latency: { passed: true, reason: "p95 is within timeout" },
      requiredCases: { passed: true, reason: "all required cases are complete" },
      synthetic: { passed: true, reason: "artifact is not synthetic" },
    },
    eligible: true,
  };
}

function writeJson(dir: string, filename: string, value: unknown): void {
  writeFileSync(join(dir, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function artifactDir(files = digestInput(), manifest = validation(files)): string {
  const dir = mkdtempSync(join(tmpdir(), "avengers-pro-artifact-"));
  temporaryDirectories.push(dir);
  writeJson(dir, "metadata.json", files.metadata);
  writeJson(dir, "cluster_centers.json", files.centers);
  writeJson(dir, "cluster_model_stats.json", files.clusterModelStats);
  writeJson(dir, "validation.json", manifest);
  return dir;
}

function overwriteJson(dir: string, filename: string, value: unknown): void {
  writeJson(dir, filename, value);
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Avengers-Pro artifact boundary", () => {
  it("loads a digest-bound v2 artifact", () => {
    const artifact = loadAvengersProArtifact(artifactDir());
    expect(artifact.metadata).toMatchObject({
      schemaVersion: 2,
      synthetic: false,
      embeddingModel: "embed/test",
      embeddingDimensions: 2,
      normalizationVersion: "phase4-text-v1",
    });
    expect(artifact.validation.artifactDigest).toBe(artifact.digest);
  });

  it("loads digest inputs without requiring a validation manifest", () => {
    const dir = artifactDir();
    rmSync(join(dir, "validation.json"));
    expect(loadAvengersProArtifactFiles(dir).digest).toBe(artifactDigest(digestInput()));
  });

  it("uses canonical bytes and filename framing for the artifact digest", () => {
    expect(artifactDigest(digestInput())).toBe("832c3e42e9582c767c7f1aa3b4b7f70c8227a26cded69167e149d991d2643bae");

    const reordered = digestInput();
    reordered.clusterModelStats = {
      1: {
        "paper/frontier": reordered.clusterModelStats[1]["paper/frontier"],
        "paper/cheap": reordered.clusterModelStats[1]["paper/cheap"],
      },
      0: {
        "paper/frontier": reordered.clusterModelStats[0]["paper/frontier"],
        "paper/cheap": reordered.clusterModelStats[0]["paper/cheap"],
      },
    };
    expect(artifactDigest(reordered)).toBe("832c3e42e9582c767c7f1aa3b4b7f70c8227a26cded69167e149d991d2643bae");

    reordered.centers.reverse();
    expect(artifactDigest(reordered)).not.toBe("832c3e42e9582c767c7f1aa3b4b7f70c8227a26cded69167e149d991d2643bae");
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s in canonical digest input", (_name, value) => {
    const files = digestInput() as unknown as { metadata: Record<string, unknown> } & ArtifactDigestInput;
    files.metadata.invalid = value;
    expect(() => artifactDigest(files)).toThrow("canonical JSON contains an unsupported value");
  });

  it("rejects cyclic canonical digest input", () => {
    const files = digestInput() as unknown as { metadata: Record<string, unknown> } & ArtifactDigestInput;
    files.metadata.cycle = files.metadata;
    expect(() => artifactDigest(files)).toThrow("canonical JSON contains a cyclic value");
  });

  it("rejects a sparse array as undefined canonical input", () => {
    const files = digestInput() as unknown as { metadata: Record<string, unknown> } & ArtifactDigestInput;
    files.metadata.sparse = new Array(1);
    expect(() => artifactDigest(files)).toThrow("canonical JSON contains an unsupported value");
  });

  it("rejects a validation manifest copied from another artifact", () => {
    const dir = artifactDir();
    overwriteJson(dir, "cluster_centers.json", [
      [0, 1],
      [1, 0],
    ]);
    expect(() => loadAvengersProArtifact(dir)).toThrow("validation artifact digest does not match");
  });

  it.each([
    ["artifact dimensions must be a positive integer", (files: ArtifactDigestInput) => (files.metadata.embeddingDimensions = 0)],
    ["artifact max input characters must be a positive integer", (files: ArtifactDigestInput) => (files.metadata.maxInputChars = 0)],
    ["artifact held-out ratio is out of range", (files: ArtifactDigestInput) => (files.metadata.heldOutRatio = 1)],
    ["artifact cluster count must be a positive integer", (files: ArtifactDigestInput) => (files.metadata.nClusters = 0)],
    ["artifact topK is out of range", (files: ArtifactDigestInput) => (files.metadata.topK = 0)],
    ["artifact beta must be positive and finite", (files: ArtifactDigestInput) => (files.metadata.beta = -1)],
    ["artifact minimum observations must be a positive integer", (files: ArtifactDigestInput) => (files.metadata.minObservations = 0)],
  ])("rejects invalid metadata: %s", (message, mutate) => {
    const files = digestInput();
    mutate(files);
    expect(() => loadAvengersProArtifact(artifactDir(files))).toThrow(message);
  });

  it("rejects unsorted, duplicate, or empty available model IDs", () => {
    for (const ids of [["paper/frontier", "paper/cheap"], ["paper/cheap", "paper/cheap"], ["", "paper/frontier"]]) {
      const files = digestInput();
      files.metadata.availableModels = ids;
      expect(() => loadAvengersProArtifact(artifactDir(files))).toThrow("artifact available models must be sorted unique non-empty IDs");
    }
  });

  it.each([
    ["artifact cluster count does not match metadata", (files: ArtifactDigestInput) => files.centers.pop()],
    ["artifact center dimension does not match metadata", (files: ArtifactDigestInput) => files.centers[0].pop()],
    ["artifact center is not normalized", (files: ArtifactDigestInput) => (files.centers[0] = [0.5, 0.5])],
  ])("rejects invalid centers: %s", (message, mutate) => {
    const files = digestInput();
    mutate(files);
    expect(() => loadAvengersProArtifact(artifactDir(files))).toThrow(message);
  });

  it("rejects a JSON number that parses to a non-finite center value", () => {
    const dir = artifactDir();
    writeFileSync(join(dir, "cluster_centers.json"), "[[1e400, 0], [0, 1]]\n");
    expect(() => loadAvengersProArtifactFiles(dir)).toThrow("artifact center contains a non-finite value");
  });

  it.each([
    ["artifact model quality is out of range", (files: ArtifactDigestInput) => (files.clusterModelStats[0]["paper/cheap"].qualityMean = 1.1)],
    ["artifact model counts must be non-negative integers", (files: ArtifactDigestInput) => (files.clusterModelStats[0]["paper/cheap"].completed = -1)],
    ["artifact completed and failed counts exceed observations", (files: ArtifactDigestInput) => (files.clusterModelStats[0]["paper/cheap"].failed = 1)],
    ["artifact model observations are below the configured minimum", (files: ArtifactDigestInput) => (files.metadata.minObservations = 2)],
    ["artifact cluster must contain at least one model stat", (files: ArtifactDigestInput) => (files.clusterModelStats[0] = {})],
    ["artifact model stat is not in available models", (files: ArtifactDigestInput) => {
      files.clusterModelStats[0]["paper/unknown"] = files.clusterModelStats[0]["paper/cheap"];
    }],
  ])("rejects invalid cluster stats: %s", (message, mutate) => {
    const files = digestInput();
    mutate(files);
    expect(() => loadAvengersProArtifact(artifactDir(files))).toThrow(message);
  });

  it("requires the model-stat union to equal the available models", () => {
    const files = digestInput();
    delete files.clusterModelStats[0]["paper/cheap"];
    delete files.clusterModelStats[1]["paper/cheap"];
    expect(() => loadAvengersProArtifact(artifactDir(files))).toThrow("artifact model stat IDs do not match available models");
  });

  it("requires all and only the validation gate keys", () => {
    const files = digestInput();
    const missing = validation(files);
    delete (missing.gates as Partial<AvengersProValidationV1["gates"]>).corpus;
    expect(() => loadAvengersProArtifact(artifactDir(files, missing))).toThrow("validation gates do not have the exact required keys");

    const extra = validation(files) as AvengersProValidationV1 & { gates: Record<string, { passed: boolean; reason: string }> };
    extra.gates.extra = { passed: true, reason: "not allowed" };
    expect(() => loadAvengersProArtifact(artifactDir(files, extra))).toThrow("validation gates do not have the exact required keys");
  });

  it.each([
    ["sampleSize", (manifest: AvengersProValidationV1) => (manifest.sampleSize = 29)],
    ["qualityRetention", (manifest: AvengersProValidationV1) => (manifest.metrics.qualityRetentionVsFrontier = 0.94)],
    ["costSavings", (manifest: AvengersProValidationV1) => (manifest.metrics.costSavingsVsFrontier = 0.49)],
    ["tier0Quality", (manifest: AvengersProValidationV1) => (manifest.metrics.qualityDeltaVsTier0 = -0.01)],
    ["tier0Cost", (manifest: AvengersProValidationV1) => (manifest.metrics.costDeltaVsTier0 = 0.01)],
    ["uncertainty", (manifest: AvengersProValidationV1) => (manifest.qualityRetentionConfidenceInterval = null)],
    ["latency", (manifest: AvengersProValidationV1) => (manifest.p95EmbeddingLatencyMs = 401)],
  ])("rejects a %s gate that disagrees with its evidence", (gate, mutate) => {
    const files = digestInput();
    const manifest = validation(files);
    mutate(manifest);
    expect(() => loadAvengersProArtifact(artifactDir(files, manifest))).toThrow(`validation ${gate} gate does not match evidence`);
  });

  it("requires aggregate eligibility to equal the conjunction of every gate", () => {
    const files = digestInput();
    const manifest = validation(files);
    manifest.gates.corpus = { passed: false, reason: "corpus evidence failed" };
    expect(() => loadAvengersProArtifact(artifactDir(files, manifest))).toThrow("validation eligibility does not match gates");
  });

  it("rejects an eligible synthetic validation manifest", () => {
    const files = digestInput();
    files.metadata.synthetic = true;
    expect(() => loadAvengersProArtifact(artifactDir(files))).toThrow("synthetic validation cannot be eligible");
  });

  it("loads the synthetic fixture for scoring but never activates it", () => {
    const artifact = loadAvengersProArtifact(fixtureDir);
    expect(artifact.metadata.synthetic).toBe(true);
    expect(artifact.validation.eligible).toBe(false);
    expect(() => assertActivationEligible(artifact)).toThrow("synthetic artifact cannot activate");
  });

  it("does not activate a non-synthetic artifact with a failed gate", () => {
    const files = digestInput();
    const manifest = validation(files);
    manifest.gates.corpus = { passed: false, reason: "corpus evidence failed" };
    manifest.eligible = false;
    const artifact = loadAvengersProArtifact(artifactDir(files, manifest));
    expect(() => assertActivationEligible(artifact)).toThrow("artifact validation is not eligible");
  });
});
