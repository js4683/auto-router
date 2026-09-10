import { describe, expect, it } from "vitest";
import { canonicalDigest, policyDigest } from "../src/digest.js";

describe("routing provenance digests", () => {
  it("is independent of object key order", () => {
    expect(canonicalDigest({ b: 2, a: 1 })).toBe(canonicalDigest({ a: 1, b: 2 }));
  });

  it("derives policy digests from the complete router config", () => {
    expect(policyDigest({ a: 1 } as any)).not.toBe(policyDigest({ a: 2 } as any));
  });
});
