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
  xai: ["XAI_API_KEY"],
};

export const UI_PROVIDERS = [
  { id: "openai", label: "OpenAI", runtimeId: "openai/gpt-4o", envKey: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Claude", runtimeId: "anthropic/claude-sonnet", envKey: "ANTHROPIC_API_KEY" },
  { id: "xai", label: "Grok", runtimeId: "xai/grok-4.6", envKey: "XAI_API_KEY" },
  { id: "google", label: "Gemini / Antigravity", runtimeId: "google/gemini-3.6-flash", envKey: "GEMINI_API_KEY" },
  { id: "opencode", label: "OpenCode Zen", runtimeId: "opencode/muse-spark-1.3-contributor-free", envKey: "OPENCODE_API_KEY" },
] as const;

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

function fromAuthEntry(entry: unknown, provider?: string): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (provider === "google" && record.type === "oauth") return stringField(record.key);
  return stringField(record.key) ?? stringField(record.token) ?? stringField(record.access);
}

function tokenFromClaudeFile(path: string): string | undefined {
  const parsed = readJson(path);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const oauth = record.oauth && typeof record.oauth === "object" ? (record.oauth as Record<string, unknown>) : undefined;
  return stringField(record.token) ?? stringField(record.key) ?? stringField(oauth?.accessToken);
}

function loginToken(provider: string, opts: ResolveCredentialOptions): string | undefined {
  const auth = opts.authPath ? readJson(opts.authPath) : undefined;
  if (auth && typeof auth === "object") {
    const fromAuth = fromAuthEntry((auth as Record<string, unknown>)[provider], provider);
    if (fromAuth) return fromAuth;
  }
  if (provider === "anthropic" && opts.claudePath) return tokenFromClaudeFile(opts.claudePath);
  return undefined;
}

function envToken(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ENV_BY_PROVIDER[provider] ?? []) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

export function resolveCredential(runtimeId: string, opts: ResolveCredentialOptions): string | undefined {
  const provider = providerOf(runtimeId);
  if (!provider) return undefined;
  if (provider === "google") return envToken(provider, opts.env) ?? loginToken(provider, opts);
  return loginToken(provider, opts) ?? envToken(provider, opts.env);
}

export function resolveGoogleProject(opts: ResolveCredentialOptions): string | undefined {
  const auth = opts.authPath ? readJson(opts.authPath) : undefined;
  if (auth && typeof auth === "object") {
    const entry = (auth as Record<string, unknown>).google;
    if (entry && typeof entry === "object") {
      const projectId = stringField((entry as Record<string, unknown>).projectId);
      if (projectId) return projectId;
    }
  }
  return opts.env.GOOGLE_CLOUD_PROJECT || opts.env.GOOGLE_CLOUD_PROJECT_ID;
}

export function loginIsOAuth(provider: string, opts: ResolveCredentialOptions): boolean {
  const auth = opts.authPath ? readJson(opts.authPath) : undefined;
  if (!auth || typeof auth !== "object") return false;
  const entry = (auth as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== "object") return false;
  return (entry as Record<string, unknown>).type === "oauth";
}

export function providerLoginSet(provider: string, opts: ResolveCredentialOptions): boolean {
  return Boolean(loginToken(provider, opts));
}
