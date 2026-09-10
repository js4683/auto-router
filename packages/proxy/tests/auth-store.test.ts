import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAuthFile, writeAuthEntry } from "../src/auth-store.js";

function authPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ar-auth-store-")), "auth.json");
}

describe("auth-store", () => {
  it("writes entries atomically and tightens existing permissions", () => {
    const path = authPath();
    writeFileSync(path, JSON.stringify({ existing: { type: "api", key: "sk-old" } }), { mode: 0o644 });

    writeAuthEntry(path, "openai", { type: "api", key: "sk-new" });

    expect(readAuthFile(path)).toEqual({ existing: { type: "api", key: "sk-old" }, openai: { type: "api", key: "sk-new" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("fails closed on corrupt auth state without replacing it", () => {
    const path = authPath();
    writeFileSync(path, "{", { mode: 0o600 });

    expect(() => writeAuthEntry(path, "openai", { type: "api", key: "sk-new" })).toThrow(/not valid JSON/i);
    expect(readFileSync(path, "utf8")).toBe("{");
  });
});
