import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateUpstreamTimeout } from "./upstream-timeout.js";
import { writeAtomicText } from "./secure-json-store.js";

export const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "AUTO_ROUTER_UPSTREAM_TIMEOUT_MS",
  "OPENAI_BASE_URL",
  "OPENCODE_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GEMINI_BASE_URL",
  "XAI_BASE_URL",
] as const;

const ALLOWED = new Set<string>(ENV_KEYS);
const BASE_URL_KEYS = new Set<string>([
  "OPENAI_BASE_URL",
  "OPENCODE_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GEMINI_BASE_URL",
  "XAI_BASE_URL",
]);

export function defaultEnvPath(): string {
  return join(homedir(), ".config/auto-router/.env");
}

export function readEnvFile(path: string): Record<string, string> {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") return {};
    throw error;
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function validateEnvValue(key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${key} must not contain newlines`);
  if (!BASE_URL_KEYS.has(key)) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} base URL is invalid`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${key} base URL must not include credentials, query, or fragment`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    throw new Error(`${key} base URL must use HTTPS except for loopback`);
  }
}

export function writeEnvFile(path: string, updates: Record<string, string>): void {
  const merged = readEnvFile(path);
  for (const key of ENV_KEYS) {
    const value = updates[key];
    if (value === undefined || value === "") continue;
    validateEnvValue(key, value);
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(merged)) validateEnvValue(key, value);
  const timeout = merged.AUTO_ROUTER_UPSTREAM_TIMEOUT_MS;
  if (timeout !== undefined) merged.AUTO_ROUTER_UPSTREAM_TIMEOUT_MS = String(validateUpstreamTimeout(Number(timeout)));
  const body = ENV_KEYS.filter((key) => merged[key]).map((key) => `${key}=${merged[key]}`).join("\n") + (Object.keys(merged).length ? "\n" : "");
  writeAtomicText(path, body);
}
