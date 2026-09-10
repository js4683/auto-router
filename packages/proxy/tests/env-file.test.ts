import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFile, writeEnvFile } from "../src/env-file.js";

describe("env-file", () => {
  it("merges updates, keeps existing keys, and writes mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-env-"));
    const path = join(dir, ".env");
    writeEnvFile(path, { OPENAI_API_KEY: "sk-old", ANTHROPIC_API_KEY: "sk-ant" });
    writeEnvFile(path, { OPENAI_API_KEY: "sk-new", GEMINI_API_KEY: "" });
    expect(readEnvFile(path)).toEqual({ OPENAI_API_KEY: "sk-new", ANTHROPIC_API_KEY: "sk-ant" });
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    expect(readFileSync(path, "utf8")).not.toMatch(/sk-old/);
  });

  it("persists the configured upstream timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-env-"));
    const path = join(dir, ".env");

    writeEnvFile(path, { AUTO_ROUTER_UPSTREAM_TIMEOUT_MS: "600000" });

    expect(readEnvFile(path)).toMatchObject({ AUTO_ROUTER_UPSTREAM_TIMEOUT_MS: "600000" });
  });

  it("rejects an out-of-range upstream timeout without replacing the valid value", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-env-"));
    const path = join(dir, ".env");

    writeEnvFile(path, { AUTO_ROUTER_UPSTREAM_TIMEOUT_MS: "120000" });

    expect(() => writeEnvFile(path, { AUTO_ROUTER_UPSTREAM_TIMEOUT_MS: "600001" })).toThrow(/upstream timeout/);
    expect(readEnvFile(path)).toMatchObject({ AUTO_ROUTER_UPSTREAM_TIMEOUT_MS: "120000" });
  });

  it("rejects newline-containing values before changing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-env-"));
    const path = join(dir, ".env");
    writeEnvFile(path, { ANTHROPIC_API_KEY: "sk-valid" });

    expect(() => writeEnvFile(path, { ANTHROPIC_API_KEY: "sk-attacker\nOPENAI_API_KEY=sk-injected" })).toThrow(/newline/i);
    expect(readEnvFile(path)).toEqual({ ANTHROPIC_API_KEY: "sk-valid" });
  });

  it("rejects unsafe provider base URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-env-"));
    const path = join(dir, ".env");
    writeEnvFile(path, { OPENAI_BASE_URL: "https://api.openai.com" });

    for (const value of [
      "https://user:pass@example.com/v1",
      "https://example.com/v1?token=secret",
      "https://example.com/v1#secret",
      "http://example.com/v1",
    ]) {
      expect(() => writeEnvFile(path, { OPENAI_BASE_URL: value })).toThrow(/base URL/i);
    }
    expect(readEnvFile(path)).toMatchObject({ OPENAI_BASE_URL: "https://api.openai.com" });
  });
});
