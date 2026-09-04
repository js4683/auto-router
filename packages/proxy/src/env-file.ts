import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENCODE_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GEMINI_BASE_URL",
] as const;

const ALLOWED = new Set<string>(ENV_KEYS);

export function defaultEnvPath(): string {
  return join(homedir(), ".config/auto-router/.env");
}

export function readEnvFile(path: string): Record<string, string> {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (ALLOWED.has(key) && value) out[key] = value;
  }
  return out;
}

export function writeEnvFile(path: string, updates: Record<string, string>): void {
  const merged = readEnvFile(path);
  for (const key of ENV_KEYS) {
    const value = updates[key];
    if (value === undefined || value === "") continue;
    merged[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = ENV_KEYS.filter((key) => merged[key]).map((key) => `${key}=${merged[key]}`).join("\n") + (Object.keys(merged).length ? "\n" : "");
  writeFileSync(path, body, { mode: 0o600 });
}
