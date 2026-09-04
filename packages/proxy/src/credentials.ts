import { readFileSync } from "node:fs";

export interface ResolveCredentialOptions {
  env: NodeJS.ProcessEnv;
  authPath?: string;
  claudePath?: string;
}

const ENV_BY_PROVIDER: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

function providerOf(runtimeId: string): string | undefined {
  const separator = runtimeId.indexOf("/");
  if (separator <= 0) return undefined;
  return runtimeId.slice(0, separator);
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  return undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function fromAuthEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  return stringField(record.key) ?? stringField(record.token) ?? stringField(record.access);
}

function tokenFromClaudeFile(path: string): string | undefined {
  const parsed = readJson(path);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const oauth = record.oauth && typeof record.oauth === "object" ? (record.oauth as Record<string, unknown>) : undefined;
  return stringField(record.token) ?? stringField(record.key) ?? stringField(oauth?.accessToken);
}

export function resolveCredential(runtimeId: string, opts: ResolveCredentialOptions): string | undefined {
  const provider = providerOf(runtimeId);
  if (!provider) return undefined;
  for (const name of ENV_BY_PROVIDER[provider] ?? []) {
    const value = opts.env[name];
    if (value) return value;
  }
  const authPath = opts.authPath;
  const auth = authPath ? readJson(authPath) : undefined;
  if (auth && typeof auth === "object") {
    const fromAuth = fromAuthEntry((auth as Record<string, unknown>)[provider]);
    if (fromAuth) return fromAuth;
  }
  if (provider === "anthropic" && opts.claudePath) {
    const fromClaude = tokenFromClaudeFile(opts.claudePath);
    if (fromClaude) return fromClaude;
  }
  return undefined;
}
