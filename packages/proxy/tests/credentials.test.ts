import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCredential } from "../src/credentials.js";

describe("resolveCredential", () => {
  it("prefers env over OpenCode auth", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-cred-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth", access: "oauth-token" } }));
    expect(resolveCredential("openai/gpt-4o", { env: { OPENAI_API_KEY: "sk-env" }, authPath })).toBe("sk-env");
    expect(resolveCredential("openai/gpt-4o", { env: {}, authPath })).toBe("oauth-token");
  });

  it("does not put tokens in thrown errors", () => {
    expect(resolveCredential("unknown/x", { env: {} })).toBeUndefined();
  });
});
