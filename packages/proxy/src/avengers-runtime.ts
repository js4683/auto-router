import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertActivationEligible,
  canonicalDigest,
  embeddingEndpointDigest,
  loadAvengersProArtifact,
  normalizeEmbeddingText,
  policyDigest,
  requestEmbeddings,
  scoreAvengersPro,
  type AvengersProPrediction,
  type Catalog,
  type RouterConfig,
} from "@auto-router/router-core";

export interface AvengersRuntime {
  artifactDigest: string;
  rank(text: string): Promise<AvengersProPrediction>;
}

export interface CreateAvengersRuntimeOptions {
  config: RouterConfig;
  env: NodeJS.ProcessEnv;
  warn: (event: { code: string; artifactDigest?: string; modelId?: string }) => void;
  catalog?: Catalog;
  fetchImpl?: typeof fetch;
}

function resolveExistingPath(path: string): string {
  const candidates = [resolve(path), resolve("..", path), resolve("../..", path)];
  return candidates.find((candidate) => existsSync(candidate)) ?? resolve(path);
}

export function createAvengersRuntime(options: CreateAvengersRuntimeOptions): AvengersRuntime | undefined {
  const settings = options.config.avengersPro;
  if (!settings?.enabled) return undefined;
  try {
    const artifact = loadAvengersProArtifact(resolveExistingPath(settings.artifactDir));
    assertActivationEligible(artifact);
    const embedding = settings.embedding;
    if (!embedding) throw Object.assign(new Error("missing embedding config"), { code: "missing-embedding-config" });
    const apiKey = options.env[embedding.apiKeyEnv];
    if (!apiKey) throw Object.assign(new Error("missing embedding key"), { code: "missing-embedding-key" });
    if (embedding.model !== artifact.metadata.embeddingModel) {
      throw Object.assign(new Error("embedding model mismatch"), { code: "artifact-model-mismatch", modelId: embedding.model });
    }
    if (settings.maxInputChars !== artifact.metadata.maxInputChars) {
      throw Object.assign(new Error("maxInputChars mismatch"), { code: "artifact-bound-mismatch" });
    }
    if (embeddingEndpointDigest(embedding.baseUrl) !== artifact.validation.embeddingEndpointDigest) {
      throw Object.assign(new Error("endpoint digest mismatch"), { code: "endpoint-digest-mismatch" });
    }
    if (artifact.metadata.schemaVersion === 3) {
      if (!options.catalog) throw Object.assign(new Error("missing active catalog"), { code: "missing-active-catalog" });
      if (canonicalDigest(options.catalog) !== artifact.metadata.catalogDigest) {
        throw Object.assign(new Error("catalog digest mismatch"), { code: "catalog-digest-mismatch" });
      }
      if (canonicalDigest(options.config) !== artifact.metadata.configDigest) {
        throw Object.assign(new Error("config digest mismatch"), { code: "config-digest-mismatch" });
      }
      if (policyDigest(options.config) !== artifact.metadata.policyDigest) {
        throw Object.assign(new Error("policy digest mismatch"), { code: "policy-digest-mismatch" });
      }
      if (embeddingEndpointDigest(embedding.baseUrl) !== artifact.metadata.embeddingEndpointDigest) {
        throw Object.assign(new Error("artifact endpoint digest mismatch"), { code: "endpoint-digest-mismatch" });
      }
      if ((embedding.revision ?? "unknown") !== artifact.metadata.embeddingModelRevision) {
        throw Object.assign(new Error("embedding revision mismatch"), { code: "embedding-revision-mismatch" });
      }
    }
    if (artifact.validation.p95EmbeddingLatencyMs > settings.timeoutMs) {
      throw Object.assign(new Error("validated latency exceeds timeout"), { code: "latency-exceeds-timeout" });
    }
    return {
      artifactDigest: artifact.digest,
      async rank(text: string) {
        const vectors = await requestEmbeddings(
          [normalizeEmbeddingText(text, settings.maxInputChars)],
          { baseUrl: embedding.baseUrl, apiKey, model: embedding.model, revision: embedding.revision, timeoutMs: settings.timeoutMs },
          options.fetchImpl
        );
        return scoreAvengersPro(vectors[0], artifact);
      },
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "artifact-ineligible";
    const modelId = error && typeof error === "object" && "modelId" in error ? String((error as { modelId: string }).modelId) : undefined;
    options.warn({ code, ...(modelId ? { modelId } : {}) });
    return undefined;
  }
}
