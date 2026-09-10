import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { embeddingEndpointDigest, normalizeEmbeddingText, requestEmbeddings, type EmbeddingClientConfig } from "@auto-router/router-core";
import type { AvengersCorpusExampleV1 } from "./avengers-corpus.js";

export interface EmbedCorpusOptions {
  client: EmbeddingClientConfig;
  maxInputChars: number;
  cachePath: string;
  fetchImpl?: typeof fetch;
  modelRevision?: string;
  normalizationVersion?: string;
  corpusDigest?: string;
  sourceManifestDigest?: string;
  provenanceBound?: boolean;
}

interface EmbeddingCacheV1 {
  schemaVersion: 1;
  model: string;
  dimensions: number;
  entries: Record<string, { inputDigest: string; vector: number[] }>;
}

interface EmbeddingCacheV2 {
  schemaVersion: 2;
  cacheKey: string;
  endpointDigest: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalizationVersion: string;
  corpusDigest: string;
  sourceManifestDigest: string;
  entries: Record<string, { inputDigest: string; vector: number[] }>;
}

const MAX_BATCH = 128;
const MAX_BATCH_BYTES = 1024 * 1024;

function inputDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function emptyCache(model: string): EmbeddingCacheV1 {
  return { schemaVersion: 1, model, dimensions: 0, entries: {} };
}

export function cacheKey(input: { endpoint: string; model: string; revision: string; normalization: string }): string {
  return createHash("sha256").update(JSON.stringify({
    endpoint: input.endpoint.replace(/\/+$/, ""),
    model: input.model,
    revision: input.revision,
    normalization: input.normalization,
  })).digest("hex");
}

function cacheBinding(options: EmbedCorpusOptions): Omit<EmbeddingCacheV2, "dimensions" | "entries"> {
  const modelRevision = options.modelRevision ?? options.client.revision ?? "unknown";
  const normalizationVersion = options.normalizationVersion ?? "phase4-text-v1";
  const corpusDigest = options.corpusDigest ?? "unknown";
  const sourceManifestDigest = options.sourceManifestDigest ?? "unknown";
  return {
    schemaVersion: 2,
    cacheKey: cacheKey({
      endpoint: options.client.baseUrl,
      model: options.client.model,
      revision: modelRevision,
      normalization: `${normalizationVersion}:${options.maxInputChars}`,
    }),
    endpointDigest: embeddingEndpointDigest(options.client.baseUrl),
    model: options.client.model,
    modelRevision,
    normalizationVersion,
    corpusDigest,
    sourceManifestDigest,
  };
}

function validateEntries(entries: unknown, dimensions: number): Record<string, { inputDigest: string; vector: number[] }> {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("embedding cache entries are invalid");
  for (const [id, entry] of Object.entries(entries as Record<string, any>)) {
    const candidate = entry as { inputDigest?: unknown; vector?: unknown };
    if (!entry || typeof candidate.inputDigest !== "string" || !Array.isArray(candidate.vector) || candidate.vector.some((value: unknown) => !Number.isFinite(value))) {
      throw new Error(`embedding cache entry ${id} is invalid`);
    }
    if (dimensions > 0 && candidate.vector.length !== dimensions) throw new Error(`embedding cache entry ${id} has inconsistent dimensions`);
  }
  return entries as Record<string, { inputDigest: string; vector: number[] }>;
}

function readCache(path: string, options: EmbedCorpusOptions): EmbeddingCacheV1 | EmbeddingCacheV2 {
  if (!existsSync(path)) return emptyCache(options.client.model);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyCache(options.client.model);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyCache(options.client.model);
  const cache = parsed as Record<string, any>;
  if (cache.schemaVersion === 1) {
    if (options.provenanceBound || cache.model !== options.client.model) return emptyCache(options.client.model);
    return { ...cache, entries: validateEntries(cache.entries, cache.dimensions ?? 0) } as EmbeddingCacheV1;
  }
  const binding = cacheBinding(options);
  if (cache.schemaVersion !== 2 || cache.cacheKey !== binding.cacheKey || cache.endpointDigest !== binding.endpointDigest || cache.model !== binding.model
      || cache.modelRevision !== binding.modelRevision || cache.normalizationVersion !== binding.normalizationVersion
      || cache.corpusDigest !== binding.corpusDigest || cache.sourceManifestDigest !== binding.sourceManifestDigest) {
    return { ...binding, dimensions: 0, entries: {} };
  }
  return { ...cache, entries: validateEntries(cache.entries, cache.dimensions ?? 0) } as EmbeddingCacheV2;
}

function writeCache(path: string, cache: EmbeddingCacheV1 | EmbeddingCacheV2): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const keys = Object.keys(cache.entries).sort();
  const ordered = { ...cache, entries: Object.fromEntries(keys.map((key) => [key, cache.entries[key]])) };
  try {
    writeFileSync(temporary, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
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

export async function embedCorpusExamples(
  examples: AvengersCorpusExampleV1[],
  options: EmbedCorpusOptions
): Promise<Map<string, number[]>> {
  const ids = new Set<string>();
  for (const example of examples) {
    if (ids.has(example.id)) throw new Error(`duplicate example id ${example.id}`);
    ids.add(example.id);
  }
  const ordered = [...examples].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cache = readCache(options.cachePath, options);
  const result = new Map<string, number[]>();
  const misses: AvengersCorpusExampleV1[] = [];

  for (const example of ordered) {
    const digest = inputDigest(normalizeEmbeddingText(example.text, options.maxInputChars));
    const cached = cache.entries[example.id];
    if (cached && cached.inputDigest === digest) {
      result.set(example.id, cached.vector);
    } else {
      misses.push(example);
    }
  }

  let offset = 0;
  while (offset < misses.length) {
    const batch: AvengersCorpusExampleV1[] = [];
    let bytes = 0;
    while (offset < misses.length && batch.length < MAX_BATCH) {
      const next = misses[offset];
      const normalized = normalizeEmbeddingText(next.text, options.maxInputChars);
      const size = Buffer.byteLength(normalized, "utf8");
      if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
      batch.push(next);
      bytes += size;
      offset += 1;
    }
    const vectors = await requestEmbeddings(
      batch.map((example) => normalizeEmbeddingText(example.text, options.maxInputChars)),
      options.client,
      options.fetchImpl
    );
    if (!cache.dimensions) cache.dimensions = vectors[0].length;
    for (const [index, example] of batch.entries()) {
      const vector = vectors[index];
      cache.entries[example.id] = {
        inputDigest: inputDigest(normalizeEmbeddingText(example.text, options.maxInputChars)),
        vector,
      };
      result.set(example.id, vector);
    }
  }

  const outputCache: EmbeddingCacheV1 | EmbeddingCacheV2 = options.provenanceBound
    ? { ...cacheBinding(options), dimensions: cache.dimensions, entries: cache.entries }
    : cache.schemaVersion === 2
      ? cache
      : { ...cacheBinding(options), dimensions: cache.dimensions, entries: cache.entries };
  writeCache(options.cachePath, outputCache);
  return result;
}
