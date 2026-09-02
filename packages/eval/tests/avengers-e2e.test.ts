import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadAvengersProArtifact, scoreAvengersPro, type EmbeddingClientConfig } from "@auto-router/router-core";
import { readAvengersCorpus, splitAvengersCorpus } from "../src/avengers-corpus.js";
import { embedCorpusExamples } from "../src/avengers-embedding-cache.js";
import { trainAvengersArtifact, writeAvengersArtifact, type AvengersTrainingOptions } from "../src/avengers-training.js";
import { stableAvengersValidationJson, validateAvengersArtifact, writeAvengersValidation } from "../src/avengers-validation.js";

const fixtureCorpusPath = fileURLToPath(new URL("../fixtures/phase-4-corpus.v1.json", import.meta.url));
const fixtureEmbeddingConfig: EmbeddingClientConfig = {
  baseUrl: "https://embed.test/v1",
  apiKey: "fixture-key",
  model: "fixture",
  timeoutMs: 400,
};
const fixtureTrainingOptions: AvengersTrainingOptions = {
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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `phase-4-${label}-`));
  dirs.push(dir);
  return dir;
}

function deterministicEmbeddingFetch(): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(
      JSON.stringify({
        data: inputs.map((text: string, index: number) => ({
          index,
          embedding: String(text).toLowerCase().includes("plan") ? [0, 1] : [1, 0],
        })),
      })
    );
  };
}

function deterministicValidationClock(): () => number {
  let now = 0;
  return () => {
    now += 10;
    return now;
  };
}

function readArtifactBytes(dir: string): Record<string, string> {
  return {
    metadata: readFileSync(join(dir, "metadata.json"), "utf8"),
    centers: readFileSync(join(dir, "cluster_centers.json"), "utf8"),
    stats: readFileSync(join(dir, "cluster_model_stats.json"), "utf8"),
    validation: readFileSync(join(dir, "validation.json"), "utf8"),
  };
}

async function runFixturePipeline(directory: string, fetchImpl: typeof fetch) {
  const corpus = readAvengersCorpus(fixtureCorpusPath);
  const split = splitAvengersCorpus(corpus, "fixture-seed", 0.34);
  const cachePath = join(directory, "phase-4-embeddings.local.json");
  const trainVectors = await embedCorpusExamples(split.train, {
    client: fixtureEmbeddingConfig,
    maxInputChars: 16000,
    cachePath,
    fetchImpl,
  });
  const artifact = trainAvengersArtifact(corpus, trainVectors, fixtureTrainingOptions);
  const artifactDir = join(directory, "artifact");
  writeAvengersArtifact(artifactDir, artifact);
  const report = await validateAvengersArtifact({
    corpus,
    artifact,
    embedding: fixtureEmbeddingConfig,
    bootstrapSeed: "fixture-seed",
    fetchImpl,
    now: deterministicValidationClock(),
  });
  const outputBase = join(directory, "phase-4-validation.local");
  writeAvengersValidation(artifactDir, outputBase, report);
  return {
    artifactDir,
    artifactFiles: readArtifactBytes(artifactDir),
    reportJson: stableAvengersValidationJson(report),
    validation: report.validation,
    prediction: scoreAvengersPro([1, 0], artifact),
  };
}

describe("Phase 4 fixture pipeline", () => {
  it("builds, validates, loads, and scores a deterministic synthetic artifact", async () => {
    const first = await runFixturePipeline(tempDir("first"), deterministicEmbeddingFetch());
    const second = await runFixturePipeline(tempDir("second"), deterministicEmbeddingFetch());

    expect(first.artifactFiles).toEqual(second.artifactFiles);
    expect(first.reportJson).toBe(second.reportJson);
    expect(first.validation.eligible).toBe(false);
    expect(first.validation.gates.synthetic.passed).toBe(false);

    const artifact = loadAvengersProArtifact(first.artifactDir);
    expect(scoreAvengersPro([1, 0], artifact).paperIds[0]).toBe(first.prediction.paperIds[0]);
    expect(JSON.stringify(first.reportJson)).not.toContain("fixture-key");
    expect(JSON.stringify(first.artifactFiles)).not.toContain("https://embed.test");
  });
});
