import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const AVENGERS_PRO_ARTIFACT_VERSION = 2 as const;
export const AVENGERS_PRO_ARTIFACT_VERSION_V3 = 3 as const;

export interface AvengersProMetadataV2 {
  schemaVersion: 2;
  synthetic: boolean;
  embeddingModel: string;
  embeddingDimensions: number;
  normalizationVersion: "phase4-text-v1";
  maxInputChars: number;
  corpusDigest: string;
  splitSeed: string;
  heldOutRatio: number;
  algorithmVersion: "deterministic-kmeans-v1";
  nClusters: number;
  topK: number;
  beta: number;
  minObservations: number;
  availableModels: string[];
}

export interface AvengersProMetadataV3 extends Omit<AvengersProMetadataV2, "schemaVersion"> {
  schemaVersion: 3;
  embeddingEndpointDigest: string;
  embeddingModelRevision: string;
  catalogDigest: string;
  configDigest: string;
  policyDigest: string;
  sourceManifestDigest: string;
  collectionOrigin: "public" | "synthetic-fixture" | "consented-production";
}

export type AvengersProMetadata = AvengersProMetadataV2 | AvengersProMetadataV3;

export interface ActivationProvenance {
  sourceManifestDigest: string;
  catalogDigest: string;
  configDigest: string;
  policyDigest: string;
  collectionOrigin: "public" | "synthetic-fixture" | "consented-production";
  embeddingEndpointDigest?: string;
  embeddingModelRevision?: string;
  normalizationVersion?: string;
}

export interface ClusterModelStat {
  qualityMean: number;
  completed: number;
  failed: number;
  observations: number;
}

export interface ArtifactDigestInput {
  metadata: AvengersProMetadata;
  centers: number[][];
  clusterModelStats: Record<number, Record<string, ClusterModelStat>>;
}

export interface AvengersProValidationV1 {
  schemaVersion: 1;
  artifactDigest: string;
  embeddingEndpointDigest: string;
  embeddingTimeoutMs: number;
  sampleSize: number;
  p95EmbeddingLatencyMs: number;
  metrics: {
    qualityRetentionVsFrontier: number | null;
    costSavingsVsFrontier: number | null;
    qualityDeltaVsTier0: number | null;
    costDeltaVsTier0: number | null;
  };
  qualityRetentionConfidenceInterval: {
    lower: number;
    upper: number;
    samples: number;
    seed: string;
  } | null;
  gates: Record<
    | "sampleSize"
    | "corpus"
    | "embedding"
    | "candidateMatrix"
    | "qualityRetention"
    | "costSavings"
    | "tier0Quality"
    | "tier0Cost"
    | "uncertainty"
    | "latency"
    | "requiredCases"
    | "synthetic",
    { passed: boolean; reason: string }
  >;
  versionedQuality?: VersionedQualityGateV2;
  eligible: boolean;
}

export interface VersionedQualityGateV2 {
  gateVersion: 2;
  passed: boolean;
  reason: string;
  lowerBound: number | null;
  independentGroups: number;
  cohortResults: Record<string, { passed: boolean; lowerBound: number | null; independentGroups: number; reason: string }>;
}

export interface AvengersProArtifactFiles extends ArtifactDigestInput {
  digest: string;
}

export interface AvengersProArtifact extends AvengersProArtifactFiles {
  validation: AvengersProValidationV1;
}

type JsonObject = Record<string, unknown>;
type ValidationGateName = keyof AvengersProValidationV1["gates"];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const METADATA_KEYS = [
  "schemaVersion",
  "synthetic",
  "embeddingModel",
  "embeddingDimensions",
  "normalizationVersion",
  "maxInputChars",
  "corpusDigest",
  "splitSeed",
  "heldOutRatio",
  "algorithmVersion",
  "nClusters",
  "topK",
  "beta",
  "minObservations",
  "availableModels",
] as const;
const METADATA_V3_KEYS = [
  ...METADATA_KEYS,
  "embeddingEndpointDigest",
  "embeddingModelRevision",
  "catalogDigest",
  "configDigest",
  "policyDigest",
  "sourceManifestDigest",
  "collectionOrigin",
] as const;
const STAT_KEYS = ["qualityMean", "completed", "failed", "observations"] as const;
const VALIDATION_KEYS = [
  "schemaVersion",
  "artifactDigest",
  "embeddingEndpointDigest",
  "embeddingTimeoutMs",
  "sampleSize",
  "p95EmbeddingLatencyMs",
  "metrics",
  "qualityRetentionConfidenceInterval",
  "gates",
  "eligible",
] as const;
const VERSIONED_VALIDATION_KEYS = [...VALIDATION_KEYS, "versionedQuality"] as const;
const METRIC_KEYS = ["qualityRetentionVsFrontier", "costSavingsVsFrontier", "qualityDeltaVsTier0", "costDeltaVsTier0"] as const;
const CONFIDENCE_INTERVAL_KEYS = ["lower", "upper", "samples", "seed"] as const;
const GATE_KEYS = [
  "sampleSize",
  "corpus",
  "embedding",
  "candidateMatrix",
  "qualityRetention",
  "costSavings",
  "tier0Quality",
  "tier0Cost",
  "uncertainty",
  "latency",
  "requiredCases",
  "synthetic",
] as const satisfies readonly ValidationGateName[];
const GATE_VALUE_KEYS = ["passed", "reason"] as const;
const VERSIONED_QUALITY_KEYS = ["gateVersion", "passed", "reason", "lowerBound", "independentGroups", "cohortResults"] as const;
const VERSIONED_COHORT_KEYS = ["passed", "lowerBound", "independentGroups", "reason"] as const;

function canonicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  return `${canonicalValue(value, 0, new Set<object>())}\n`;
}

function canonicalValue(value: unknown, depth: number, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON contains an unsupported value");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("canonical JSON contains an unsupported value");
  if (ancestors.has(value)) throw new Error("canonical JSON contains a cyclic value");

  ancestors.add(value);
  try {
    return Array.isArray(value) ? canonicalArray(value, depth, ancestors) : canonicalObject(value as JsonObject, depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalArray(values: unknown[], depth: number, ancestors: Set<object>): string {
  if (!values.length) return "[]";
  const indentation = " ".repeat((depth + 1) * 2);
  const items = Array.from(values, (value) => `${indentation}${canonicalValue(value, depth + 1, ancestors)}`);
  return `[\n${items.join(",\n")}\n${" ".repeat(depth * 2)}]`;
}

function canonicalObject(value: JsonObject, depth: number, ancestors: Set<object>): string {
  const keys = Object.keys(value).sort(canonicalCompare);
  if (!keys.length) return "{}";
  const indentation = " ".repeat((depth + 1) * 2);
  const entries = keys.map((key) => `${indentation}${JSON.stringify(key)}: ${canonicalValue(value[key], depth + 1, ancestors)}`);
  return `{\n${entries.join(",\n")}\n${" ".repeat(depth * 2)}}`;
}

export function artifactDigest(files: ArtifactDigestInput): string {
  const hash = createHash("sha256");
  const inputs: Array<[string, unknown]> = [
    ["metadata.json", files.metadata],
    ["cluster_centers.json", files.centers],
    ["cluster_model_stats.json", files.clusterModelStats],
  ];
  for (const [filename, value] of inputs) {
    hash.update(filename);
    hash.update("\0");
    hash.update(canonicalJson(value));
  }
  return hash.digest("hex");
}

function readJson(dir: string, filename: string): unknown {
  return JSON.parse(readFileSync(resolve(dir, filename), "utf8")) as unknown;
}

function exactObject(value: unknown, keys: readonly string[], message: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const actualKeys = Object.keys(value).sort(canonicalCompare);
  const expectedKeys = [...keys].sort(canonicalCompare);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) throw new Error(message);
  return value as JsonObject;
}

function positiveInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(message);
  return value as number;
}

function nonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(message);
  return value as number;
}

function finiteNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(message);
  return value;
}

function sha256(value: unknown, message: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(message);
  return value;
}

function validateMetadataFields(metadata: JsonObject): void {
  if (typeof metadata.synthetic !== "boolean") throw new Error("artifact synthetic flag must be boolean");
  nonEmptyString(metadata.embeddingModel, "artifact embedding model must be non-empty");
  positiveInteger(metadata.embeddingDimensions, "artifact dimensions must be a positive integer");
  if (metadata.normalizationVersion !== "phase4-text-v1") throw new Error("artifact normalization version is unsupported");
  positiveInteger(metadata.maxInputChars, "artifact max input characters must be a positive integer");
  sha256(metadata.corpusDigest, "artifact corpus digest must be lowercase SHA-256");
  nonEmptyString(metadata.splitSeed, "artifact split seed must be non-empty");
  const heldOutRatio = finiteNumber(metadata.heldOutRatio, "artifact held-out ratio is out of range");
  if (heldOutRatio <= 0 || heldOutRatio >= 1) throw new Error("artifact held-out ratio is out of range");
  if (metadata.algorithmVersion !== "deterministic-kmeans-v1") throw new Error("artifact algorithm version is unsupported");
  const nClusters = positiveInteger(metadata.nClusters, "artifact cluster count must be a positive integer");
  const topK = positiveInteger(metadata.topK, "artifact topK is out of range");
  if (topK > nClusters) throw new Error("artifact topK is out of range");
  const beta = finiteNumber(metadata.beta, "artifact beta must be positive and finite");
  if (beta <= 0) throw new Error("artifact beta must be positive and finite");
  positiveInteger(metadata.minObservations, "artifact minimum observations must be a positive integer");
  validateAvailableModels(metadata.availableModels);
}

function validateMetadata(value: unknown): AvengersProMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact metadata does not match schema");
  const raw = value as JsonObject;
  if (raw.schemaVersion === AVENGERS_PRO_ARTIFACT_VERSION) {
    const metadata = exactObject(value, METADATA_KEYS, "artifact metadata does not match schema v2");
    validateMetadataFields(metadata);
    return metadata as unknown as AvengersProMetadataV2;
  }
  if (raw.schemaVersion === AVENGERS_PRO_ARTIFACT_VERSION_V3) {
    const metadata = exactObject(value, METADATA_V3_KEYS, "artifact metadata does not match schema v3");
    validateMetadataFields(metadata);
    for (const field of ["embeddingEndpointDigest", "catalogDigest", "configDigest", "policyDigest", "sourceManifestDigest"] as const) {
      sha256(metadata[field], `artifact ${field} must be lowercase SHA-256`);
    }
    nonEmptyString(metadata.embeddingModelRevision, "artifact embedding model revision must be non-empty");
    if (!["public", "synthetic-fixture", "consented-production"].includes(String(metadata.collectionOrigin))) {
      throw new Error("artifact collection origin is invalid");
    }
    return metadata as unknown as AvengersProMetadataV3;
  }
  throw new Error("artifact schema version must be 2 or 3");
}

function validateAvailableModels(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("artifact available models must be sorted unique non-empty IDs");
  const ids = value as unknown[];
  const valid = ids.every((id, index) => typeof id === "string" && id.length > 0 && (index === 0 || canonicalCompare(ids[index - 1] as string, id) < 0));
  if (!valid) throw new Error("artifact available models must be sorted unique non-empty IDs");
}

function validateCenters(value: unknown, metadata: AvengersProMetadata): number[][] {
  if (!Array.isArray(value) || value.length !== metadata.nClusters) throw new Error("artifact cluster count does not match metadata");
  for (const center of value) validateCenter(center, metadata.embeddingDimensions);
  return value as number[][];
}

function validateCenter(value: unknown, dimensions: number): void {
  if (!Array.isArray(value) || value.length !== dimensions) throw new Error("artifact center dimension does not match metadata");
  if (value.some((item) => typeof item !== "number" || !Number.isFinite(item))) throw new Error("artifact center contains a non-finite value");
  const norm = Math.sqrt((value as number[]).reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-9) throw new Error("artifact center is not normalized");
}

function validateClusterModelStats(value: unknown, metadata: AvengersProMetadata): ArtifactDigestInput["clusterModelStats"] {
  const clusterKeys = Array.from({ length: metadata.nClusters }, (_, index) => String(index));
  const clusters = exactObject(value, clusterKeys, "artifact cluster stats do not match metadata");
  const observedModels = new Set<string>();
  for (let index = 0; index < metadata.nClusters; index += 1) {
    validateClusterStats(clusters[String(index)], metadata, observedModels);
  }
  if (observedModels.size !== metadata.availableModels.length || metadata.availableModels.some((model) => !observedModels.has(model))) {
    throw new Error("artifact model stat IDs do not match available models");
  }
  return clusters as unknown as ArtifactDigestInput["clusterModelStats"];
}

function validateClusterStats(value: unknown, metadata: AvengersProMetadata, observedModels: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("artifact cluster must contain at least one model stat");
  }
  for (const [model, rawStat] of Object.entries(value)) {
    if (!metadata.availableModels.includes(model)) throw new Error("artifact model stat is not in available models");
    validateClusterModelStat(rawStat, metadata.minObservations);
    observedModels.add(model);
  }
}

function validateClusterModelStat(value: unknown, minObservations: number): void {
  const stat = exactObject(value, STAT_KEYS, "artifact model stat does not match schema");
  const quality = finiteNumber(stat.qualityMean, "artifact model quality is out of range");
  if (quality < 0 || quality > 1) throw new Error("artifact model quality is out of range");
  const completed = nonNegativeInteger(stat.completed, "artifact model counts must be non-negative integers");
  const failed = nonNegativeInteger(stat.failed, "artifact model counts must be non-negative integers");
  const observations = nonNegativeInteger(stat.observations, "artifact model counts must be non-negative integers");
  if (completed + failed > observations) throw new Error("artifact completed and failed counts exceed observations");
  if (observations < minObservations) throw new Error("artifact model observations are below the configured minimum");
}

function validateArtifactFiles(metadataValue: unknown, centersValue: unknown, statsValue: unknown): ArtifactDigestInput {
  const metadata = validateMetadata(metadataValue);
  const centers = validateCenters(centersValue, metadata);
  const clusterModelStats = validateClusterModelStats(statsValue, metadata);
  return { metadata, centers, clusterModelStats };
}

export function loadAvengersProArtifactFiles(dir: string): AvengersProArtifactFiles {
  const files = validateArtifactFiles(
    readJson(dir, "metadata.json"),
    readJson(dir, "cluster_centers.json"),
    readJson(dir, "cluster_model_stats.json")
  );
  return { ...files, digest: artifactDigest(files) };
}

function nullableFiniteNumber(value: unknown, message: string): number | null {
  if (value === null) return null;
  return finiteNumber(value, message);
}

function validateMetrics(value: unknown): AvengersProValidationV1["metrics"] {
  const metrics = exactObject(value, METRIC_KEYS, "validation metrics do not match schema");
  nullableFiniteNumber(metrics.qualityRetentionVsFrontier, "validation quality retention must be finite or null");
  nullableFiniteNumber(metrics.costSavingsVsFrontier, "validation cost savings must be finite or null");
  nullableFiniteNumber(metrics.qualityDeltaVsTier0, "validation Tier 0 quality delta must be finite or null");
  nullableFiniteNumber(metrics.costDeltaVsTier0, "validation Tier 0 cost delta must be finite or null");
  return metrics as unknown as AvengersProValidationV1["metrics"];
}

function validateConfidenceInterval(value: unknown): AvengersProValidationV1["qualityRetentionConfidenceInterval"] {
  if (value === null) return null;
  const interval = exactObject(value, CONFIDENCE_INTERVAL_KEYS, "validation confidence interval does not match schema");
  const lower = finiteNumber(interval.lower, "validation confidence bounds must be finite");
  const upper = finiteNumber(interval.upper, "validation confidence bounds must be finite");
  if (lower > upper) throw new Error("validation confidence interval bounds are reversed");
  positiveInteger(interval.samples, "validation confidence samples must be a positive integer");
  nonEmptyString(interval.seed, "validation confidence seed must be non-empty");
  return interval as unknown as AvengersProValidationV1["qualityRetentionConfidenceInterval"];
}

function validateVersionedQuality(value: unknown): VersionedQualityGateV2 {
  const quality = exactObject(value, VERSIONED_QUALITY_KEYS, "validation versioned quality gate does not match schema");
  if (quality.gateVersion !== 2) throw new Error("validation versioned quality gate version must be 2");
  if (typeof quality.passed !== "boolean" || typeof quality.reason !== "string") throw new Error("validation versioned quality gate does not match schema");
  if (quality.lowerBound !== null) {
    const lowerBound = finiteNumber(quality.lowerBound, "validation versioned quality lower bound must be finite or null");
    if (lowerBound < 0) throw new Error("validation versioned quality lower bound is out of range");
  }
  const independentGroups = nonNegativeInteger(quality.independentGroups, "validation versioned quality group count must be non-negative");
  if (!quality.cohortResults || typeof quality.cohortResults !== "object" || Array.isArray(quality.cohortResults)) {
    throw new Error("validation versioned cohort results must be an object");
  }
  const cohortResults = quality.cohortResults as JsonObject;
  const parsedCohortResults: VersionedQualityGateV2["cohortResults"] = {};
  for (const [cohort, raw] of Object.entries(cohortResults)) {
    const result = exactObject(raw, VERSIONED_COHORT_KEYS, `validation versioned cohort ${cohort} does not match schema`);
    if (typeof result.passed !== "boolean" || typeof result.reason !== "string") throw new Error(`validation versioned cohort ${cohort} does not match schema`);
    if (result.lowerBound !== null) {
      const lowerBound = finiteNumber(result.lowerBound, `validation versioned cohort ${cohort} lower bound must be finite or null`);
      if (lowerBound < 0) throw new Error(`validation versioned cohort ${cohort} lower bound is out of range`);
    }
    parsedCohortResults[cohort] = {
      passed: result.passed,
      lowerBound: result.lowerBound as number | null,
      independentGroups: nonNegativeInteger(result.independentGroups, `validation versioned cohort ${cohort} group count must be non-negative`),
      reason: result.reason,
    };
  }
  if (Object.values(parsedCohortResults).some((result) => result.passed && result.lowerBound === null)) {
    throw new Error("passed versioned cohort is missing evidence");
  }
  if (quality.passed && (quality.lowerBound === null || !Object.keys(parsedCohortResults).length || Object.values(parsedCohortResults).some((result) => !result.passed))) {
    throw new Error("passed versioned quality gate is missing evidence");
  }
  return {
    gateVersion: 2,
    passed: quality.passed,
    reason: quality.reason,
    lowerBound: quality.lowerBound as number | null,
    independentGroups,
    cohortResults: parsedCohortResults,
  };
}

function validateGates(value: unknown): AvengersProValidationV1["gates"] {
  const gates = exactObject(value, GATE_KEYS, "validation gates do not have the exact required keys");
  for (const key of GATE_KEYS) {
    const gate = exactObject(gates[key], GATE_VALUE_KEYS, `validation ${key} gate does not match schema`);
    if (typeof gate.passed !== "boolean" || typeof gate.reason !== "string") throw new Error(`validation ${key} gate does not match schema`);
  }
  return gates as unknown as AvengersProValidationV1["gates"];
}

function assertEvidenceGate(gates: AvengersProValidationV1["gates"], name: ValidationGateName, expected: boolean): void {
  if (gates[name].passed !== expected) throw new Error(`validation ${name} gate does not match evidence`);
}

function validateEvidenceGates(validation: AvengersProValidationV1, metadata: AvengersProMetadata): void {
  const metrics = validation.metrics;
  assertEvidenceGate(validation.gates, "sampleSize", validation.sampleSize >= 30);
  assertEvidenceGate(validation.gates, "qualityRetention", metrics.qualityRetentionVsFrontier !== null && metrics.qualityRetentionVsFrontier >= 0.95);
  assertEvidenceGate(validation.gates, "costSavings", metrics.costSavingsVsFrontier !== null && metrics.costSavingsVsFrontier >= 0.5);
  assertEvidenceGate(validation.gates, "tier0Quality", metrics.qualityDeltaVsTier0 !== null && metrics.qualityDeltaVsTier0 >= 0);
  assertEvidenceGate(validation.gates, "tier0Cost", metrics.costDeltaVsTier0 !== null && metrics.costDeltaVsTier0 <= 0);
  assertEvidenceGate(validation.gates, "uncertainty", validation.qualityRetentionConfidenceInterval !== null);
  assertEvidenceGate(validation.gates, "latency", validation.p95EmbeddingLatencyMs <= validation.embeddingTimeoutMs);
  assertEvidenceGate(validation.gates, "synthetic", !metadata.synthetic);
}

function validateValidation(value: unknown, artifact: AvengersProArtifactFiles): AvengersProValidationV1 {
  const valueObject = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : value;
  const hasVersionedQuality = Boolean(valueObject && typeof valueObject === "object" && "versionedQuality" in valueObject);
  const raw = exactObject(value, artifact.metadata.schemaVersion === AVENGERS_PRO_ARTIFACT_VERSION_V3 && hasVersionedQuality ? VERSIONED_VALIDATION_KEYS : VALIDATION_KEYS, "validation manifest does not match schema v1");
  if (raw.schemaVersion !== 1) throw new Error("validation schema version must be 1");
  const manifestDigest = sha256(raw.artifactDigest, "validation artifact digest must be lowercase SHA-256");
  sha256(raw.embeddingEndpointDigest, "validation embedding endpoint digest must be lowercase SHA-256");
  positiveInteger(raw.embeddingTimeoutMs, "validation embedding timeout must be a positive integer");
  nonNegativeInteger(raw.sampleSize, "validation sample size must be a non-negative integer");
  const p95Latency = finiteNumber(raw.p95EmbeddingLatencyMs, "validation p95 embedding latency must be finite and non-negative");
  if (p95Latency < 0) throw new Error("validation p95 embedding latency must be finite and non-negative");
  const metrics = validateMetrics(raw.metrics);
  const qualityRetentionConfidenceInterval = validateConfidenceInterval(raw.qualityRetentionConfidenceInterval);
  const gates = validateGates(raw.gates);
  const versionedQuality = raw.versionedQuality === undefined ? undefined : validateVersionedQuality(raw.versionedQuality);
  if (typeof raw.eligible !== "boolean") throw new Error("validation eligibility must be boolean");
  if (manifestDigest !== artifact.digest) throw new Error("validation artifact digest does not match");

  const validation = { ...raw, metrics, qualityRetentionConfidenceInterval, gates, ...(versionedQuality ? { versionedQuality } : {}) } as unknown as AvengersProValidationV1;
  if (artifact.metadata.synthetic && validation.eligible) throw new Error("synthetic validation cannot be eligible");
  validateEvidenceGates(validation, artifact.metadata);
  const expectedEligibility = GATE_KEYS.every((key) => validation.gates[key].passed)
    && (artifact.metadata.schemaVersion !== AVENGERS_PRO_ARTIFACT_VERSION_V3 || validation.versionedQuality?.passed === true);
  if (validation.eligible !== expectedEligibility) throw new Error("validation eligibility does not match gates");
  return validation;
}

export function loadAvengersProArtifact(dir: string): AvengersProArtifact {
  const artifact = loadAvengersProArtifactFiles(dir);
  const validation = validateValidation(readJson(dir, "validation.json"), artifact);
  return { ...artifact, validation };
}

export function assertActivationEligible(artifact: AvengersProArtifact): void {
  if (artifact.metadata.synthetic) throw new Error("synthetic artifact cannot activate");
  if (!artifact.validation.eligible) throw new Error("artifact validation is not eligible");
  if (artifact.metadata.schemaVersion !== AVENGERS_PRO_ARTIFACT_VERSION_V3) throw new Error("artifact activation requires v3 provenance");
  if (artifact.metadata.collectionOrigin === "synthetic-fixture") throw new Error("synthetic artifact cannot activate");
  if (artifact.metadata.schemaVersion === AVENGERS_PRO_ARTIFACT_VERSION_V3 && artifact.validation.versionedQuality?.passed !== true) {
    throw new Error("artifact versioned quality gate is not eligible");
  }
}

export function assertActivationProvenance(artifact: AvengersProArtifactFiles, expected: ActivationProvenance): void {
  if (artifact.metadata.schemaVersion !== AVENGERS_PRO_ARTIFACT_VERSION_V3) throw new Error("artifact activation requires v3 provenance");
  const metadata = artifact.metadata;
  const fields: Array<keyof ActivationProvenance> = [
    "sourceManifestDigest",
    "catalogDigest",
    "configDigest",
    "policyDigest",
    "collectionOrigin",
  ];
  for (const field of fields) {
    if (metadata[field] !== expected[field]) throw new Error(`artifact ${field} provenance does not match`);
  }
  for (const field of ["embeddingEndpointDigest", "embeddingModelRevision", "normalizationVersion"] as const) {
    if (expected[field] !== undefined && metadata[field] !== expected[field]) throw new Error(`artifact ${field} provenance does not match`);
  }
}
