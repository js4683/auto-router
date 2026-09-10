import { readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_USAGE, mainInstall, parseInstallArgs } from "../src/cli.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "ar-install-cli-"));
}

function io() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value: string) { stdout += value; } },
    stderr: { write(value: string) { stderr += value; } },
    get out() { return stdout; },
    get err() { return stderr; },
  };
}

describe("install CLI", () => {
  it("parses help without creating files", async () => {
    const target = home();
    const output = io();
    expect(parseInstallArgs(["--help"])).toEqual({ help: true });
    await expect(mainInstall(["--help"], output, target)).resolves.toBe(0);
    expect(output.out).toContain(INSTALL_USAGE);
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects unknown, duplicate, missing, and unsafe arguments", () => {
    expect(parseInstallArgs(["--unknown"])).toMatchObject({ error: /unknown flag/ });
    expect(parseInstallArgs(["--claude", "--claude"])).toMatchObject({ error: /duplicate/ });
    expect(parseInstallArgs(["--base-url"])).toMatchObject({ error: /requires a value/ });
    expect(parseInstallArgs(["--base-url", "https://user:pass@example.com"])).toMatchObject({ error: /invalid base URL/ });
  });

  it("keeps selected clients explicit and normalizes the base URL", () => {
    expect(parseInstallArgs(["--claude", "--base-url", "http://127.0.0.1:8787///"])).toEqual({
      clients: ["claude"],
      uninstall: false,
      baseUrl: "http://127.0.0.1:8787",
    });
    expect(parseInstallArgs(["--uninstall"])).toMatchObject({ uninstall: true, clients: ["claude", "codex", "opencode", "cursor"] });
  });

  it("reports parse errors without invoking the installer", async () => {
    const output = io();
    let called = false;
    await expect(mainInstall(["--unknown"], output, home(), () => {
      called = true;
      return { written: [], notes: [] };
    })).resolves.toBe(2);
    expect(called).toBe(false);
    expect(output.err).toContain("unknown flag");
  });
});
