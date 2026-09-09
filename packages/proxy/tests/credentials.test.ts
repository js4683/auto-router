import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginExpires, resolveCredential } from "../src/credentials.js";

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

  it("resolves Google OAuth access tokens for Antigravity calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-cred-g-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ google: { type: "oauth", access: "ya29.token" } }));
    expect(resolveCredential("google/gemini-2.5-flash", { env: {}, authPath })).toBe("ya29.token");
    expect(resolveCredential("google/gemini-2.5-flash", { env: { GEMINI_API_KEY: "AIza-test" }, authPath })).toBe("AIza-test");
  });

  it("reads login expiry without returning the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-exp-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "tok", expires: 123 } }));
    expect(loginExpires("anthropic", { env: {}, authPath })).toBe(123);
    expect(loginExpires("openai", { env: {}, authPath })).toBeUndefined();
  });
});
