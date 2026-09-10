import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInstall } from "../src/clients.js";
import { readInstallState } from "../src/install-state.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "ar-install-state-"));
}

describe("installer state", () => {
  it("records ownership and preserves user edits on uninstall", () => {
    const root = home();
    const opencodePath = join(root, ".config/opencode/opencode.json");
    runInstall({ home: root, baseUrl: "http://127.0.0.1:8787", clients: ["opencode"] });
    const installed = JSON.parse(readFileSync(opencodePath, "utf8"));
    installed.provider["auto-router"].options.baseURL = "https://user.example/v1";
    writeFileSync(opencodePath, `${JSON.stringify(installed, null, 2)}\n`);

    runInstall({ home: root, baseUrl: "http://127.0.0.1:8787", clients: ["opencode"], uninstall: true });

    expect(JSON.parse(readFileSync(opencodePath, "utf8")).provider["auto-router"].options.baseURL).toBe("https://user.example/v1");
  });

  it("writes install state with restrictive permissions", () => {
    const root = home();
    runInstall({ home: root, baseUrl: "http://127.0.0.1:8787", clients: ["claude"] });
    const statePath = join(root, ".config/auto-router/install-state.json");
    expect(readInstallState(statePath)?.schemaVersion).toBe(1);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("validates all selected files before writing any target", () => {
    const root = home();
    const claudePath = join(root, ".claude/settings.json");
    const opencodePath = join(root, ".config/opencode/opencode.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(claudePath, "{", { flag: "w", mode: 0o600 });

    expect(() => runInstall({ home: root, baseUrl: "http://127.0.0.1:8787", clients: ["claude", "opencode"] })).toThrow(/json/i);
    expect(existsSync(opencodePath)).toBe(false);
  });

  it("rejects malformed Codex TOML before changing another selected target", () => {
    const root = home();
    const codexPath = join(root, ".codex/config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(codexPath, "[broken\n", { mode: 0o600 });

    expect(() => runInstall({ home: root, baseUrl: "http://127.0.0.1:8787", clients: ["claude", "codex"] })).toThrow(/TOML/i);
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
  });
});
