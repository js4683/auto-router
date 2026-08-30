import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { l2Normalize, loadAvengersProArtifacts, rankAvengersPro, scoreAvengersPro } from "../src/avengers-pro.js";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/avengers-pro/fixture");

describe("avengers-pro inference", () => {
  it("ranks the nearest cluster's top paper model first", async () => {
    const artifacts = loadAvengersProArtifacts(fixtureDir);
    const result = await rankAvengersPro("write a cheap unit test", artifacts, async () => [1, 0]);
    expect(result.paperIds[0]).toBe("qwen/qwen3");
  });

  it("aggregates topK clusters by softmax(-beta * distance)", () => {
    const artifacts = loadAvengersProArtifacts(fixtureDir);
    const scored = scoreAvengersPro(l2Normalize([0.7, 0.7]), { ...artifacts, topK: 2, beta: 9 });
    expect(scored.paperIds.length).toBeGreaterThan(1);
    expect(new Set(scored.paperIds)).toEqual(new Set(["qwen/qwen3", "openai/gpt-5-medium"]));
  });
});
