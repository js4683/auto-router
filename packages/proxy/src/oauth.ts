import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveProviderCredential, updateExtraAccount, type ResolvedAccount } from "./accounts.js";
import { readAuthFile, writeAuthEntry } from "./auth-store.js";
import { readClaudeCodeOauth, writeClaudeCodeOauth } from "./claude-code-auth.js";
import { readJsonStore, updateJsonStore } from "./secure-json-store.js";

function persistOauth(authPath: string, provider: string, entry: Record<string, unknown>, accountsPath?: string): void {
  saveProviderCredential({ provider, entry, authPath, accountsPath });
}

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_DEVICE = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN = "https://auth.x.ai/oauth2/token";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_REDIRECT = "https://console.anthropic.com/oauth/code/callback";
function googleClientId(): string {
  return process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "";
}

function googleClientSecrets(): string[] {
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return secret ? [secret] : [];
}
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REDIRECT = "https://antigravity.google/oauth-callback";
const GOOGLE_SCOPE =
  "openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";

type Pending =
  | { provider: "openai"; deviceAuthId: string; userCode: string }
  | { provider: "xai"; deviceCode: string }
  | { provider: "anthropic"; verifier: string }
  | { provider: "google"; redirectUri: string; verifier: string }
  | { provider: "opencode" };

export interface OAuthOptions {
  statePath?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function defaultOAuthStatePath(): string {
  return join(homedir(), ".config/auto-router/oauth-state.json");
}

const PENDING_TTL_MS = 15 * 60_000;
const pending = new Map<string, { at: number; session: Pending }>();

interface PendingFile {
  sessions: Record<string, { at: number; session: Pending }>;
}

function isPending(value: unknown): value is Pending {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provider = (value as { provider?: unknown }).provider;
  if (provider === "opencode") return true;
  if (provider === "anthropic") return typeof (value as { verifier?: unknown }).verifier === "string";
  if (provider === "google") return typeof (value as { redirectUri?: unknown }).redirectUri === "string" && typeof (value as { verifier?: unknown }).verifier === "string";
  if (provider === "openai") return typeof (value as { deviceAuthId?: unknown }).deviceAuthId === "string" && typeof (value as { userCode?: unknown }).userCode === "string";
  return provider === "xai" && typeof (value as { deviceCode?: unknown }).deviceCode === "string";
}

function parsePendingFile(value: unknown): PendingFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("oauth state file is malformed");
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) throw new Error("oauth state file is malformed");
  const parsed: PendingFile["sessions"] = {};
  for (const [id, item] of Object.entries(sessions)) {
    if (!item || typeof item !== "object" || !Number.isFinite((item as { at?: unknown }).at) || !isPending((item as { session?: unknown }).session)) {
      throw new Error("oauth state file contains an invalid session");
    }
    parsed[id] = item as PendingFile["sessions"][string];
  }
  return { sessions: parsed };
}

function setPending(id: string, session: Pending, statePath?: string): void {
  if (!statePath) {
    pending.set(id, { at: Date.now(), session });
    return;
  }
  updateJsonStore(statePath, { sessions: {} }, parsePendingFile, (current) => ({
    sessions: { ...current.sessions, [id]: { at: Date.now(), session } },
  }));
}

function deletePending(id: string, statePath?: string): void {
  if (!statePath) {
    pending.delete(id);
    return;
  }
  const current = readJsonStore(statePath, parsePendingFile);
  if (!current || !current.sessions[id]) return;
  updateJsonStore(statePath, { sessions: {} }, parsePendingFile, (value) => {
    const sessions = { ...value.sessions };
    delete sessions[id];
    return { sessions };
  });
}

function getPending(id: string, statePath?: string): Pending | undefined {
  const file = statePath ? readJsonStore(statePath, parsePendingFile) : undefined;
  const entry = statePath ? file?.sessions[id] : pending.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.at > PENDING_TTL_MS) {
    deletePending(id, statePath);
    return undefined;
  }
  return entry.session;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export type OAuthStart =
  | { id: string; url: string; method: "device"; user_code: string }
  | { id: string; url: string; method: "code" }
  | { id: string; url: string; method: "redirect" }
  | { error: string };

export async function startOAuth(provider: string, options: OAuthOptions = {}): Promise<OAuthStart> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (provider === "openai") {
    const response = await fetchImpl(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return { error: `OpenAI login start failed (${response.status})` };
    const data = (await response.json()) as { device_auth_id: string; user_code: string };
    const id = randomUUID();
    setPending(id, { provider: "openai", deviceAuthId: data.device_auth_id, userCode: data.user_code }, options.statePath);
    return { id, url: `${OPENAI_ISSUER}/codex/device`, method: "device", user_code: data.user_code };
  }
  if (provider === "xai") {
    const response = await fetchImpl(XAI_DEVICE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }).toString(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return { error: `Grok login start failed (${response.status})` };
    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri?: string;
      verification_uri_complete?: string;
    };
    const id = randomUUID();
    setPending(id, { provider: "xai", deviceCode: data.device_code }, options.statePath);
    return {
      id,
      url: data.verification_uri_complete ?? data.verification_uri ?? "https://auth.x.ai/device",
      method: "device",
      user_code: data.user_code,
    };
  }
  if (provider === "anthropic") {
    const { verifier, challenge } = pkce();
    const id = randomUUID();
    setPending(id, { provider: "anthropic", verifier }, options.statePath);
    const url = new URL("https://claude.ai/oauth/authorize");
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", CLAUDE_REDIRECT);
    url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", verifier);
    return { id, url: url.toString(), method: "code" };
  }
  if (provider === "google" || provider === "antigravity") {
    const clientId = googleClientId();
    if (!clientId) return { error: "Google OAuth requires GOOGLE_OAUTH_CLIENT_ID" };
    const { verifier, challenge } = pkce();
    const id = randomUUID();
    setPending(id, { provider: "google", redirectUri: GOOGLE_REDIRECT, verifier }, options.statePath);
    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", GOOGLE_REDIRECT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", id);
    return { id, url: url.toString(), method: "code" };
  }
  if (provider === "opencode") {
    const id = randomUUID();
    setPending(id, { provider: "opencode" }, options.statePath);
    return { id, url: "https://opencode.ai/auth", method: "code" };
  }
  return { error: "oauth not available for this provider" };
}

const ANTIGRAVITY_LOAD_METADATA = { ideType: "ANTIGRAVITY" };
const ANTIGRAVITY_ONBOARD_METADATA = { ide_type: "ANTIGRAVITY", ide_version: "2.9.1", ide_name: "antigravity" };
const ANTIGRAVITY_LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ANTIGRAVITY_ONBOARD_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";

type GoogleProjectResponse = Record<string, unknown>;

export function antigravityUserAgent(withNodeClient = false): string {
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/hub/2.9.1 ${process.platform}/${arch}${withNodeClient ? " google-api-nodejs-client/10.3.0" : ""}`;
}

function projectId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
}

function responseProject(data: GoogleProjectResponse | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const found = projectId(data[key]);
    if (found) return found;
  }
  const nested = data.response;
  return nested && typeof nested === "object" ? responseProject(nested as GoogleProjectResponse) : undefined;
}

function defaultAntigravityTier(data: GoogleProjectResponse): string {
  const tiers = Array.isArray(data.allowedTiers) ? data.allowedTiers : [];
  const defaultTier = tiers.find(
    (tier) => tier && typeof tier === "object" && (tier as Record<string, unknown>).isDefault === true,
  );
  return projectId(defaultTier && typeof defaultTier === "object" ? (defaultTier as Record<string, unknown>).id : undefined)
    ?? projectId(data.currentTier && typeof data.currentTier === "object" ? (data.currentTier as Record<string, unknown>).id : undefined)
    ?? "free-tier";
}

async function googleProject(access: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<GoogleProjectResponse | undefined> {
  const response = await fetchImpl(ANTIGRAVITY_LOAD_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access}`,
      accept: "*/*",
      "content-type": "application/json",
      "user-agent": antigravityUserAgent(),
    },
    body: JSON.stringify({ metadata: ANTIGRAVITY_LOAD_METADATA }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) return undefined;
  return (await response.json()) as GoogleProjectResponse;
}

export async function ensureGoogleProject(access: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string | undefined> {
  const loaded = await googleProject(access, fetchImpl, signal);
  const existing = responseProject(loaded);
  if (existing) return existing;
  if (!loaded) return undefined;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const onboard = await fetchImpl(ANTIGRAVITY_ONBOARD_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        accept: "*/*",
        "content-type": "application/json",
        "user-agent": antigravityUserAgent(true),
        "x-goog-api-client": "gl-node/22.21.1",
      },
      body: JSON.stringify({ tier_id: defaultAntigravityTier(loaded), metadata: ANTIGRAVITY_ONBOARD_METADATA }),
      ...(signal ? { signal } : {}),
    });
    if (!onboard.ok) return undefined;
    const data = (await onboard.json()) as GoogleProjectResponse;
    const project = responseProject(data);
    if (project) return project;
    if (data.done === true || attempt === 4) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return undefined;
}

async function exchangeGoogleToken(
  code: string,
  redirectUri: string,
  verifier?: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | { error: string }> {
  const params = {
    client_id: googleClientId(),
    code: code.trim(),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    ...(verifier ? { code_verifier: verifier } : {}),
  };
  for (const secret of [...googleClientSecrets(), ""]) {
    const body = new URLSearchParams(secret ? { ...params, client_secret: secret } : params);
    const response = await fetchImpl(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) continue;
    const data = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== "string" || !data.access_token) continue;
    return {
      access_token: data.access_token,
      ...(typeof data.refresh_token === "string" ? { refresh_token: data.refresh_token } : {}),
      ...(typeof data.expires_in === "number" ? { expires_in: data.expires_in } : {}),
    };
  }
  return { error: "Gemini login failed" };
}

async function saveGoogleTokens(
  authPath: string,
  tokens: { access_token: string; refresh_token?: string; expires_in?: number },
  id: string,
  accountsPath?: string,
  options: OAuthOptions = {},
): Promise<{ done: true }> {
  const projectId = await ensureGoogleProject(tokens.access_token, options.fetchImpl ?? fetch, options.signal).catch((error) => {
    if (options.signal?.aborted) throw error;
    return undefined;
  });
  persistOauth(
    authPath,
    "google",
    {
      type: "oauth",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ...(projectId ? { projectId } : {}),
    },
    accountsPath,
  );
  deletePending(id, options.statePath);
  return { done: true };
}

export async function completeOAuthCode(
  id: string,
  code: string,
  authPath: string,
  accountsPath?: string,
  options: OAuthOptions = {},
): Promise<{ done?: boolean; error?: string }> {
  const session = getPending(id, options.statePath);
  if (!session) return { error: "login session expired" };
  if (session.provider === "opencode") {
    const key = code.trim();
    if (!key) return { error: "key required" };
    persistOauth(authPath, "opencode", { type: "api", key }, accountsPath);
    deletePending(id, options.statePath);
    return { done: true };
  }
  if (session.provider === "google") {
    const tokens = await exchangeGoogleToken(code, session.redirectUri, session.verifier, options.fetchImpl, options.signal);
    if ("error" in tokens) return tokens;
    return saveGoogleTokens(authPath, tokens, id, accountsPath, options);
  }
  if (session.provider !== "anthropic") return { error: "login session expired" };
  const splits = code.trim().split("#");
  const response = await (options.fetchImpl ?? fetch)("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: CLAUDE_REDIRECT,
      code_verifier: session.verifier,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) return { error: `Claude login failed (${response.status})` };
  const tokens = (await response.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  persistOauth(authPath, "anthropic", {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }, accountsPath);
  deletePending(id, options.statePath);
  return { done: true };
}

export async function completeGoogleCallback(
  state: string,
  code: string,
  authPath: string,
  accountsPath?: string,
  options: OAuthOptions = {},
): Promise<{ done?: boolean; error?: string }> {
  const session = getPending(state, options.statePath);
  if (!session || session.provider !== "google") return { error: "login session expired" };
  const tokens = await exchangeGoogleToken(code, session.redirectUri, session.verifier, options.fetchImpl, options.signal);
  if ("error" in tokens) return tokens;
  return saveGoogleTokens(authPath, tokens, state, accountsPath, options);
}

export async function pollOAuth(
  id: string,
  authPath: string,
  accountsPath?: string,
  options: OAuthOptions = {},
): Promise<{ done?: boolean; error?: string }> {
  const session = getPending(id, options.statePath);
  if (!session) return { error: "login session expired" };
  if (session.provider === "anthropic" || session.provider === "google" || session.provider === "opencode") return {};
  if (session.provider === "openai") {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 400 || response.status === 403) return {};
    if (!response.ok) return { error: `OpenAI poll failed (${response.status})` };
    const data = (await response.json()) as { authorization_code?: string; code_verifier?: string };
    if (!data.authorization_code || !data.code_verifier) return {};
    const tokenResponse = await fetchImpl(`${OPENAI_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: data.authorization_code,
        redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
        client_id: OPENAI_CLIENT_ID,
        code_verifier: data.code_verifier,
      }).toString(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!tokenResponse.ok) return { error: `OpenAI token failed (${tokenResponse.status})` };
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string; expires_in?: number };
    persistOauth(authPath, "openai", {
      type: "oauth",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    }, accountsPath);
    deletePending(id, options.statePath);
    return { done: true };
  }
  const response = await (options.fetchImpl ?? fetch)(XAI_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: session.deviceCode,
      client_id: XAI_CLIENT_ID,
    }).toString(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (data.error === "authorization_pending" || data.error === "slow_down") return {};
  if (!data.access_token) return { error: data.error ?? `Grok poll failed (${response.status})` };
  persistOauth(authPath, "xai", {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  }, accountsPath);
  deletePending(id, options.statePath);
  return { done: true };
}

const REFRESH_SKEW_MS = 60_000;
const refreshFlights = new Map<string, Promise<string | undefined>>();

function runRefresh(key: string, task: () => Promise<string | undefined>): Promise<string | undefined> {
  const running = refreshFlights.get(key);
  if (running) return running;
  let pending: Promise<string | undefined>;
  pending = task().finally(() => {
    if (refreshFlights.get(key) === pending) refreshFlights.delete(key);
  });
  refreshFlights.set(key, pending);
  return pending;
}

function refreshKey(sourceKey: string, refresh: string | undefined, access: string | undefined): string {
  return `${sourceKey}:${refresh ?? access ?? "empty"}`;
}

function oauthString(entry: Record<string, unknown>, name: string): string | undefined {
  const value = entry[name];
  return typeof value === "string" && value ? value : undefined;
}

async function requestRefresh(
  provider: string,
  refresh: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ access: string; refresh?: string; expiresIn?: number } | undefined> {
  if (provider === "anthropic") {
    const response = await fetchImpl("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CLIENT_ID }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return undefined;
    return { access: data.access_token, refresh: data.refresh_token, expiresIn: data.expires_in };
  }
  if (provider === "openai") {
    const response = await fetchImpl(`${OPENAI_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: OPENAI_CLIENT_ID }).toString(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return undefined;
    return { access: data.access_token, refresh: data.refresh_token, expiresIn: data.expires_in };
  }
  if (provider === "xai") {
    const response = await fetchImpl(XAI_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: XAI_CLIENT_ID }).toString(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!data.access_token) return undefined;
    return { access: data.access_token, refresh: data.refresh_token, expiresIn: data.expires_in };
  }
  if (provider === "google") {
    const clientId = googleClientId();
    if (!clientId) return undefined;
    const params = { client_id: clientId, grant_type: "refresh_token", refresh_token: refresh };
    for (const secret of [...googleClientSecrets(), ""]) {
      const response = await fetchImpl(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(secret ? { ...params, client_secret: secret } : params).toString(),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (data.access_token) return { access: data.access_token, refresh: data.refresh_token, expiresIn: data.expires_in };
    }
  }
  return undefined;
}

export async function refreshOAuthToken(
  provider: string,
  authPath: string,
  fetchImpl: typeof fetch = fetch,
  force = false,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const keychain = provider === "anthropic" ? readClaudeCodeOauth() : undefined;
  const authEntry = readAuthFile(authPath)[provider];
  const auth = authEntry && typeof authEntry === "object" && !Array.isArray(authEntry)
    ? authEntry as Record<string, unknown>
    : undefined;
  const sourceKey = keychain?.access ? "keychain:anthropic" : `auth:${provider}`;
  const refresh = keychain?.refresh ?? (typeof auth?.refresh === "string" ? auth.refresh : undefined);
  const access = keychain?.access ?? (typeof auth?.access === "string" ? auth.access : undefined);
  return runRefresh(refreshKey(sourceKey, refresh, access), async () => {
    if (provider === "anthropic") {
      const refreshedKeychain = await refreshClaudeCodeToken(fetchImpl, force, signal);
      if (refreshedKeychain) return refreshedKeychain;
    }
    return refreshAuthFileToken(provider, authPath, fetchImpl, force, signal);
  });
}

async function refreshClaudeCodeToken(fetchImpl: typeof fetch, force = false, signal?: AbortSignal): Promise<string | undefined> {
  const code = readClaudeCodeOauth();
  if (!code?.access) return undefined;
  if (!force && code.expires && Date.now() < code.expires - REFRESH_SKEW_MS) return code.access;
  if (!code.refresh) return code.access;
  const tokens = await requestRefresh("anthropic", code.refresh, fetchImpl, signal).catch((error) => {
    if (signal?.aborted) throw error;
    return undefined;
  });
  if (!tokens) return code.access;
  writeClaudeCodeOauth({
    access: tokens.access,
    refresh: tokens.refresh ?? code.refresh,
    expires: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
  });
  return tokens.access;
}

async function refreshAuthFileToken(
  provider: string,
  authPath: string,
  fetchImpl: typeof fetch,
  force = false,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const raw = readAuthFile(authPath)[provider];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  if (entry.type !== "oauth") return undefined;
  const access = oauthString(entry, "access");
  const refresh = oauthString(entry, "refresh");
  const expires = typeof entry.expires === "number" ? entry.expires : 0;
  if (!force && access && expires && Date.now() < expires - REFRESH_SKEW_MS) return access;
  if (!refresh) return access;
  const tokens = await requestRefresh(provider, refresh, fetchImpl, signal).catch((error) => {
    if (signal?.aborted) throw error;
    return undefined;
  });
  if (!tokens) return access;
  writeAuthEntry(authPath, provider, {
    ...entry,
    access: tokens.access,
    refresh: tokens.refresh ?? refresh,
    expires: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
  });
  return tokens.access;
}

export async function refreshAccountToken(
  account: ResolvedAccount,
  opts: { authPath: string; accountsPath?: string; fetchImpl?: typeof fetch; force?: boolean; signal?: AbortSignal },
): Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (account.type !== "oauth") return account.token;
  const sourceKey = account.sourceKey ?? `${account.source}:${account.id}`;
  return runRefresh(refreshKey(sourceKey, account.refresh, account.token), async () => {
    if (account.source === "keychain") return (await refreshClaudeCodeToken(fetchImpl, opts.force, opts.signal)) ?? account.token;
    if (account.source === "auth") return (await refreshAuthFileToken(account.provider, opts.authPath, fetchImpl, opts.force, opts.signal)) ?? account.token;
    if (!opts.accountsPath || !account.refresh) return account.token;
    if (!opts.force && account.expires && Date.now() < account.expires - REFRESH_SKEW_MS) return account.token;
    const tokens = await requestRefresh(account.provider, account.refresh, fetchImpl, opts.signal).catch((error) => {
      if (opts.signal?.aborted) throw error;
      return undefined;
    });
    if (!tokens) return account.token;
    const expires = Date.now() + (tokens.expiresIn ?? 3600) * 1000;
    updateExtraAccount(opts.accountsPath, account.id, {
      access: tokens.access,
      refresh: tokens.refresh ?? account.refresh,
      expires,
    });
    return tokens.access;
  });
}

export const CONNECT_PROVIDERS: Record<string, { label: string; consoleUrl: string; oauth: boolean; authId: string }> = {
  openai: { label: "OpenAI", consoleUrl: "https://platform.openai.com/api-keys", oauth: true, authId: "openai" },
  anthropic: { label: "Claude", consoleUrl: "https://console.anthropic.com/settings/keys", oauth: true, authId: "anthropic" },
  google: { label: "Gemini / Antigravity", consoleUrl: "https://aistudio.google.com/apikey", oauth: true, authId: "google" },
  antigravity: { label: "Antigravity", consoleUrl: "https://antigravity.google", oauth: true, authId: "google" },
  xai: { label: "Grok", consoleUrl: "https://console.x.ai", oauth: true, authId: "xai" },
  opencode: { label: "OpenCode Zen", consoleUrl: "https://opencode.ai/auth", oauth: true, authId: "opencode" },
};
