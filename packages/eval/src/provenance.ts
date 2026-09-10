import { canonicalDigest, policyDigest, type RouterConfig } from "@auto-router/router-core";

export { canonicalDigest, policyDigest } from "@auto-router/router-core";

export const PROVENANCE_SCHEMA_VERSION = 1 as const;
export const COLLECTION_ORIGINS = ["public", "synthetic-fixture", "consented-production"] as const;
export type CollectionOrigin = (typeof COLLECTION_ORIGINS)[number];

export interface EvalProvenance {
  schemaVersion: 1;
  collectionOrigin: CollectionOrigin;
  sourceManifestDigest: string;
  catalogDigest: string;
  configDigest: string;
  policyDigest: string;
  embeddingEndpointDigest?: string;
  embeddingModelRevision?: string;
  normalizationVersion?: string;
  sourceManifestOrigin?: CollectionOrigin;
  synthetic?: boolean;
}

export interface EvalSourceManifestRecord {
  id: string;
  sessionGroupId: string;
  sequence: number;
  candidatePaperModelIds: string[];
}

export interface EvalSourceManifest {
  schemaVersion: 1;
  datasetId: string;
  collectionOrigin: CollectionOrigin;
  records: EvalSourceManifestRecord[];
  digest?: string;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createEvalProvenance(
  catalog: unknown,
  config: RouterConfig,
  sourceManifestDigest: string,
  collectionOrigin: CollectionOrigin,
  options: Pick<EvalProvenance, "sourceManifestOrigin" | "synthetic"> = {},
): EvalProvenance {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    collectionOrigin,
    sourceManifestDigest,
    catalogDigest: canonicalDigest(catalog),
    configDigest: canonicalDigest(config),
    policyDigest: policyDigest(config),
    ...options,
  };
}

export function validateEvalProvenance(value: unknown): EvalProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provenance must be an object");
  const provenance = value as Record<string, unknown>;
  if (provenance.schemaVersion !== PROVENANCE_SCHEMA_VERSION) throw new Error("provenance schemaVersion must be 1");
  if (!COLLECTION_ORIGINS.includes(provenance.collectionOrigin as CollectionOrigin)) throw new Error("provenance collectionOrigin is invalid");
  for (const field of ["sourceManifestDigest", "catalogDigest", "configDigest", "policyDigest"] as const) {
    if (!isSha256(provenance[field])) throw new Error(`provenance ${field} must be lowercase SHA-256`);
  }
  for (const field of ["embeddingEndpointDigest"] as const) {
    if (provenance[field] !== undefined && !isSha256(provenance[field])) throw new Error(`provenance ${field} must be lowercase SHA-256`);
  }
  for (const field of ["embeddingModelRevision", "normalizationVersion"] as const) {
    if (provenance[field] !== undefined && (typeof provenance[field] !== "string" || !provenance[field])) {
      throw new Error(`provenance ${field} must be a non-empty string`);
    }
  }
  if (provenance.sourceManifestOrigin !== undefined && !COLLECTION_ORIGINS.includes(provenance.sourceManifestOrigin as CollectionOrigin)) {
    throw new Error("provenance sourceManifestOrigin is invalid");
  }
  if (provenance.synthetic !== undefined && typeof provenance.synthetic !== "boolean") throw new Error("provenance synthetic must be boolean");
  if (provenance.sourceManifestOrigin !== undefined && provenance.sourceManifestOrigin !== provenance.collectionOrigin) {
    throw new Error("provenance sourceManifestOrigin does not match collectionOrigin");
  }
  if (provenance.synthetic !== undefined && provenance.synthetic !== (provenance.collectionOrigin === "synthetic-fixture")) {
    throw new Error("provenance synthetic flag does not match collectionOrigin");
  }
  return provenance as unknown as EvalProvenance;
}

export function sourceManifestDigest(manifest: EvalSourceManifest): string {
  const { digest: _digest, ...withoutDigest } = manifest;
  return canonicalDigest(withoutDigest);
}

export function validateSourceManifest(value: unknown): EvalSourceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source manifest must be an object");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || typeof manifest.datasetId !== "string" || !manifest.datasetId) throw new Error("source manifest is malformed");
  if (!COLLECTION_ORIGINS.includes(manifest.collectionOrigin as CollectionOrigin)) throw new Error("source manifest collectionOrigin is invalid");
  if (!Array.isArray(manifest.records) || !manifest.records.length) throw new Error("source manifest records must not be empty");
  const records = manifest.records.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`source manifest record ${index} is malformed`);
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || typeof record.sessionGroupId !== "string" || !record.sessionGroupId) {
      throw new Error(`source manifest record ${index} is malformed`);
    }
    if (!Number.isInteger(record.sequence) || (record.sequence as number) < 0) throw new Error(`source manifest record ${index} sequence is invalid`);
    if (!Array.isArray(record.candidatePaperModelIds) || record.candidatePaperModelIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`source manifest record ${index} candidates are invalid`);
    }
    return {
      id: record.id,
      sessionGroupId: record.sessionGroupId,
      sequence: record.sequence as number,
      candidatePaperModelIds: [...(record.candidatePaperModelIds as string[])].sort(compareKeys),
    };
  });
  const normalized: EvalSourceManifest = {
    schemaVersion: 1,
    datasetId: manifest.datasetId,
    collectionOrigin: manifest.collectionOrigin as CollectionOrigin,
    records,
  };
  if (manifest.digest !== undefined && manifest.digest !== sourceManifestDigest(normalized)) throw new Error("source manifest digest does not match contents");
  return { ...normalized, ...(manifest.digest !== undefined ? { digest: manifest.digest as string } : {}) };
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
