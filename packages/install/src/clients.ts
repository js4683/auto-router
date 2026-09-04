import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyManagedBlock, removeManagedBlock } from "./managed-block.js";

export type InstallClient = "claude" | "codex" | "opencode" | "cursor";

export interface RunInstallInput {
  home: string;
  baseUrl: string;
  clients: InstallClient[];
  uninstall?: boolean;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function readJson(path: string): Record<string, unknown> {
  const text = readText(path);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function runInstall(input: RunInstallInput): { written: string[]; notes: string[] } {
  const written: string[] = [];
  const notes: string[] = [];
  const base = input.baseUrl.replace(/\/+$/, "");

  if (input.clients.includes("claude")) {
    const path = join(input.home, ".claude/settings.json");
    const json = readJson(path);
    const env = { ...((json.env as Record<string, unknown> | undefined) ?? {}) };
    if (input.uninstall) delete env.ANTHROPIC_BASE_URL;
    else env.ANTHROPIC_BASE_URL = base;
    json.env = env;
    writeText(path, `${JSON.stringify(json, null, 2)}\n`);
    written.push(path);
  }

  if (input.clients.includes("codex")) {
    const path = join(input.home, ".codex/config.toml");
    const block = `[model_providers.auto-router]\nname = "auto-router"\nbase_url = "${base}/v1"\nwire_api = "chat"`;
    const next = input.uninstall ? removeManagedBlock(readText(path)) : applyManagedBlock(readText(path), block);
    writeText(path, next);
    written.push(path);
  }

  if (input.clients.includes("opencode")) {
    const path = join(input.home, ".config/opencode/opencode.json");
    const json = readJson(path);
    const provider = { ...((json.provider as Record<string, unknown> | undefined) ?? {}) };
    if (input.uninstall) delete provider["auto-router"];
    else {
      provider["auto-router"] = {
        npm: "@ai-sdk/anthropic",
        name: "auto-router",
        options: { baseURL: base },
      };
    }
    json.provider = provider;
    writeText(path, `${JSON.stringify(json, null, 2)}\n`);
    written.push(path);
  }

  if (input.clients.includes("cursor")) {
    notes.push(`Cursor: Settings → Models → Override OpenAI Base URL → ${base}/v1`);
  }

  return { written, notes };
}
