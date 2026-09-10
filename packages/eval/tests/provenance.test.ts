import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalDigest, type EvalProvenance, validateEvalProvenance } from "../src/provenance.js";
import { readDataset, validateLiveProvenance } from "../src/schema.js";

const fixturePath = fileURLToPath(new URL("../fixtures/phase-3-smoke.v1.json", import.meta.url));

function provenanceFor(dataset: ReturnType<typeof readDataset>, origin: EvalProvenance["collectionOrigin"] = "public"): EvalProvenance {
  return {
    schemaVersion: 1,
    collectionOrigin: origin,
    sourceManifestDigest: "a".repeat(64),
    catalogDigest: canonicalDigest(dataset.catalog),
    configDigest: canonicalDigest(dataset.config),
    policyDigest: canonicalDigest(dataset.config),
  };
}

describe("live evaluation provenance", () => {
  it("keeps v1 datasets readable offline but requires provenance for live validation", () => {
    const dataset = readDataset(fixturePath);
    expect(dataset.provenance).toBeUndefined();
    expect(() => validateLiveProvenance(dataset)).toThrow(/provenance/i);
  });

  it("validates catalog, config, policy, and source-manifest digests", () => {
    const dataset = readDataset(fixturePath);
    const withProvenance = { ...dataset, provenance: provenanceFor(dataset) };
    expect(() => validateLiveProvenance(withProvenance)).not.toThrow();

    expect(() => validateLiveProvenance({
      ...withProvenance,
      provenance: { ...withProvenance.provenance, catalogDigest: "b".repeat(64) },
    })).toThrow(/catalog/i);
  });

  it("does not allow synthetic origin to pass as consented production", () => {
    const dataset = readDataset(fixturePath);
    const withProvenance = { ...dataset, provenance: provenanceFor(dataset, "synthetic-fixture") };
    expect(() => validateLiveProvenance(withProvenance)).toThrow(/synthetic/i);
  });

  it("requires synthetic and source-manifest origin metadata to agree", () => {
    const dataset = readDataset(fixturePath);
    expect(() => validateEvalProvenance({
      ...provenanceFor(dataset),
      synthetic: true,
    })).toThrow(/origin/i);
    expect(() => validateEvalProvenance({
      ...provenanceFor(dataset),
      sourceManifestOrigin: "synthetic-fixture",
    })).toThrow(/origin/i);
  });

  it("produces order-independent SHA-256 digests", () => {
    expect(canonicalDigest({ z: 1, a: ["x", { b: true }] })).toBe(canonicalDigest({ a: ["x", { b: true }], z: 1 }));
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
  });

  it("validates optional embedding provenance when present", () => {
    const dataset = readDataset(fixturePath);
    expect(() => validateLiveProvenance({
      ...dataset,
      provenance: { ...provenanceFor(dataset), embeddingEndpointDigest: "not-a-digest" },
    })).toThrow(/embeddingEndpointDigest/i);
  });
});
