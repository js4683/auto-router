import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeEmbeddingText, type EmbeddingClientConfig } from "@auto-router/router-core";
import { embedCorpusExamples } from "../src/avengers-embedding-cache.js";
import type { AvengersCorpusExampleV1 } from "../src/avengers-corpus.js";

const client: EmbeddingClientConfig = {
  baseUrl: "https://embed.test/v1",
  apiKey: "secret-key",
  model: "embed/test",
  timeoutMs: 500,
};
const maxInputChars = 32;

function example(id: string, text: string): AvengersCorpusExampleV1 {
  return {
    id,
    sessionGroupId: "g",
    sequence: 0,
    weight: 1,
    text,
    sessionState: {
      lifetimeTokens: 1,
      currentTask: { promptTokens: 1, taskTokens: 1, filesTouched: 0, diffHunks: 0, toolDepth: 0, lastUserMessage: text },
    },
    requiredCapabilities: [],
    outcomes: [],
  };
}

function embedResponse(vectors: number[][]): Response {
  return new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }));
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("embedCorpusExamples", () => {
  it("requests only missing or invalidated embeddings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    dirs.push(dir);
    const cachePath = join(dir, "phase-4-embeddings.local.json");
    const examples = [example("a", "one"), example("b", "two")];
    let calls = 0;
    const fetchOnce: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      return embedResponse(body.input.map(() => [1, 0]));
    };
    const first = await embedCorpusExamples(examples, { client, maxInputChars, cachePath, fetchImpl: fetchOnce });
    const failIfCalled: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    const second = await embedCorpusExamples(examples, { client, maxInputChars, cachePath, fetchImpl: failIfCalled });
    expect(second).toEqual(first);
    expect(calls).toBe(1);

    const capture = { inputs: [] as string[] };
    const captureOneCall: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      capture.inputs = body.input;
      return embedResponse([[0, 1]]);
    };
    examples[0].text = "changed";
    const refreshed = await embedCorpusExamples(examples, { client, maxInputChars, cachePath, fetchImpl: captureOneCall });
    expect(refreshed.size).toBe(examples.length);
    expect(capture.inputs).toEqual([normalizeEmbeddingText("changed", maxInputChars)]);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    const cached = readFileSync(cachePath, "utf8");
    expect(cached).not.toContain("secret-key");
    expect(cached).not.toContain("changed");
  });

  it("invalidates the cache when the model changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    dirs.push(dir);
    const cachePath = join(dir, "cache.json");
    const examples = [example("a", "one")];
    await embedCorpusExamples(examples, { client, maxInputChars, cachePath, fetchImpl: async () => embedResponse([[1, 0]]) });
    let called = false;
    await embedCorpusExamples(examples, {
      client: { ...client, model: "embed/other" },
      maxInputChars,
      cachePath,
      fetchImpl: async () => {
        called = true;
        return embedResponse([[0, 1]]);
      },
    });
    expect(called).toBe(true);
  });

  it("rejects duplicate example IDs", async () => {
    await expect(
      embedCorpusExamples([example("a", "one"), example("a", "two")], {
        client,
        maxInputChars,
        cachePath: join(tmpdir(), "unused.json"),
      })
    ).rejects.toThrow(/duplicate/);
  });

  it("rejects a matching-model cache with invalid vectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    dirs.push(dir);
    const cachePath = join(dir, "cache.json");
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, model: "embed/test", dimensions: 2, entries: { a: { inputDigest: "x", vector: [NaN] } } }));
    await expect(embedCorpusExamples([example("a", "one")], { client, maxInputChars, cachePath })).rejects.toThrow(/invalid/);
  });

  it("treats malformed cache JSON as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    dirs.push(dir);
    const cachePath = join(dir, "cache.json");
    writeFileSync(cachePath, "{not-json");
    const result = await embedCorpusExamples([example("a", "one")], {
      client,
      maxInputChars,
      cachePath,
      fetchImpl: async () => embedResponse([[1, 0]]),
    });
    expect(result.get("a")).toEqual([1, 0]);
    expect(existsSync(cachePath)).toBe(true);
  });
});
