import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonStore, updateJsonStore, writeJsonStore } from "../src/secure-json-store.js";

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "ar-json-store-")), "state.json");
}

const parseObject = (value: unknown): { value: number } => {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { value?: unknown }).value !== "number") {
    throw new Error("invalid state");
  }
  return value as { value: number };
};

describe("secure json store", () => {
  it("returns undefined only when the store is missing", () => {
    expect(readJsonStore(storePath(), parseObject)).toBeUndefined();
  });

  it("preserves corrupt JSON and reports a validation error", () => {
    const path = storePath();
    writeFileSync(path, "{", { mode: 0o600 });

    expect(() => readJsonStore(path, parseObject)).toThrow(/not valid JSON|invalid state/i);
    expect(readFileSync(path, "utf8")).toBe("{");
  });

  it("writes complete state atomically and tightens existing permissions", () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({ value: 1 }), { mode: 0o644 });

    writeJsonStore(path, { value: 2 });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("retries an update when the source changes during mutation", () => {
    const path = storePath();
    writeJsonStore(path, { value: 1 });
    let mutations = 0;

    updateJsonStore(path, { value: 0 }, parseObject, (current) => {
      mutations += 1;
      if (mutations === 1) writeFileSync(path, JSON.stringify({ value: 10 }), { mode: 0o600 });
      return { value: current.value + 1 };
    });

    expect(mutations).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 11 });
  });

  it("retains both sequential updates to the same store", () => {
    const path = storePath();
    const parseValues = (value: unknown): string[] => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value : (() => { throw new Error("invalid values"); })());
    writeJsonStore(path, []);

    updateJsonStore(path, [], parseValues, (values) => [...values, "first"]);
    updateJsonStore(path, [], parseValues, (values) => [...values, "second"]);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(["first", "second"]);
  });

  it("rejects an update while another writer holds the store lock", () => {
    const path = storePath();
    writeJsonStore(path, { value: 1 });
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockPath, "owner"), `${process.pid}:other\n`, { mode: 0o600 });

    expect(() => updateJsonStore(path, { value: 0 }, parseObject, (current) => ({ value: current.value + 1 }))).toThrow(/concurrent update conflict/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 1 });
  });

  it("fails closed when a lock owner is no longer running", () => {
    const path = storePath();
    writeJsonStore(path, { value: 1 });
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockPath, "owner"), `${Number.MAX_SAFE_INTEGER}:dead\n`, { mode: 0o600 });

    expect(() => updateJsonStore(path, { value: 0 }, parseObject, (current) => ({ value: current.value + 1 }))).toThrow(/concurrent update conflict/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 1 });
  });
});
