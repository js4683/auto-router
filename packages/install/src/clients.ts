import { Buffer } from "node:buffer";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteText,
  digestText,
  readInstallState,
  type InstallState,
  type InstallStateTarget,
  writeInstallState,
} from "./install-state.js";
import { removeCodexProvider, upsertCodexProvider } from "./managed-block.js";

export type InstallClient = "claude" | "codex" | "opencode" | "cursor";

export interface RunInstallInput {
  home: string;
  baseUrl: string;
  clients: InstallClient[];
  uninstall?: boolean;
}

interface FilePlan {
  client: InstallClient;
  path: string;
  before?: string;
  after?: string;
  state?: InstallStateTarget;
}

interface JsonRecord {
  [key: string]: unknown;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function parseRecord(text: string | undefined, path: string): JsonRecord {
  if (text === undefined || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} contains invalid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as JsonRecord;
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        result += character;
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      result += character;
    }
  }
  return result.replace(/,\s*([}\]])/g, "$1");
}

function parseJsoncRecord(text: string | undefined, path: string): JsonRecord {
  if (text === undefined || !text.trim()) return {};
  try {
    const parsed = JSON.parse(stripJsonComments(text));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must contain a JSON object");
    return parsed as JsonRecord;
  } catch (error) {
    throw new Error(`${path} contains invalid JSONC`, { cause: error });
  }
}

function withoutTomlComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function bracketDelta(value: string): number {
  let delta = 0;
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if ("[{".includes(character)) delta += 1;
    else if ("]}".includes(character)) delta -= 1;
  }
  if (quote) throw new Error("unterminated TOML string");
  return delta;
}

function validateToml(text: string, path: string): void {
  let valueDepth = 0;
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = withoutTomlComment(rawLine).trim();
    if (!line) continue;
    if (valueDepth > 0) {
      valueDepth += bracketDelta(line);
      if (valueDepth < 0) throw new Error(`${path} contains invalid TOML`);
      continue;
    }
    if (line.startsWith("[") || line.endsWith("]")) {
      if (!/^\[\[?[^\[\]]+\]\]?$/.test(line)) throw new Error(`${path} contains invalid TOML table syntax`);
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0 || !line.slice(0, equals).trim() || !line.slice(equals + 1).trim()) {
      throw new Error(`${path} contains invalid TOML assignment`);
    }
    valueDepth = bracketDelta(line.slice(equals + 1).trim());
    if (valueDepth < 0) throw new Error(`${path} contains invalid TOML value`);
  }
  if (valueDepth !== 0) throw new Error(`${path} contains an incomplete TOML value`);
}

function objectValue(value: unknown, path: string): JsonRecord {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be a JSON object`);
  return value as JsonRecord;
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function encodeBefore(text: string | undefined): string | null {
  return text === undefined ? null : Buffer.from(text, "utf8").toString("base64");
}

function decodeBefore(value: string | null): string | undefined {
  return value === null ? undefined : Buffer.from(value, "base64").toString("utf8");
}

function restoreSnapshot(before: string | undefined, previous: InstallStateTarget | undefined): { restored: boolean; after?: string } {
  if (!previous || before === undefined || digestText(before) !== previous.installedDigest) return { restored: false };
  const after = decodeBefore(previous.beforeBase64);
  const digest = after === undefined ? null : digestText(after);
  return digest === previous.beforeDigest ? { restored: true, after } : { restored: false };
}

function rememberTarget(before: string | undefined, after: string, previous: InstallStateTarget | undefined, ownedKeys: string[], ownedValues: Record<string, string>): InstallStateTarget {
  return {
    beforeBase64: previous?.beforeBase64 ?? encodeBefore(before),
    beforeDigest: previous?.beforeDigest ?? (before === undefined ? null : digestText(before)),
    installedDigest: digestText(after),
    ownedKeys,
    ownedValues,
  };
}

function formatJson(value: JsonRecord): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function planClaude(path: string, baseUrl: string, previous: InstallStateTarget | undefined, uninstall: boolean): FilePlan {
  const before = readOptional(path);
  if (uninstall && before === undefined) return { client: "claude", path, before, after: undefined };
  const restored = uninstall ? restoreSnapshot(before, previous) : { restored: false };
  if (restored.restored) return { client: "claude", path, before, after: restored.after };
  const json = parseRecord(before, path);
  const env = objectValue(json.env, `${path}.env`);
  const ownedValues: Record<string, string> = {
    baseUrl: uninstall ? previous?.ownedValues?.baseUrl ?? baseUrl : baseUrl,
    apiKey: "auto-router",
  };
  if (uninstall) {
    if (env.ANTHROPIC_BASE_URL === ownedValues.baseUrl) delete env.ANTHROPIC_BASE_URL;
    if (env.ANTHROPIC_API_KEY === ownedValues.apiKey) delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_BASE_URL = baseUrl;
    if (!env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = ownedValues.apiKey;
  }
  if (Object.keys(env).length) json.env = env;
  else delete json.env;
  const after = formatJson(json);
  return { client: "claude", path, before, after, state: rememberTarget(before, after, previous, ["env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_API_KEY"], ownedValues) };
}

function planCodex(path: string, baseUrl: string, previous: InstallStateTarget | undefined, uninstall: boolean): FilePlan {
  const before = readOptional(path);
  if (uninstall && before === undefined) return { client: "codex", path, before, after: undefined };
  const restored = uninstall ? restoreSnapshot(before, previous) : { restored: false };
  if (restored.restored) return { client: "codex", path, before, after: restored.after };
  validateToml(before ?? "", path);
  const after = uninstall
    ? (previous ? removeCodexProvider(before ?? "", previous, baseUrl) : before ?? "")
    : upsertCodexProvider(before ?? "", baseUrl);
  const state = uninstall ? undefined : rememberTarget(before, after, previous, ["model_provider", "model_providers.auto-router"], { baseUrl: `${baseUrl}/v1` });
  return { client: "codex", path, before, after, state };
}

function planOpenCode(path: string, jsoncPath: string, baseUrl: string, previous: InstallStateTarget | undefined, uninstall: boolean, notes: string[]): FilePlan {
  const before = readOptional(path);
  if (uninstall && before === undefined) return { client: "opencode", path, before, after: undefined };
  const restored = uninstall ? restoreSnapshot(before, previous) : { restored: false };
  if (restored.restored) return { client: "opencode", path, before, after: restored.after };
  const jsonc = readOptional(jsoncPath);
  parseJsoncRecord(jsonc, jsoncPath);
  const json = parseRecord(before, path);
  const provider = objectValue(json.provider, `${path}.provider`);
  const ownedProvider = {
    npm: "@ai-sdk/anthropic",
    name: "auto-router",
    options: { baseURL: `${baseUrl}/v1`, apiKey: "auto-router" },
    models: { auto: { name: "Auto Router" } },
  };
  if (uninstall) {
    if (JSON.stringify(provider["auto-router"]) === JSON.stringify(previous?.ownedValues?.provider)) delete provider["auto-router"];
  } else {
    provider["auto-router"] = ownedProvider;
  }
  if (Object.keys(provider).length) json.provider = provider;
  else delete json.provider;
  if (jsonc?.includes('"provider"') && !jsonc.includes('"auto-router"')) {
    notes.push(`Also add auto-router to ${jsoncPath} (OpenCode loads jsonc after json).`);
  }
  const after = formatJson(json);
  const state = uninstall ? undefined : rememberTarget(before, after, previous, ["provider.auto-router"], { provider: JSON.stringify(ownedProvider) });
  return { client: "opencode", path, before, after, state };
}

function targetPath(home: string, client: InstallClient): string | undefined {
  if (client === "claude") return join(home, ".claude/settings.json");
  if (client === "codex") return join(home, ".codex/config.toml");
  if (client === "opencode") return join(home, ".config/opencode/opencode.json");
  return undefined;
}

function restorePlan(plan: FilePlan): void {
  if (plan.before === undefined) {
    try {
      unlinkSync(plan.path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return;
  }
  atomicWriteText(plan.path, plan.before);
}

function restoreState(path: string, previous: InstallState | undefined): void {
  if (previous) {
    writeInstallState(path, previous);
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function applyPlan(plan: FilePlan): void {
  if (plan.after === undefined) {
    try {
      unlinkSync(plan.path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return;
  }
  if (sameText(plan.before, plan.after)) return;
  atomicWriteText(plan.path, plan.after);
}

function validateBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error("base URL must be an http(s) URL without credentials, query, or fragment");
  }
  return normalized;
}

function selectedClients(clients: InstallClient[]): InstallClient[] {
  return [...new Set(clients)];
}

export function runInstall(input: RunInstallInput): { written: string[]; notes: string[] } {
  const written: string[] = [];
  const notes: string[] = [];
  const base = validateBaseUrl(input.baseUrl);
  const statePath = join(input.home, ".config/auto-router/install-state.json");
  const previousState = readInstallState(statePath);
  const clients = selectedClients(input.clients);
  const plans: FilePlan[] = [];

  for (const client of clients) {
    if (client === "cursor") {
      notes.push(`Cursor: Settings → Models → Override OpenAI Base URL → ${base}/v1`);
      continue;
    }
    const path = targetPath(input.home, client);
    if (!path) continue;
    const previous = previousState?.targets[path];
    if (input.uninstall && !previous) continue;
    if (client === "claude") plans.push(planClaude(path, base, previous, Boolean(input.uninstall)));
    if (client === "codex") plans.push(planCodex(path, base, previous, Boolean(input.uninstall)));
    if (client === "opencode") plans.push(planOpenCode(path, join(input.home, ".config/opencode/opencode.jsonc"), base, previous, Boolean(input.uninstall), notes));
  }

  const nextState: InstallState = {
    schemaVersion: 1,
    targets: { ...(previousState?.targets ?? {}) },
  };
  for (const plan of plans) {
    if (input.uninstall) delete nextState.targets[plan.path];
    else if (plan.state) nextState.targets[plan.path] = plan.state;
  }

  const applied: FilePlan[] = [];
  const shouldWriteState = plans.length > 0 && (Object.keys(nextState.targets).length > 0 || existsSync(statePath));
  try {
    if (shouldWriteState) {
      writeInstallState(statePath, nextState);
      written.push(statePath);
    }
    for (const plan of plans) {
      applied.push(plan);
      applyPlan(plan);
      if (!sameText(plan.before, plan.after)) {
        written.push(plan.path);
      }
    }
  } catch (error) {
    for (const plan of applied.reverse()) restorePlan(plan);
    if (shouldWriteState) restoreState(statePath, previousState);
    throw error;
  }

  return { written, notes };
}
