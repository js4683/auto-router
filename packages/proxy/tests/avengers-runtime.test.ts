import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { artifactDigest, canonicalDigest, embeddingEndpointDigest, policyDigest, type RouterConfig } from "@auto-router/router-core";
import { createAvengersRuntime } from "../src/avengers-runtime.js";

function disabledConfig(): RouterConfig {
  return {
    tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
    scorer: { weights: { promptTokens: 1, sessionTokens: 0, filesTouched: 0, diffHunks: 0, toolDepth: 0, keywords: 0 }, thresholds: { simpleMax: 0.4, mediumMax: 0.7 } },
    stickiness: { downgradeAfter: 3, upgradeImmediate: true },
    guards: { contextFitMarginTokens: 8000 },
    taskTypeModels: { implement: { prefer: null } },
    providerFreeSet: [],
    windowRegistry: {},
    catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
    avengersPro: { enabled: false, artifactDir: "./packages/router-core/artifacts/avengers-pro/fixture", timeoutMs: 400, maxInputChars: 16000 },
  };
}

function enabledFixtureConfig(): RouterConfig {
  return {
    ...disabledConfig(),
    avengersPro: {
      enabled: true,
      artifactDir: "./packages/router-core/artifacts/avengers-pro/fixture",
      embedding: { baseUrl: "https://embed.test/v1", apiKeyEnv: "EMBED_KEY", model: "fixture" },
      timeoutMs: 400,
      maxInputChars: 16000,
    },
  };
}

describe("createAvengersRuntime", () => {
  it("returns no runtime when Tier 1 is disabled", () => {
    const warn = vi.fn();
    expect(createAvengersRuntime({ config: disabledConfig(), env: {}, warn })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a synthetic or ineligible artifact without stopping the proxy", () => {
    const warn = vi.fn();
    const runtime = createAvengersRuntime({ config: enabledFixtureConfig(), env: { EMBED_KEY: "secret" }, warn });
    expect(runtime).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "artifact-ineligible" }));
  });

  it("rejects a provenance-bound artifact when the active catalog changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-runtime-provenance-"));
    const config = enabledFixtureConfig();
    config.avengersPro = { ...config.avengersPro!, artifactDir: dir };
    const catalog = {
      fetchedAt: "fixture",
      source: "cache" as const,
      models: [{ id: "fixture", codingIndex: 80, blendedPrice: 1, value: 80, windowTokens: 128000, isFree: false }],
    };
    const metadata = {
      schemaVersion: 3 as const,
      synthetic: false,
      embeddingModel: "fixture",
      embeddingDimensions: 2,
      normalizationVersion: "phase4-text-v1" as const,
      maxInputChars: 16000,
      corpusDigest: "1".repeat(64),
      splitSeed: "fixture",
      heldOutRatio: 0.4,
      algorithmVersion: "deterministic-kmeans-v1" as const,
      nClusters: 1,
      topK: 1,
      beta: 1,
      minObservations: 1,
      availableModels: ["paper/fixture"],
      embeddingEndpointDigest: embeddingEndpointDigest("https://embed.test/v1"),
      embeddingModelRevision: "unknown",
      catalogDigest: canonicalDigest(catalog),
      configDigest: canonicalDigest(config),
      policyDigest: policyDigest(config),
      sourceManifestDigest: "2".repeat(64),
      collectionOrigin: "public" as const,
    };
    const files = {
      metadata,
      centers: [[1, 0]],
      clusterModelStats: { 0: { "paper/fixture": { qualityMean: 1, completed: 1, failed: 0, observations: 1 } } },
    };
    const validation = {
      schemaVersion: 1,
      artifactDigest: artifactDigest(files),
      embeddingEndpointDigest: metadata.embeddingEndpointDigest,
      embeddingTimeoutMs: 400,
      sampleSize: 30,
      p95EmbeddingLatencyMs: 1,
      metrics: { qualityRetentionVsFrontier: 1, costSavingsVsFrontier: 0.5, qualityDeltaVsTier0: 0, costDeltaVsTier0: 0 },
      qualityRetentionConfidenceInterval: { lower: 0.95, upper: 1, samples: 100, seed: "fixture" },
      gates: {
        sampleSize: { passed: true, reason: "ok" },
        corpus: { passed: true, reason: "ok" },
        embedding: { passed: true, reason: "ok" },
        candidateMatrix: { passed: true, reason: "ok" },
        qualityRetention: { passed: true, reason: "ok" },
        costSavings: { passed: true, reason: "ok" },
        tier0Quality: { passed: true, reason: "ok" },
        tier0Cost: { passed: true, reason: "ok" },
        uncertainty: { passed: true, reason: "ok" },
        latency: { passed: true, reason: "ok" },
        requiredCases: { passed: true, reason: "ok" },
        synthetic: { passed: true, reason: "ok" },
      },
      versionedQuality: {
        gateVersion: 2,
        passed: true,
        reason: "ok",
        lowerBound: 0.95,
        independentGroups: 200,
        cohortResults: { public: { passed: true, lowerBound: 0.95, independentGroups: 100, reason: "ok" } },
      },
      eligible: true,
    };
    writeFileSync(join(dir, "metadata.json"), `${JSON.stringify(metadata)}\n`);
    writeFileSync(join(dir, "cluster_centers.json"), `${JSON.stringify(files.centers)}\n`);
    writeFileSync(join(dir, "cluster_model_stats.json"), `${JSON.stringify(files.clusterModelStats)}\n`);
    writeFileSync(join(dir, "validation.json"), `${JSON.stringify(validation)}\n`);

    const warn = vi.fn();
    try {
      const runtime = createAvengersRuntime({ config, env: { EMBED_KEY: "secret" }, warn, catalog: { ...catalog, models: [] } } as any);
      expect(runtime).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "catalog-digest-mismatch" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
