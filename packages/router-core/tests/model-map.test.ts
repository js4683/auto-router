import { describe, expect, it } from "vitest";
import { resolveMappedModels } from "../src/model-map.js";
import type { Catalog } from "../src/types.js";

const catalog: Catalog = {
  fetchedAt: "t",
  source: "live",
  models: [
    { id: "gpt-5.6-sol", runtimeId: "openai/gpt-5.6-sol", codingIndex: 92, blendedPrice: 12, value: 7.6, windowTokens: 272000, isFree: false },
    { id: "muse-spark-1.2-contributor-free", runtimeId: "opencode/muse-spark-1.2-contributor-free", codingIndex: 78, blendedPrice: 0, value: 780, windowTokens: 272000, isFree: true },
  ],
};

const modelMap = {
  "openai/gpt-5-medium": [
    { runtimeId: "openai/gpt-5.6-sol", source: "bench" as const },
    { runtimeId: "opencode/muse-spark-1.2-contributor-free", source: "hand" as const },
  ],
  "qwen/qwen3": [{ runtimeId: "opencode/muse-spark-1.2-contributor-free", source: "hand" as const }],
};

describe("model map", () => {
  it("prefers bench joins over hand aliases for the same paper id", () => {
    const resolved = resolveMappedModels(["openai/gpt-5-medium"], modelMap, catalog);
    expect(resolved[0]).toEqual({ runtimeId: "openai/gpt-5.6-sol", paperId: "openai/gpt-5-medium", source: "bench" });
  });

  it("skips missing runtime ids and continues down the paper ranking", () => {
    const resolved = resolveMappedModels(["missing/model", "qwen/qwen3"], modelMap, catalog);
    expect(resolved.map((r) => r.runtimeId)).toEqual(["opencode/muse-spark-1.2-contributor-free"]);
    expect(resolved[0].source).toBe("hand");
  });
});
