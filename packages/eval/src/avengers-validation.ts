import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  embeddingEndpointDigest,
  requestEmbeddings,
  scoreAvengersPro,
  type AvengersProArtifactFiles,
  type AvengersProPrediction,
  type AvengersProValidationV1,
  type EmbeddingClientConfig,
  type RouterState,
} from "@auto-router/router-core";
import { avengersCorpusDigest, splitAvengersCorpus, type AvengersCorpusExampleV1, type AvengersCorpusV1 } from "./avengers-corpus.js";
import { bootstrapRetentionInterval, qualityRetained, weightedMean } from "./metrics.js";
import { selectReplayRouterStep } from "./replay.js";
import { modelRuntimeId, selectCheap, selectFrontier } from "./strategies.js";
import type { EvalDatasetV1, EvalTurnV1 } from "./types.js";

export interface ValidateAvengersInput {
  corpus: AvengersCorpusV1;
  artifact: AvengersProArtifactFiles;
  embedding: EmbeddingClientConfig;
  bootstrapSeed: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface AvengersValidationReport {
  schemaVersion: 1;
  artifactDigest: string;
  sampleIds: string[];
  strategies: Record<"tier1" | "tier0" | "always-frontier" | "always-cheap", { quality: number | null; costUsd: number | null }>;
  cases: Array<{
    id: string;
    selectedRuntimeIds: Record<"tier1" | "tier0" | "always-frontier" | "always-cheap", string | null>;
    complete: boolean;
    reasons: string[];
  }>;
  validation: AvengersProValidationV1;
}

type StrategyName = "tier1" | "tier0" | "always-frontier" | "always-cheap";

function gate(passed: boolean, reason: string): { passed: boolean; reason: string } {
  return { passed, reason };
}

function emptyReport(artifact: AvengersProArtifactFiles, extra: Partial<AvengersProValidationV1["gates"]>, sampleIds: string[] = []): AvengersValidationReport {
  const gates: AvengersProValidationV1["gates"] = {
    sampleSize: gate(false, "not evaluated"),
    corpus: gate(true, "corpus digest matches"),
    embedding: gate(true, "embedding model matches"),
    candidateMatrix: gate(false, "not evaluated"),
    qualityRetention: gate(false, "not evaluated"),
    costSavings: gate(false, "not evaluated"),
    tier0Quality: gate(false, "not evaluated"),
    tier0Cost: gate(false, "not evaluated"),
    uncertainty: gate(false, "not evaluated"),
    latency: gate(false, "not evaluated"),
    requiredCases: gate(false, "not evaluated"),
    synthetic: gate(!artifact.metadata.synthetic, artifact.metadata.synthetic ? "artifact is synthetic" : "artifact is not synthetic"),
    ...extra,
  };
  return {
    schemaVersion: 1,
    artifactDigest: artifact.digest,
    sampleIds,
    strategies: {
      tier1: { quality: null, costUsd: null },
      tier0: { quality: null, costUsd: null },
      "always-frontier": { quality: null, costUsd: null },
      "always-cheap": { quality: null, costUsd: null },
    },
    cases: [],
    validation: {
      schemaVersion: 1,
      artifactDigest: artifact.digest,
      embeddingEndpointDigest: "0".repeat(64),
      embeddingTimeoutMs: 400,
      sampleSize: sampleIds.length,
      p95EmbeddingLatencyMs: 0,
      metrics: {
        qualityRetentionVsFrontier: null,
        costSavingsVsFrontier: null,
        qualityDeltaVsTier0: null,
        costDeltaVsTier0: null,
      },
      qualityRetentionConfidenceInterval: null,
      gates,
      eligible: false,
    },
  };
}

function datasetAdapter(corpus: AvengersCorpusV1): EvalDatasetV1 {
  return {
    schemaVersion: 1,
    id: corpus.id,
    description: "avengers validation adapter",
    catalog: corpus.routingSnapshot.catalog,
    config: { ...corpus.routingSnapshot.config, modelMap: corpus.routingSnapshot.modelMap },
    prices: corpus.routingSnapshot.prices,
    capabilities: corpus.routingSnapshot.capabilities,
    sessions: [],
  };
}

function turnAdapter(example: AvengersCorpusExampleV1): EvalTurnV1 {
  return {
    id: example.id,
    sessionState: example.sessionState,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    terminalState: "completed",
    contentTruncated: false,
    requiredCapabilities: example.requiredCapabilities,
    weight: example.weight,
  };
}

function outcomeForRuntime(example: AvengersCorpusExampleV1, runtimeId: string) {
  return example.outcomes.find((outcome) => outcome.runtimeModelId === runtimeId || outcome.paperModelId === runtimeId);
}

function aggregate(values: Array<{ score: number; weight: number }>): number | null {
  return weightedMean(values);
}

export async function validateAvengersArtifact(input: ValidateAvengersInput): Promise<AvengersValidationReport> {
  const digest = avengersCorpusDigest(input.corpus);
  if (digest !== input.artifact.metadata.corpusDigest) {
    return emptyReport(input.artifact, { corpus: gate(false, "artifact corpus digest does not match") });
  }
  if (input.embedding.model !== input.artifact.metadata.embeddingModel) {
    return emptyReport(input.artifact, { embedding: gate(false, "embedding model does not match artifact") });
  }

  const split = splitAvengersCorpus(input.corpus, input.artifact.metadata.splitSeed, input.artifact.metadata.heldOutRatio);
  const heldOut = split.heldOut;
  const sampleIds = heldOut.map((example) => example.id);
  const dataset = datasetAdapter(input.corpus);
  const clock = input.now ?? (() => performance.now());
  const latencies: number[] = [];
  const cases: AvengersValidationReport["cases"] = [];
  const quality: Record<StrategyName, Array<{ score: number; weight: number }>> = {
    tier1: [],
    tier0: [],
    "always-frontier": [],
    "always-cheap": [],
  };
  const cost: Record<StrategyName, Array<{ score: number; weight: number }>> = {
    tier1: [],
    tier0: [],
    "always-frontier": [],
    "always-cheap": [],
  };
  const groups = new Map<string, AvengersCorpusExampleV1[]>();
  for (const example of heldOut) {
    const list = groups.get(example.sessionGroupId) ?? [];
    list.push(example);
    groups.set(example.sessionGroupId, list);
  }

  let network = true;
  for (const group of [...groups.values()].map((items) => items.sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : 1)))) {
    let tier0State: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    let tier1State: RouterState = { currentModel: null, currentTier: null, downgradeCounter: 0 };
    let previousAgent: string | undefined;
    let previousMessage: string | undefined;
    for (const example of group) {
      const reasons: string[] = [];
      const selectedRuntimeIds: AvengersValidationReport["cases"][number]["selectedRuntimeIds"] = {
        tier1: null,
        tier0: null,
        "always-frontier": null,
        "always-cheap": null,
      };
      const turn = turnAdapter(example);
      const missing = input.corpus.candidatePaperModelIds.filter((id) => !example.outcomes.some((outcome) => outcome.paperModelId === id));
      if (missing.length) reasons.push("incomplete candidate matrix");

      let prediction: AvengersProPrediction | undefined;
      if (network) {
        const started = clock();
        try {
          const vectors = await requestEmbeddings([example.text], input.embedding, input.fetchImpl);
          latencies.push(clock() - started);
          if (vectors[0].length !== input.artifact.metadata.embeddingDimensions) {
            reasons.push("embedding dimension mismatch");
          } else {
            prediction = scoreAvengersPro(vectors[0], input.artifact);
          }
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : "embedding request failed");
        }
      }

      try {
        const step0 = selectReplayRouterStep(dataset, turn, tier0State, previousAgent, previousMessage);
        selectedRuntimeIds.tier0 = step0.selection.modelId;
        tier0State = step0.state;
        const step1 = selectReplayRouterStep(dataset, turn, tier1State, previousAgent, previousMessage, prediction);
        selectedRuntimeIds.tier1 = step1.selection.modelId;
        tier1State = step1.state;
        selectedRuntimeIds["always-frontier"] = modelRuntimeId(selectFrontier(dataset, turn));
        selectedRuntimeIds["always-cheap"] = modelRuntimeId(selectCheap(dataset, turn));
        previousAgent = step1.previousAgent;
        previousMessage = step1.previousMessage;
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : "selection failed");
      }

      for (const name of ["tier1", "tier0", "always-frontier", "always-cheap"] as const) {
        const runtimeId = selectedRuntimeIds[name];
        if (!runtimeId) {
          reasons.push(`missing ${name} selection`);
          continue;
        }
        const outcome = outcomeForRuntime(example, runtimeId);
        if (!outcome) {
          reasons.push(`missing selected outcome for ${name}`);
          continue;
        }
        if (outcome.terminalState !== "completed" || outcome.contentTruncated) reasons.push(`${name} outcome is incomplete`);
        if (outcome.costUsd === undefined || !outcome.costSource) reasons.push(`${name} outcome is missing cost provenance`);
        else {
          quality[name].push({ score: outcome.quality, weight: example.weight });
          cost[name].push({ score: outcome.costUsd, weight: example.weight });
        }
      }
      cases.push({ id: example.id, selectedRuntimeIds, complete: reasons.length === 0, reasons });
    }
  }

  const tier1Quality = aggregate(quality.tier1);
  const frontierQuality = aggregate(quality["always-frontier"]);
  const tier0Quality = aggregate(quality.tier0);
  const tier1Cost = aggregate(cost.tier1);
  const frontierCost = aggregate(cost["always-frontier"]);
  const tier0Cost = aggregate(cost.tier0);
  const retention = tier1Quality !== null && frontierQuality !== null ? qualityRetained(tier1Quality, frontierQuality) : null;
  const savings = tier1Cost !== null && frontierCost !== null && frontierCost !== 0 ? 1 - tier1Cost / frontierCost : null;
  const qualityDelta = tier1Quality !== null && tier0Quality !== null ? tier1Quality - tier0Quality : null;
  const costDelta = tier1Cost !== null && tier0Cost !== null ? tier1Cost - tier0Cost : null;
  const interval = quality.tier1.length && quality["always-frontier"].length
    ? bootstrapRetentionInterval(
        quality.tier1.map((item, index) => ({
          routerScore: item.score,
          frontierScore: quality["always-frontier"][index]?.score ?? 0,
          weight: item.weight,
        })),
        input.bootstrapSeed
      )
    : null;
  const sortedLatency = [...latencies].sort((a, b) => a - b);
  const p95 = sortedLatency.length ? sortedLatency[Math.ceil(0.95 * sortedLatency.length) - 1] : 0;
  const requiredCasesPassed = cases.length === sampleIds.length && cases.every((item) => item.complete);
  const gates: AvengersProValidationV1["gates"] = {
    sampleSize: gate(sampleIds.length >= 30, sampleIds.length >= 30 ? "held-out sample is large enough" : "requires at least 30 complete held-out cases"),
    corpus: gate(true, "corpus digest matches"),
    embedding: gate(true, "embedding model matches"),
    candidateMatrix: gate(cases.every((item) => !item.reasons.includes("incomplete candidate matrix")), "candidate matrix complete"),
    qualityRetention: gate(retention !== null && retention >= 0.95, "quality retention vs frontier"),
    costSavings: gate(savings !== null && savings >= 0.5, "cost savings vs frontier"),
    tier0Quality: gate(qualityDelta !== null && qualityDelta >= 0, "quality vs Tier 0"),
    tier0Cost: gate(costDelta !== null && costDelta <= 0, "cost vs Tier 0"),
    uncertainty: gate(interval !== null, interval ? "seeded interval present" : "missing uncertainty evidence"),
    latency: gate(sortedLatency.length > 0 && p95 <= input.embedding.timeoutMs, "p95 embedding latency"),
    requiredCases: gate(requiredCasesPassed, requiredCasesPassed ? "required cases complete" : "required case incomplete"),
    synthetic: gate(!input.artifact.metadata.synthetic, input.artifact.metadata.synthetic ? "artifact is synthetic" : "artifact is not synthetic"),
  };
  const eligible = Object.values(gates).every((item) => item.passed);
  return {
    schemaVersion: 1,
    artifactDigest: input.artifact.digest,
    sampleIds,
    strategies: {
      tier1: { quality: tier1Quality, costUsd: tier1Cost },
      tier0: { quality: tier0Quality, costUsd: tier0Cost },
      "always-frontier": { quality: frontierQuality, costUsd: frontierCost },
      "always-cheap": { quality: aggregate(quality["always-cheap"]), costUsd: aggregate(cost["always-cheap"]) },
    },
    cases,
    validation: {
      schemaVersion: 1,
      artifactDigest: input.artifact.digest,
      embeddingEndpointDigest: embeddingEndpointDigest(input.embedding.baseUrl),
      embeddingTimeoutMs: input.embedding.timeoutMs,
      sampleSize: sampleIds.length,
      p95EmbeddingLatencyMs: p95,
      metrics: {
        qualityRetentionVsFrontier: retention,
        costSavingsVsFrontier: savings,
        qualityDeltaVsTier0: qualityDelta,
        costDeltaVsTier0: costDelta,
      },
      qualityRetentionConfidenceInterval: interval,
      gates,
      eligible,
    },
  };
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

export function stableAvengersValidationJson(report: AvengersValidationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function writeAvengersValidation(artifactDir: string, outputBase: string, report: AvengersValidationReport): void {
  writeAtomic(`${outputBase}.json`, stableAvengersValidationJson(report));
  writeAtomic(`${outputBase}.md`, `# Avengers validation\n\neligible: ${report.validation.eligible}\nsampleSize: ${report.validation.sampleSize}\n`);
  writeAtomic(join(artifactDir, "validation.json"), `${JSON.stringify(report.validation, null, 2)}\n`);
}
