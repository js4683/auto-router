import assert from "node:assert/strict";
import test from "node:test";
import { checkReleaseInventory } from "./check-release-inventory.mjs";

test("allows source, documentation, manifests, and approved fixtures", () => {
  assert.deepEqual(checkReleaseInventory([
    "packages/proxy/src/server.ts",
    "packages/eval/fixtures/phase-4-corpus.v1.json",
    "packages/router-core/artifacts/avengers-pro/fixture/metadata.json",
    "README.md",
  ]), []);
});

test("rejects private and generated evaluation outputs", () => {
  const violations = checkReleaseInventory([
    "private-output.json",
    "phase-4-corpus.local.json",
    "packages/eval/recordings/run.jsonl",
    ".env.production",
  ]);
  assert.equal(violations.length, 4);
  assert.match(violations[0].reason, /private|location/i);
});
