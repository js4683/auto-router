import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAuthFile, writeAuthEntry } from "./auth-store.js";
import { readClaudeCodeOauth } from "./claude-code-auth.js";
import { readJsonStore, updateJsonStore } from "./secure-json-store.js";

export interface AccountIdentity {
  email?: string;
  plan?: string;
}

export interface ExtraAccount {
  id: string;
  provider: string;
  type: "oauth" | "api";
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
  email?: string;
  plan?: string;
  projectId?: string;
}

export interface ResolvedAccount {
  id: string;
  provider: string;
  token: string;
  type: "oauth" | "api";
  email?: string;
  plan?: string;
  projectId?: string;
  expires?: number;
  primary: boolean;
  refresh?: string;
  source: "keychain" | "auth" | "extra";
  sourceKey?: string;
}

export function defaultAccountsPath(): string {
  return join(homedir(), ".config/auto-router/accounts.json");
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jwtEmail(token: string): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  if (typeof claims.email === "string" && claims.email.includes("@")) return claims.email;
  const profile = claims["https://api.openai.com/profile"];
  if (profile && typeof profile === "object" && typeof (profile as { email?: string }).email === "string") {
    return (profile as { email: string }).email;
  }
  return undefined;
}

function claudeAccount(): AccountIdentity {
  if (process.env.VITEST) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as {
      oauthAccount?: { emailAddress?: string; organizationType?: string; displayName?: string };
    };
    const account = parsed.oauthAccount;
    const email = account?.emailAddress;
    const org = account?.organizationType;
    const plan = org === "claude_pro" ? "Pro" : org === "claude_max" ? "Max" : org?.replace(/^claude_/, "");
    const oauth = readClaudeCodeOauth();
    return { email, plan: plan || (oauth?.expires ? "Pro/Max" : undefined) };
  } catch {
    return {};
  }
}

function authEmail(authPath: string | undefined, provider: string): string | undefined {
  if (!authPath) return undefined;
  const entry = readAuthFile(authPath)[provider];
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.email === "string" && record.email.includes("@")) return record.email;
  const access = typeof record.access === "string" ? record.access : undefined;
  return access ? jwtEmail(access) : undefined;
}

export function accountIdentity(provider: string, authPath?: string): AccountIdentity {
  if (provider === "anthropic") {
    const claude = claudeAccount();
    return { email: claude.email || authEmail(authPath, provider), plan: claude.plan };
  }
  return { email: authEmail(authPath, provider) };
}

function isExtraAccount(value: unknown): value is ExtraAccount {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.provider !== "string" || !record.provider) return false;
  if (record.type !== "oauth" && record.type !== "api") return false;
  for (const key of ["access", "refresh", "key", "email", "plan", "projectId"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") return false;
  }
  return record.expires === undefined || (typeof record.expires === "number" && Number.isFinite(record.expires));
}

export function readExtraAccounts(path: string): ExtraAccount[] {
  const parsed = readJsonStore(path, (value): ExtraAccount[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("accounts file is malformed");
    const accounts = (value as { accounts?: unknown }).accounts;
    if (accounts === undefined) return [];
    if (!Array.isArray(accounts)) throw new Error("accounts file is malformed");
    return accounts.map((account, index) => {
      if (!isExtraAccount(account)) throw new Error(`accounts file contains invalid account entry at index ${index}`);
      return account;
    });
  });
  return parsed ?? [];
}

export function addExtraAccount(path: string, input: Omit<ExtraAccount, "id"> & { id?: string }): ExtraAccount {
  const account: ExtraAccount = { ...input, id: input.id ?? randomUUID() };
  updateJsonStore(path, { accounts: [] }, (value): { accounts: ExtraAccount[] } => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { accounts?: unknown }).accounts)) {
      throw new Error("accounts file is malformed");
    }
    const accounts = (value as { accounts: unknown[] }).accounts;
    if (accounts.some((item) => !isExtraAccount(item))) throw new Error("accounts file contains invalid account entry");
    return { accounts: accounts as ExtraAccount[] };
  }, (value) => ({ accounts: [...value.accounts, account] }));
  return account;
}

export function updateExtraAccount(path: string, id: string, patch: Partial<ExtraAccount>): ExtraAccount | undefined {
  let updated: ExtraAccount | undefined;
  updateJsonStore(path, { accounts: [] }, (value): { accounts: ExtraAccount[] } => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { accounts?: unknown }).accounts)) {
      throw new Error("accounts file is malformed");
    }
    const accounts = (value as { accounts: unknown[] }).accounts;
    if (accounts.some((item) => !isExtraAccount(item))) throw new Error("accounts file contains invalid account entry");
    return { accounts: accounts as ExtraAccount[] };
  }, (value) => {
    const index = value.accounts.findIndex((item) => item.id === id);
    if (index < 0) return value;
    const current = value.accounts[index];
    updated = { ...current, ...patch, id: current.id, provider: current.provider };
    return { accounts: value.accounts.map((item, itemIndex) => (itemIndex === index ? updated! : item)) };
  });
  return updated;
}

export function removeExtraAccount(path: string, id: string): boolean {
  let removed = false;
  updateJsonStore(path, { accounts: [] }, (value): { accounts: ExtraAccount[] } => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { accounts?: unknown }).accounts)) {
      throw new Error("accounts file is malformed");
    }
    const accounts = (value as { accounts: unknown[] }).accounts;
    if (accounts.some((item) => !isExtraAccount(item))) throw new Error("accounts file contains invalid account entry");
    return { accounts: accounts as ExtraAccount[] };
  }, (value) => {
    const kept = value.accounts.filter((item) => item.id !== id);
    removed = kept.length !== value.accounts.length;
    return { accounts: kept };
  });
  return removed;
}

function entryToken(entry: Record<string, unknown>, provider: string): string | undefined {
  if (provider === "google" && entry.type === "oauth") return typeof entry.access === "string" ? entry.access : undefined;
  for (const name of ["key", "token", "access"] as const) {
    const value = entry[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function extraToken(account: ExtraAccount): string | undefined {
  if (account.provider === "google" && account.type === "oauth") return account.access;
  return account.key || account.access;
}

function fromEntry(provider: string, entry: Record<string, unknown>, id: string, primary: boolean): ResolvedAccount | undefined {
  const token = entryToken(entry, provider);
  if (!token) return undefined;
  const type = entry.type === "oauth" ? "oauth" : "api";
  const email = typeof entry.email === "string" ? entry.email : jwtEmail(token);
  const plan = typeof entry.plan === "string" ? entry.plan : undefined;
  const projectId = typeof entry.projectId === "string" ? entry.projectId : undefined;
  const expires = typeof entry.expires === "number" ? entry.expires : undefined;
  const refresh = typeof entry.refresh === "string" ? entry.refresh : undefined;
  return { id, provider, token, type, email, plan, projectId, expires, primary, refresh, source: "auth", sourceKey: `auth:${provider}` };
}

export function listProviderAccounts(
  provider: string,
  opts: { env?: NodeJS.ProcessEnv; authPath?: string; accountsPath?: string },
): ResolvedAccount[] {
  const out: ResolvedAccount[] = [];
  const seen = new Set<string>();
  const push = (account: ResolvedAccount | undefined) => {
    if (!account) return;
    const sourceKey = account.sourceKey ?? `${account.source}:${account.id}`;
    const dedupeKey = `${sourceKey}\0${account.token}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push(account);
  };
  if (provider === "anthropic") {
    const code = readClaudeCodeOauth();
    if (code?.access) {
      const identity = claudeAccount();
      push({
        id: "anthropic:keychain",
        provider,
        token: code.access,
        type: "oauth",
        email: identity.email,
        plan: identity.plan,
        expires: code.expires,
        primary: true,
        refresh: code.refresh,
        source: "keychain",
        sourceKey: `keychain:${provider}`,
      });
    }
  }
  if (opts.authPath) {
    const raw = readAuthFile(opts.authPath)[provider];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      push(fromEntry(provider, raw as Record<string, unknown>, `${provider}:primary`, out.length === 0));
    }
  }
  if (opts.accountsPath) {
    for (const extra of readExtraAccounts(opts.accountsPath)) {
      if (extra.provider !== provider) continue;
      const token = extraToken(extra);
      if (!token) continue;
      push({
        id: extra.id,
        provider,
        token,
        type: extra.type,
        email: extra.email,
        plan: extra.plan,
        projectId: extra.projectId,
        expires: extra.expires,
        primary: out.length === 0,
        refresh: extra.refresh,
        source: "extra",
        sourceKey: `extra:${extra.id}`,
      });
    }
  }
  return out;
}

function hasPrimary(provider: string, authPath: string): boolean {
  if (provider === "anthropic" && readClaudeCodeOauth()?.access) return true;
  const raw = readAuthFile(authPath)[provider];
  if (!raw || typeof raw !== "object") return false;
  return Boolean(entryToken(raw as Record<string, unknown>, provider));
}

function extraFromEntry(provider: string, entry: Record<string, unknown>): Omit<ExtraAccount, "id"> {
  const type = entry.type === "oauth" ? "oauth" : "api";
  const access = typeof entry.access === "string" ? entry.access : undefined;
  const key = typeof entry.key === "string" ? entry.key : undefined;
  const email = typeof entry.email === "string" ? entry.email : access ? jwtEmail(access) : undefined;
  return {
    provider,
    type,
    access,
    refresh: typeof entry.refresh === "string" ? entry.refresh : undefined,
    expires: typeof entry.expires === "number" ? entry.expires : undefined,
    key,
    email,
    plan: typeof entry.plan === "string" ? entry.plan : undefined,
    projectId: typeof entry.projectId === "string" ? entry.projectId : undefined,
  };
}

export function saveProviderCredential(opts: {
  provider: string;
  entry: Record<string, unknown>;
  authPath: string;
  accountsPath?: string;
}): { extra: boolean } {
  if (opts.accountsPath && hasPrimary(opts.provider, opts.authPath)) {
    addExtraAccount(opts.accountsPath, extraFromEntry(opts.provider, opts.entry));
    return { extra: true };
  }
  writeAuthEntry(opts.authPath, opts.provider, opts.entry);
  return { extra: false };
}

export function nextOpenAccount(accounts: ResolvedAccount[], skipped: Set<string>): ResolvedAccount | undefined {
  return accounts.find((account) => {
    const sourceKey = account.sourceKey ?? `${account.source}:${account.id}`;
    return !skipped.has(account.id) && !skipped.has(sourceKey);
  });
}
