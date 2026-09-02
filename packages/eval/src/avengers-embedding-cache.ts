import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { normalizeEmbeddingText, requestEmbeddings, type EmbeddingClientConfig } from "@auto-router/router-core";
import type { AvengersCorpusExampleV1 } from "./avengers-corpus.js";

export interface EmbedCorpusOptions {
  client: EmbeddingClientConfig;
  maxInputChars: number;
  cachePath: string;
  fetchImpl?: typeof fetch;
}

interface EmbeddingCacheV1 {
  schemaVersion: 1;
  model: string;
  dimensions: number;
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

function readCache(path: string, model: string): EmbeddingCacheV1 {
  if (!existsSync(path)) return emptyCache(model);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyCache(model);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyCache(model);
  const cache = parsed as EmbeddingCacheV1;
  if (cache.schemaVersion !== 1 || cache.model !== model || typeof cache.entries !== "object" || !cache.entries) {
    return emptyCache(model);
  }
  for (const [id, entry] of Object.entries(cache.entries)) {
    if (!entry || typeof entry.inputDigest !== "string" || !Array.isArray(entry.vector) || entry.vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`embedding cache entry ${id} is invalid`);
    }
    if (cache.dimensions > 0 && entry.vector.length !== cache.dimensions) {
      throw new Error(`embedding cache entry ${id} has inconsistent dimensions`);
    }
  }
  return cache;
}

function writeCache(path: string, cache: EmbeddingCacheV1): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const keys = Object.keys(cache.entries).sort();
  const ordered: EmbeddingCacheV1 = {
    schemaVersion: 1,
    model: cache.model,
    dimensions: cache.dimensions,
    entries: Object.fromEntries(keys.map((key) => [key, cache.entries[key]])),
  };
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
  const cache = readCache(options.cachePath, options.client.model);
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

  writeCache(options.cachePath, cache);
  return result;
}
