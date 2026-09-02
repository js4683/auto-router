import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactDigest,
  type AvengersProArtifactFiles,
  type AvengersProMetadataV2,
  type ClusterModelStat,
} from "@auto-router/router-core";
import { avengersCorpusDigest, splitAvengersCorpus, type AvengersCorpusExampleV1, type AvengersCorpusV1 } from "./avengers-corpus.js";

export interface AvengersTrainingOptions {
  embeddingModel: string;
  embeddingDimensions: number;
  maxInputChars: number;
  splitSeed: string;
  heldOutRatio: number;
  clusters: number;
  topK: number;
  beta: number;
  minObservations: number;
}

export function canonicalJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `  ${stableStringify(item).replace(/\n/g, "\n  ")}`).join(",\n")}\n]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (!keys.length) return "{}";
    const entries = keys.map((key) => `  ${JSON.stringify(key)}: ${stableStringify((value as Record<string, unknown>)[key]).replace(/\n/g, "\n  ")}`);
    return `{\n${entries.join(",\n")}\n}`;
  }
  throw new Error("canonical JSON contains an unsupported value");
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) throw new Error("cannot normalize a zero vector");
  return vector.map((value) => value / norm);
}

function squaredDistance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return sum;
}

function requireVector(example: AvengersCorpusExampleV1, vectors: Map<string, number[]>, dimensions: number): number[] {
  const vector = vectors.get(example.id);
  if (!vector) throw new Error(`missing vector for train example ${example.id}`);
  if (vector.length !== dimensions) throw new Error(`vector dimension does not match training options`);
  if (vector.some((value) => !Number.isFinite(value))) throw new Error(`vector for ${example.id} contains a non-finite value`);
  return l2Normalize(vector);
}

function initializeCenters(train: AvengersCorpusExampleV1[], normalized: Map<string, number[]>, seed: string, clusters: number): number[][] {
  const first = Number(BigInt(`0x${createHash("sha256").update(seed).digest("hex")}`) % BigInt(train.length));
  const centers = [normalized.get(train[first].id)!];
  while (centers.length < clusters) {
    let bestId = "";
    let bestDistance = -1;
    for (const example of train) {
      const vector = normalized.get(example.id)!;
      const nearest = Math.min(...centers.map((center) => squaredDistance(vector, center)));
      if (nearest > bestDistance || (nearest === bestDistance && example.id < bestId)) {
        bestDistance = nearest;
        bestId = example.id;
      }
    }
    centers.push(normalized.get(bestId)!);
  }
  return centers;
}

function assignClusters(train: AvengersCorpusExampleV1[], normalized: Map<string, number[]>, centers: number[][]): number[] {
  const assignments = train.map((example) => {
    const vector = normalized.get(example.id)!;
    let best = 0;
    let bestDistance = squaredDistance(vector, centers[0]);
    for (let index = 1; index < centers.length; index += 1) {
      const distance = squaredDistance(vector, centers[index]);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  });
  const counts = Array.from({ length: centers.length }, () => 0);
  for (const assignment of assignments) counts[assignment] += 1;
  if (counts.some((count) => count === 0)) throw new Error("k-means assignment left an empty cluster");
  return assignments;
}

function recomputeCenters(
  train: AvengersCorpusExampleV1[],
  normalized: Map<string, number[]>,
  assignments: number[],
  clusters: number,
  dimensions: number
): number[][] {
  const sums = Array.from({ length: clusters }, () => Array.from({ length: dimensions }, () => 0));
  const counts = Array.from({ length: clusters }, () => 0);
  const order = train.map((example, index) => ({ example, index })).sort((a, b) => (a.example.id < b.example.id ? -1 : 1));
  for (const { example, index } of order) {
    const cluster = assignments[index];
    const vector = normalized.get(example.id)!;
    counts[cluster] += 1;
    for (let dim = 0; dim < dimensions; dim += 1) sums[cluster][dim] += vector[dim];
  }
  return sums.map((sum, cluster) => l2Normalize(sum.map((value) => value / counts[cluster])));
}

function clusterExamples(train: AvengersCorpusExampleV1[], assignments: number[], cluster: number): AvengersCorpusExampleV1[] {
  return train.filter((_example, index) => assignments[index] === cluster);
}

function modelStats(examples: AvengersCorpusExampleV1[], minObservations: number): Record<string, ClusterModelStat> {
  const byModel = new Map<string, AvengersCorpusExampleV1["outcomes"]>();
  for (const example of examples) {
    for (const outcome of example.outcomes) {
      const list = byModel.get(outcome.paperModelId) ?? [];
      list.push(outcome);
      byModel.set(outcome.paperModelId, list);
    }
  }
  const stats: Record<string, ClusterModelStat> = {};
  for (const [model, outcomes] of [...byModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (outcomes.length < minObservations) continue;
    const completed = outcomes.filter((outcome) => outcome.terminalState === "completed").length;
    const failed = outcomes.filter((outcome) => outcome.terminalState === "failed").length;
    const qualityMean = outcomes.reduce((sum, outcome) => sum + outcome.quality, 0) / outcomes.length;
    stats[model] = { qualityMean, completed, failed, observations: outcomes.length };
  }
  if (!Object.keys(stats).length) throw new Error("cluster has no remaining models");
  return stats;
}

export function trainAvengersArtifact(
  corpus: AvengersCorpusV1,
  vectors: Map<string, number[]>,
  options: AvengersTrainingOptions
): AvengersProArtifactFiles {
  if (options.clusters < 1) throw new Error("clusters must be a positive integer");
  const split = splitAvengersCorpus(corpus, options.splitSeed, options.heldOutRatio);
  const train = [...split.train].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (options.clusters > train.length) throw new Error("cluster count is greater than train examples");
  const trainIds = train.map((example) => example.id);
  const vectorIds = [...vectors.keys()].sort();
  if (trainIds.join("\0") !== vectorIds.join("\0")) throw new Error("vector IDs must equal the derived train partition");

  const normalized = new Map(train.map((example) => [example.id, requireVector(example, vectors, options.embeddingDimensions)]));
  let centers = initializeCenters(train, normalized, options.splitSeed, options.clusters);
  let assignments = assignClusters(train, normalized, centers);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const next = recomputeCenters(train, normalized, assignments, options.clusters, options.embeddingDimensions);
    const moved = next.some((center, index) => squaredDistance(center, centers[index]) > 1e-12);
    centers = next;
    assignments = assignClusters(train, normalized, centers);
    if (!moved) break;
  }

  const clusterModelStats: Record<number, Record<string, ClusterModelStat>> = {};
  const available = new Set<string>();
  for (let cluster = 0; cluster < options.clusters; cluster += 1) {
    const stats = modelStats(clusterExamples(train, assignments, cluster), options.minObservations);
    clusterModelStats[cluster] = stats;
    for (const model of Object.keys(stats)) available.add(model);
  }

  const metadata: AvengersProMetadataV2 = {
    schemaVersion: 2,
    synthetic: corpus.synthetic,
    embeddingModel: options.embeddingModel,
    embeddingDimensions: options.embeddingDimensions,
    normalizationVersion: "phase4-text-v1",
    maxInputChars: options.maxInputChars,
    corpusDigest: avengersCorpusDigest(corpus),
    splitSeed: options.splitSeed,
    heldOutRatio: options.heldOutRatio,
    algorithmVersion: "deterministic-kmeans-v1",
    nClusters: options.clusters,
    topK: options.topK,
    beta: options.beta,
    minObservations: options.minObservations,
    availableModels: [...available].sort(),
  };
  const files = { metadata, centers, clusterModelStats, digest: "" };
  files.digest = artifactDigest(files);
  return files;
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

export function writeAvengersArtifact(dir: string, files: AvengersProArtifactFiles): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "metadata.json"), canonicalJson(files.metadata));
  writeAtomic(join(dir, "cluster_centers.json"), canonicalJson(files.centers));
  writeAtomic(join(dir, "cluster_model_stats.json"), canonicalJson(files.clusterModelStats));
}
