import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyManagedBlock, removeManagedBlock } from "../src/managed-block.js";
import { runInstall } from "../src/clients.js";

describe("install", () => {
  it("inserts and removes a managed block without touching surrounding config", () => {
    const before = "keep=1\n";
    const once = applyManagedBlock(before, "FOO=bar\n");
    const twice = applyManagedBlock(once, "FOO=baz\n");
    expect(twice.match(/FOO=/g)).toHaveLength(1);
    expect(twice).toContain("FOO=baz");
    expect(removeManagedBlock(twice)).toBe(before);
  });

  it("writes Claude, Codex, and OpenCode managed files under a fake home", () => {
    const home = mkdtempSync(join(tmpdir(), "ar-install-"));
    const result = runInstall({ home, baseUrl: "http://127.0.0.1:8787", clients: ["claude", "codex", "opencode", "cursor"] });
    const claude = readFileSync(join(home, ".claude/settings.json"), "utf8");
    expect(claude).toContain("http://127.0.0.1:8787");
    expect(claude).toContain("ANTHROPIC_API_KEY");
    expect(claude).toContain("auto-router");
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("auto-router");
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("model_provider = \"auto-router\"");
    expect(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8")).toContain("auto-router");
    expect(result.notes.join("\n")).toMatch(/Cursor/i);
  });

  it("does not delete a Claude base URL the installer did not own", () => {
    const home = mkdtempSync(join(tmpdir(), "ar-install-keep-"));
    const path = join(home, ".claude/settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-user" } }));
    runInstall({ home, baseUrl: "http://127.0.0.1:8787", clients: ["claude"], uninstall: true });
    const env = JSON.parse(readFileSync(path, "utf8")).env;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-user");
  });
});
