import { mkdtempSync, readFileSync } from "node:fs";
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
    expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toContain("http://127.0.0.1:8787");
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("auto-router");
    expect(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8")).toContain("auto-router");
    expect(result.notes.join("\n")).toMatch(/Cursor/i);
  });
});
