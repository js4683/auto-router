import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCredential } from "../src/credentials.js";

describe("resolveCredential", () => {
  it("prefers provider login over env API keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-cred-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth", access: "oauth-token" } }));
    expect(resolveCredential("openai/gpt-4o", { env: { OPENAI_API_KEY: "sk-env" }, authPath })).toBe("oauth-token");
    expect(resolveCredential("openai/gpt-4o", { env: { OPENAI_API_KEY: "sk-env" } })).toBe("sk-env");
  });

  it("does not put tokens in thrown errors", () => {
    expect(resolveCredential("unknown/x", { env: {} })).toBeUndefined();
  });

  it("does not use Google OAuth access tokens for Gemini API calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-cred-g-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ google: { type: "oauth", access: "ya29.token" } }));
    expect(resolveCredential("google/gemini-2.5-flash", { env: {}, authPath })).toBeUndefined();
    expect(resolveCredential("google/gemini-2.5-flash", { env: { GEMINI_API_KEY: "AIza-test" }, authPath })).toBe("AIza-test");
  });
});
