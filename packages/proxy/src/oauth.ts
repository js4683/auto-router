import { createHash, randomBytes, randomUUID } from "node:crypto";
import { saveProviderCredential, updateExtraAccount, type ResolvedAccount } from "./accounts.js";
import { readAuthFile, writeAuthEntry } from "./auth-store.js";
import { readClaudeCodeOauth, writeClaudeCodeOauth } from "./claude-code-auth.js";

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

const PENDING_TTL_MS = 15 * 60_000;
const pending = new Map<string, { at: number; session: Pending }>();

function setPending(id: string, session: Pending): void {
  pending.set(id, { at: Date.now(), session });
}

function getPending(id: string): Pending | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.at > PENDING_TTL_MS) {
    pending.delete(id);
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

export async function startOAuth(provider: string): Promise<OAuthStart> {
  if (provider === "openai") {
    const response = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
    });
    if (!response.ok) return { error: `OpenAI login start failed (${response.status})` };
    const data = (await response.json()) as { device_auth_id: string; user_code: string };
    const id = randomUUID();
    setPending(id, { provider: "openai", deviceAuthId: data.device_auth_id, userCode: data.user_code });
    return { id, url: `${OPENAI_ISSUER}/codex/device`, method: "device", user_code: data.user_code };
  }
  if (provider === "xai") {
    const response = await fetch(XAI_DEVICE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }).toString(),
    });
    if (!response.ok) return { error: `Grok login start failed (${response.status})` };
    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri?: string;
      verification_uri_complete?: string;
    };
    const id = randomUUID();
    setPending(id, { provider: "xai", deviceCode: data.device_code });
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
    setPending(id, { provider: "anthropic", verifier });
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
    setPending(id, { provider: "google", redirectUri: GOOGLE_REDIRECT, verifier });
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
    setPending(id, { provider: "opencode" });
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

async function googleProject(access: string, fetchImpl: typeof fetch = fetch): Promise<GoogleProjectResponse | undefined> {
  const response = await fetchImpl(ANTIGRAVITY_LOAD_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access}`,
      accept: "*/*",
      "content-type": "application/json",
      "user-agent": antigravityUserAgent(),
    },
    body: JSON.stringify({ metadata: ANTIGRAVITY_LOAD_METADATA }),
  });
  if (!response.ok) return undefined;
  return (await response.json()) as GoogleProjectResponse;
}

export async function ensureGoogleProject(access: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const loaded = await googleProject(access, fetchImpl);
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

async function exchangeGoogleToken(code: string, redirectUri: string, verifier?: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | { error: string }> {
  const params = {
    client_id: googleClientId(),
    code: code.trim(),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    ...(verifier ? { code_verifier: verifier } : {}),
  };
  for (const secret of [...googleClientSecrets(), ""]) {
    const body = new URLSearchParams(secret ? { ...params, client_secret: secret } : params);
    const response = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
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
): Promise<{ done: true }> {
  const projectId = await ensureGoogleProject(tokens.access_token).catch(() => undefined);
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
  pending.delete(id);
  return { done: true };
}

export async function completeOAuthCode(id: string, code: string, authPath: string, accountsPath?: string): Promise<{ done?: boolean; error?: string }> {
  const session = getPending(id);
  if (!session) return { error: "login session expired" };
  if (session.provider === "opencode") {
    const key = code.trim();
    if (!key) return { error: "key required" };
    persistOauth(authPath, "opencode", { type: "api", key }, accountsPath);
    pending.delete(id);
    return { done: true };
  }
  if (session.provider === "google") {
    const tokens = await exchangeGoogleToken(code, session.redirectUri, session.verifier);
    if ("error" in tokens) return tokens;
    return saveGoogleTokens(authPath, tokens, id, accountsPath);
  }
  if (session.provider !== "anthropic") return { error: "login session expired" };
  const splits = code.trim().split("#");
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
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
  });
  if (!response.ok) return { error: `Claude login failed (${response.status})` };
  const tokens = (await response.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  persistOauth(authPath, "anthropic", {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }, accountsPath);
  pending.delete(id);
  return { done: true };
}

export async function completeGoogleCallback(state: string, code: string, authPath: string, accountsPath?: string): Promise<{ done?: boolean; error?: string }> {
  const session = getPending(state);
  if (!session || session.provider !== "google") return { error: "login session expired" };
  const tokens = await exchangeGoogleToken(code, session.redirectUri, session.verifier);
  if ("error" in tokens) return tokens;
  return saveGoogleTokens(authPath, tokens, state, accountsPath);
}

export async function pollOAuth(id: string, authPath: string, accountsPath?: string): Promise<{ done?: boolean; error?: string }> {
  const session = getPending(id);
  if (!session) return { error: "login session expired" };
  if (session.provider === "anthropic" || session.provider === "google" || session.provider === "opencode") return {};
  if (session.provider === "openai") {
    const response = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
    });
    if (response.status === 400 || response.status === 403) return {};
    if (!response.ok) return { error: `OpenAI poll failed (${response.status})` };
    const data = (await response.json()) as { authorization_code?: string; code_verifier?: string };
    if (!data.authorization_code || !data.code_verifier) return {};
    const tokenResponse = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: data.authorization_code,
        redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
        client_id: OPENAI_CLIENT_ID,
        code_verifier: data.code_verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) return { error: `OpenAI token failed (${tokenResponse.status})` };
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string; expires_in?: number };
    persistOauth(authPath, "openai", {
      type: "oauth",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    }, accountsPath);
    pending.delete(id);
    return { done: true };
  }
  const response = await fetch(XAI_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: session.deviceCode,
      client_id: XAI_CLIENT_ID,
    }).toString(),
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
  pending.delete(id);
  return { done: true };
}

const REFRESH_SKEW_MS = 60_000;

function oauthString(entry: Record<string, unknown>, name: string): string | undefined {
  const value = entry[name];
  return typeof value === "string" && value ? value : undefined;
}

async function requestRefresh(
  provider: string,
  refresh: string,
  fetchImpl: typeof fetch,
): Promise<{ access: string; refresh?: string; expiresIn?: number } | undefined> {
  if (provider === "anthropic") {
    const response = await fetchImpl("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLAUDE_CLIENT_ID }),
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
): Promise<string | undefined> {
  if (provider === "anthropic") {
    const code = readClaudeCodeOauth();
    if (code?.access) {
      if (code.expires && Date.now() < code.expires - REFRESH_SKEW_MS) return code.access;
      if (!code.refresh) return code.access;
      const tokens = await requestRefresh(provider, code.refresh, fetchImpl).catch(() => undefined);
      if (!tokens) return code.access;
      writeClaudeCodeOauth({
        access: tokens.access,
        refresh: tokens.refresh ?? code.refresh,
        expires: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
      });
      return tokens.access;
    }
  }
  const raw = readAuthFile(authPath)[provider];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  if (entry.type !== "oauth") return undefined;
  const access = oauthString(entry, "access");
  const refresh = oauthString(entry, "refresh");
  const expires = typeof entry.expires === "number" ? entry.expires : 0;
  if (!force && access && expires && Date.now() < expires - REFRESH_SKEW_MS) return access;
  if (!refresh) return access;
  const tokens = await requestRefresh(provider, refresh, fetchImpl).catch(() => undefined);
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
  opts: { authPath: string; accountsPath?: string; fetchImpl?: typeof fetch; force?: boolean },
): Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (account.type !== "oauth") return account.token;
  if (account.source !== "extra") return (await refreshOAuthToken(account.provider, opts.authPath, fetchImpl, opts.force)) ?? account.token;
  if (!opts.accountsPath || !account.refresh) return account.token;
  if (!opts.force && account.expires && Date.now() < account.expires - REFRESH_SKEW_MS) return account.token;
  const tokens = await requestRefresh(account.provider, account.refresh, fetchImpl).catch(() => undefined);
  if (!tokens) return account.token;
  const expires = Date.now() + (tokens.expiresIn ?? 3600) * 1000;
  updateExtraAccount(opts.accountsPath, account.id, {
    access: tokens.access,
    refresh: tokens.refresh ?? account.refresh,
    expires,
  });
  return tokens.access;
}

export const CONNECT_PROVIDERS: Record<string, { label: string; consoleUrl: string; oauth: boolean; authId: string }> = {
  openai: { label: "OpenAI", consoleUrl: "https://platform.openai.com/api-keys", oauth: true, authId: "openai" },
  anthropic: { label: "Claude", consoleUrl: "https://console.anthropic.com/settings/keys", oauth: true, authId: "anthropic" },
  google: { label: "Gemini / Antigravity", consoleUrl: "https://aistudio.google.com/apikey", oauth: true, authId: "google" },
  antigravity: { label: "Antigravity", consoleUrl: "https://antigravity.google", oauth: true, authId: "google" },
  xai: { label: "Grok", consoleUrl: "https://console.x.ai", oauth: true, authId: "xai" },
  opencode: { label: "OpenCode Zen", consoleUrl: "https://opencode.ai/auth", oauth: true, authId: "opencode" },
};
