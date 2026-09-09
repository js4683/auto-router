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
});
