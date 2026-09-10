import { embeddingEndpointDigest, loadAvengersProArtifactFiles, type EmbeddingClientConfig } from "@auto-router/router-core";
import {
  collectAvengersOutcomes,
  curateAvengersCollection,
  parseAvengersAliases,
  planAvengersCollection,
  readAvengersSourceManifest,
  writeCuratedCorpus,
} from "./avengers-collection.js";
import { avengersCorpusDigest, readAvengersCorpus, splitAvengersCorpus } from "./avengers-corpus.js";
import { embedCorpusExamples } from "./avengers-embedding-cache.js";
import { trainAvengersArtifact, validateAvengersTrainingPlan, writeAvengersArtifact } from "./avengers-training.js";
import { validateAvengersArtifact, writeAvengersValidation } from "./avengers-validation.js";
import type { CliIo, ParsedArgs } from "./cli.js";
import { positiveEnv, requiredEnv, requireValue } from "./cli.js";
import { readDataset } from "./schema.js";

function requireConfirm(parsed: ParsedArgs, command: string): void {
  if (!parsed.flags.has("--confirm-live")) throw new Error(`${command} requires --confirm-live`);
}

function positiveFlag(parsed: ParsedArgs, flag: string): number {
  const value = Number(requireValue(parsed, flag));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be positive`);
  return value;
}

function embeddingConfig(io: CliIo, timeoutMs: number): EmbeddingClientConfig {
  return {
    baseUrl: requiredEnv(io, "AUTO_ROUTER_EMBEDDING_BASE_URL"),
    apiKey: requiredEnv(io, "AUTO_ROUTER_EMBEDDING_API_KEY"),
    model: requiredEnv(io, "AUTO_ROUTER_EMBEDDING_MODEL"),
    timeoutMs,
    revision: io.env.AUTO_ROUTER_EMBEDDING_REVISION ?? "unknown",
  };
}

async function runCollect(parsed: ParsedArgs, io: CliIo): Promise<number> {
  requireConfirm(parsed, "collect-avengers");
  const dataset = readDataset(requireValue(parsed, "--dataset"));
  const aliases = parseAvengersAliases(requireValue(parsed, "--models"));
  const output = requireValue(parsed, "--output");
  const sourceManifest = readAvengersSourceManifest(requireValue(parsed, "--source-manifest"));
  const plan = planAvengersCollection(dataset, aliases);
  io.stdout(`planned calls: ${plan.generationCalls} generation, ${plan.judgeCalls} judge, ${plan.totalCalls} total`);
  await collectAvengersOutcomes(
    dataset,
    aliases,
    {
      baseUrl: requiredEnv(io, "AUTO_ROUTER_EVAL_BASE_URL"),
      apiKey: requiredEnv(io, "AUTO_ROUTER_EVAL_API_KEY"),
      judgeModel: requiredEnv(io, "AUTO_ROUTER_EVAL_JUDGE_MODEL"),
      timeoutMs: positiveEnv(io, "AUTO_ROUTER_EVAL_TIMEOUT_MS", 60_000),
      maxOutputTokens: positiveEnv(io, "AUTO_ROUTER_EVAL_MAX_OUTPUT_TOKENS", 1024),
      retry: {
        maxAttempts: positiveEnv(io, "AUTO_ROUTER_EVAL_RETRY_MAX_ATTEMPTS", 5),
        baseDelayMs: positiveEnv(io, "AUTO_ROUTER_EVAL_RETRY_BASE_DELAY_MS", 1_000),
        maxDelayMs: positiveEnv(io, "AUTO_ROUTER_EVAL_RETRY_MAX_DELAY_MS", 120_000),
      },
    },
    io.fetch ?? fetch,
    output,
    sourceManifest,
  );
  io.stdout(`wrote ${output}`);
  return 0;
}

function runCurate(parsed: ParsedArgs, io: CliIo): number {
  const sourceManifest = readAvengersSourceManifest(requireValue(parsed, "--source-manifest"));
  const corpus = curateAvengersCollection(
    requireValue(parsed, "--input"),
    readDataset(requireValue(parsed, "--dataset")),
    parseAvengersAliases(requireValue(parsed, "--models")),
    sourceManifest,
  );
  const output = requireValue(parsed, "--output");
  writeCuratedCorpus(output, corpus);
  io.stderr("automatic redaction is incomplete; manual review is required before commit");
  io.stdout(`wrote ${output}`);
  return 0;
}

async function runTrain(parsed: ParsedArgs, io: CliIo): Promise<number> {
  requireConfirm(parsed, "train-avengers");
  const corpus = readAvengersCorpus(requireValue(parsed, "--corpus"));
  const options = {
    embeddingModel: requiredEnv(io, "AUTO_ROUTER_EMBEDDING_MODEL"),
    embeddingDimensions: 0,
    maxInputChars: positiveFlag(parsed, "--max-input-chars"),
    splitSeed: requireValue(parsed, "--seed"),
    heldOutRatio: Number(requireValue(parsed, "--held-out-ratio")),
    clusters: positiveFlag(parsed, "--clusters"),
    topK: positiveFlag(parsed, "--top-k"),
    beta: positiveFlag(parsed, "--beta"),
    minObservations: positiveFlag(parsed, "--min-observations"),
  };
  validateAvengersTrainingPlan(corpus, options);
  if (!corpus.provenance) throw new Error("training requires dataset provenance");
  const split = splitAvengersCorpus(corpus, options.splitSeed, options.heldOutRatio);
  const cachePath = requireValue(parsed, "--cache");
  io.stdout(`planned embeddings: ${split.train.length} train examples`);
  const embedding = embeddingConfig(io, positiveFlag(parsed, "--timeout-ms"));
  const vectors = await embedCorpusExamples(split.train, {
    client: embedding,
    maxInputChars: options.maxInputChars,
    cachePath,
    fetchImpl: io.fetch,
    modelRevision: embedding.revision,
    corpusDigest: avengersCorpusDigest(corpus),
    sourceManifestDigest: corpus.provenance.sourceManifestDigest,
    provenanceBound: true,
  });
  const first = vectors.values().next().value;
  if (!first) throw new Error("training produced no vectors");
  options.embeddingDimensions = first.length;
   const artifact = trainAvengersArtifact(corpus, vectors, {
     ...options,
     provenance: {
       embeddingEndpointDigest: embeddingEndpointDigest(embedding.baseUrl),
       embeddingModelRevision: embedding.revision ?? "unknown",
       catalogDigest: corpus.provenance.catalogDigest,
       configDigest: corpus.provenance.configDigest,
       policyDigest: corpus.provenance.policyDigest,
       sourceManifestDigest: corpus.provenance.sourceManifestDigest,
       collectionOrigin: corpus.provenance.collectionOrigin,
     },
   });
  const artifactDir = requireValue(parsed, "--artifact-dir");
  writeAvengersArtifact(artifactDir, artifact);
  io.stdout(`wrote ${artifactDir}`);
  return 0;
}

async function runValidate(parsed: ParsedArgs, io: CliIo): Promise<number> {
  requireConfirm(parsed, "validate-avengers");
  const corpus = readAvengersCorpus(requireValue(parsed, "--corpus"));
  const artifactDir = requireValue(parsed, "--artifact-dir");
  const artifact = loadAvengersProArtifactFiles(artifactDir);
  const timeoutMs = positiveFlag(parsed, "--timeout-ms");
  io.stdout(`planned embeddings: held-out single-item requests`);
  const report = await validateAvengersArtifact({
    corpus,
    artifact,
    embedding: embeddingConfig(io, timeoutMs),
    bootstrapSeed: requireValue(parsed, "--bootstrap-seed"),
    fetchImpl: io.fetch,
  });
  writeAvengersValidation(artifactDir, requireValue(parsed, "--output"), report);
  if (!report.validation.eligible) {
    io.stderr("validation artifact is ineligible");
    return 1;
  }
  return 0;
}

export async function runAvengersCommand(parsed: ParsedArgs, io: CliIo): Promise<number | undefined> {
  if (parsed.command === "collect-avengers") return runCollect(parsed, io);
  if (parsed.command === "curate-avengers") return runCurate(parsed, io);
  if (parsed.command === "train-avengers") return runTrain(parsed, io);
  if (parsed.command === "validate-avengers") return runValidate(parsed, io);
  return undefined;
}
