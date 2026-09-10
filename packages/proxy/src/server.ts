#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkModelEligibility,
  detectBoundary,
  loadCatalogSync,
  loadConfig,
  passesContextFit,
  selectModel,
  SelectionConstraintError,
  type AvengersProPrediction,
  type Catalog,
  type RouterConfig,
  type RoutingCapability,
  type RoutingTransport,
  type SelectionResult,
  type SelectionRequirements,
  type SessionState,
} from "@auto-router/router-core";
import type { EvalRecorder } from "@auto-router/eval";
import { createAvengersRuntime } from "./avengers-runtime.js";
import {
  accountIdentity,
  defaultAccountsPath,
  listProviderAccounts,
  nextOpenAccount,
  removeExtraAccount,
  saveProviderCredential,
  type ResolvedAccount,
} from "./accounts.js";
import { loginExpires, loginIsOAuth, providerLoginSet, resolveCredential, resolveGoogleProject, UI_PROVIDERS } from "./credentials.js";
import { parseQuota, reconcileUsageQuota, type ProviderQuota } from "./quota.js";
import { ENV_KEYS, defaultEnvPath, readEnvFile, validateEnvValue, writeEnvFile } from "./env-file.js";
import { createProxyRecorderFromEnv, recordProxyResponse } from "./eval-recording.js";
import { memorySessions, resolveSessionIdentity, type ProxySession, type ProxySessionStore, type SessionIdentity } from "./session.js";
import { defaultAuthPath, readAuthFile, writeAuthEntry } from "./auth-store.js";
import { antigravityUserAgent, completeGoogleCallback, completeOAuthCode, CONNECT_PROVIDERS, defaultOAuthStatePath, ensureGoogleProject, pollOAuth, refreshAccountToken, refreshOAuthToken, startOAuth } from "./oauth.js";
import { connectPage } from "./connect-page.js";
import { mainLogin } from "./login-cli.js";
import { loginProviderId } from "./login.js";
import { settingsPage } from "./settings-ui.js";
import { DEFAULT_UPSTREAM_TIMEOUT_MS, validateUpstreamTimeout } from "./upstream-timeout.js";
import { normalizeProviderCompletion, normalizeProviderToolCall } from "./protocol.js";
import { createProxyRequestContext, type FinalResult, type ProxyRequestContext, writeWithBackpressure } from "./request-context.js";
import {
  googleModelDiscovery,
  ModelDiscoveryManager,
  type DiscoveryAccount,
  type DiscoveryCapability,
  type ModelDiscoveryAdapter,
} from "./model-discovery.js";

export interface ProxyBackend {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface CreateProxyServerOptions {
  select: typeof selectModel;
  catalog: Catalog;
  config: RouterConfig;
  sessions: ProxySessionStore;
  backends: Record<string, ProxyBackend>;
  upstreamTimeoutMs?: number;
  avengersArtifactDigest?: string;
  rankAvengers?: (text: string) => AvengersProPrediction | Promise<AvengersProPrediction>;
  recorder?: EvalRecorder;
  envPath?: string;
  authPath?: string;
  accountsPath?: string;
  claudePath?: string;
  oauthStatePath?: string;
  modelDiscovery?: readonly ModelDiscoveryAdapter[];
}

function isLoopbackManagement(req: IncomingMessage): boolean {
  const peer = req.socket?.remoteAddress;
  if (typeof peer === "string" && peer && !isLoopbackHostname(peer)) return false;

  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || !hostHeader) return false;
  const host = parseAuthority(hostHeader);
  if (!host || !isLoopbackHostname(host.hostname)) return false;

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin) {
    try {
      const parsed = new URL(origin);
      if (
        parsed.protocol !== "http:" ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        origin.toLowerCase() !== parsed.origin
      ) {
        return false;
      }
      return isLoopbackHostname(parsed.hostname) && parsed.host.toLowerCase() === host.host.toLowerCase();
    } catch {
      return false;
    }
  }
  return true;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:")) return isLoopbackHostname(normalized.slice("::ffff:".length));
  if (normalized === "localhost") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  return normalized === "::1";
}

function parseAuthority(value: string): URL | undefined {
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

const MANAGEMENT_BODY_LIMIT = 64_000;
const REQUEST_BODY_LIMIT = 2_000_000;
const ANTIGRAVITY_GENERATE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.6-flash": "gemini-3.6-flash-high",
};

class UnsupportedImageContentError extends Error {
  constructor(message = "unsupported image content") {
    super(message);
    this.name = "UnsupportedImageContentError";
  }
}

function upstreamSignal(context: ProxyRequestContext, timeoutMs: number): AbortSignal {
  if (context.remainingMs() <= 0) throw new Error("request timed out");
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([context.signal, timeout]) : timeout;
}

function readBody(req: IncomingMessage, limit = REQUEST_BODY_LIMIT, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        req.destroy();
        fail(new Error("payload too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => fail(error instanceof Error ? error : new Error("read failed")));
    signal?.addEventListener("abort", () => fail(new Error("request timed out")), { once: true });
    if (signal?.aborted) fail(new Error("request timed out"));
  });
}

async function readBodyOrLimit(req: IncomingMessage, res: ServerResponse, limit: number, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await readBody(req, limit, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "payload too large") {
      json(res, 413, { error: "payload too large" });
      return undefined;
    }
    throw error;
  }
}

function pickAccount(
  provider: string,
  modelId: string,
  opts: CreateProxyServerOptions,
  skipped: Set<string>,
  limitedUntil: Map<string, number>,
  discovery?: ModelDiscoveryManager,
): { account?: ResolvedAccount; token?: string; oauth: boolean; discoveryConstrained: boolean; allAccountsLimited: boolean } {
  const credOpts = { env: process.env, authPath: opts.authPath, claudePath: opts.claudePath };
  const accounts = listProviderAccounts(provider, {
    env: process.env,
    authPath: opts.authPath,
    accountsPath: opts.accountsPath,
  });
  const googleApiKey = provider === "google"
    ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || opts.backends.google?.apiKey
    : undefined;
  const eligibleAccounts = googleApiKey ? accounts.filter((item) => item.type !== "oauth") : accounts;
  const now = Date.now();
  const blocked = new Set(skipped);
  for (const [id, until] of limitedUntil) {
    if (until <= now) limitedUntil.delete(id);
    else blocked.add(id);
  }
  const discoveredAccounts = googleApiKey ? undefined : discovery?.accountIdsFor(provider, modelId);
  const discoveryConstrained = discoveredAccounts !== undefined;
  const modelAccounts = discoveredAccounts
    ? eligibleAccounts.filter((candidate) => discoveredAccounts.has(candidate.id))
    : eligibleAccounts;
  const account = nextOpenAccount(modelAccounts, blocked);
  const allAccountsLimited = modelAccounts.length > 0 && modelAccounts.every((candidate) => {
    const key = candidate.sourceKey ?? `${candidate.source}:${candidate.id}`;
    return blocked.has(candidate.id) || blocked.has(key);
  });
  const token = account?.token ?? googleApiKey ?? (discoveryConstrained || allAccountsLimited ? undefined : resolveCredential(modelId, credOpts));
  const oauth = Boolean(
    !googleApiKey && (account ? account.type === "oauth" : token && loginIsOAuth(provider, credOpts)),
  );
  return { account, token, oauth, discoveryConstrained, allAccountsLimited };
}

function accountKey(account: Pick<ResolvedAccount, "id" | "source" | "sourceKey">): string {
  return account.sourceKey ?? `${account.source}:${account.id}`;
}

function retryAfterMs(headers: Headers): number {
  const value = headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(600_000, Math.round(seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(600_000, Math.max(0, date - Date.now()));
  }
  return 300_000;
}

const ZEN_MODEL_HINT = /muse-spark|contributor-free|big-pickle|mimo-v2|nemotron|ling-3|hy3-free|gpt-5|grok-/i;
const CHAT_CREDENTIAL_PROVIDERS = new Set(["openai", "opencode", "xai"]);
const TEXT_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);
const CODEX_AUTO_MODEL = {
  slug: "auto",
  display_name: "Auto Router",
  description: "Task-aware model routing",
  default_reasoning_level: "none",
  supported_reasoning_levels: [],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  additional_speed_tiers: [],
  service_tiers: [],
  availability_nux: null,
  upgrade: null,
  model_messages: {
    instructions_template: "",
    instructions_variables: { personality_default: "", personality_friendly: "", personality_pragmatic: "" },
    approvals: null,
    collaboration_modes: null,
    auto_review: null,
    permissions: null,
  },
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  default_reasoning_summary: "none",
  support_verbosity: false,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: { mode: "tokens", limit: 10000 },
  context_window: 272000,
  max_context_window: 272000,
  comp_hash: "auto-router-v1",
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text"],
  supports_parallel_tool_calls: true,
  supports_image_detail_original: false,
  supports_search_tool: false,
  use_responses_lite: true,
  tool_mode: "code_mode_only",
  multi_agent_version: "v2",
  base_instructions: "",
  auto_compact_token_limit: 244800,
  supports_reasoning_summaries: false,
};

interface TextMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

type IngressProtocol = "chat" | "anthropic" | "responses";

function ingressProtocol(url: string | undefined): IngressProtocol {
  const path = requestPath(url);
  if (path === "/v1/messages" || path === "/messages") return "anthropic";
  if (path === "/v1/responses" || path === "/responses") return "responses";
  return "chat";
}

function requestPath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
}

function hasContentType(req: IncomingMessage, expected: string): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

const INFERENCE_PATHS = new Set([
  "/v1/route",
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/responses",
  "/responses",
  "/v1/messages",
  "/messages",
]);

function bearerToken(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^Bearer\s+/i, "").trim() || undefined;
}

/**
 * Inbound client credentials only apply when the client's protocol matches the
 * routed provider. A client bearer must never become a credential for a different
 * provider or transport.
 */
function inboundCredentials(
  headers: IncomingMessage["headers"],
  protocol: IngressProtocol,
  provider: string
): { authorization?: string | string[]; token?: string } {
  if (protocol === "anthropic" && provider === "anthropic") {
    const apiKey = headers["x-api-key"];
    return { token: typeof apiKey === "string" ? apiKey : bearerToken(headers.authorization) };
  }
  const matches = (protocol === "chat" && CHAT_CREDENTIAL_PROVIDERS.has(provider)) || (protocol === "responses" && provider === "openai");
  if (!matches) return {};
  const authorization = headers.authorization ?? headers.Authorization;
  return { authorization, token: bearerToken(authorization) };
}

function chatgptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      chatgpt_account_id?: string;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    };
    return claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

function isZenBillingError(status: number, payload: string): boolean {
  if (status < 400) return false;
  const text = payload.toLowerCase();
  return (
    text.includes("payment method") ||
    text.includes("creditserror") ||
    text.includes("add a payment") ||
    text.includes("missingsessionid") ||
    text.includes("only be used in opencode")
  );
}

function catalogExcluding(catalog: Catalog, skipped: Set<string>): Catalog {
  if (skipped.size === 0) return catalog;
  const models = catalog.models.filter((model) => {
    const id = model.runtimeId ?? model.id;
    const slash = id.indexOf("/");
    const provider = slash >= 0 ? id.slice(0, slash) : "";
    return !skipped.has(provider);
  });
  return models.length > 0 ? { ...catalog, models } : catalog;
}

function resolveProvider(modelId: string): { provider: string; bareModel: string } {
  const slash = modelId.indexOf("/");
  const providerFromId = slash >= 0 ? modelId.slice(0, slash) : "";
  const bareModel = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  if (providerFromId === "google" || providerFromId === "gemini" || providerFromId === "antigravity" || /^gemini/i.test(bareModel)) {
    return { provider: "google", bareModel };
  }
  if (providerFromId === "anthropic" || (!providerFromId && /^claude/i.test(bareModel))) {
    return { provider: "anthropic", bareModel };
  }
  if (providerFromId === "opencode" || (!providerFromId && ZEN_MODEL_HINT.test(bareModel))) {
    return { provider: "opencode", bareModel };
  }
  return { provider: providerFromId || "openai", bareModel };
}

function qualifyModel(model: string): string {
  if (model.includes("/")) return model;
  const { provider, bareModel } = resolveProvider(model);
  return `${provider}/${bareModel}`;
}

function configuredUpstreamTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTO_ROUTER_UPSTREAM_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return validateUpstreamTimeout(Number(raw));
}

function requestedModel(body: any): string | undefined {
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!model || model === "auto" || model === "free-auto" || model === "go-auto") return undefined;
  const qualified = qualifyModel(model);
  if (resolveProvider(qualified).provider !== "anthropic") return undefined;
  return qualified;
}

function messageText(content: any): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part: any) => ["text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
  return text || undefined;
}

type CanonicalContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

function imageDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/is.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

function isImagePart(part: any): boolean {
  return ["image", "image_url", "input_image"].includes(part?.type)
    || (typeof part?.source?.media_type === "string" && part.source.media_type.toLowerCase().startsWith("image/"));
}

function isSupportedImageUrl(url: string): boolean {
  return Boolean(imageDataUrl(url)) || /^https?:\/\//i.test(url);
}

function imageUrlPart(part: any): { url: string; detail?: string } | undefined {
  if (!part || typeof part !== "object") return undefined;
  const detail = typeof part.detail === "string" ? part.detail : typeof part.image_url?.detail === "string" ? part.image_url.detail : undefined;
  if (part.type === "image_url" || part.type === "input_image") {
    const image = part.image_url;
    const url = typeof image === "string" ? image : image?.url;
    if (typeof url === "string" && url) return { url, ...(detail ? { detail } : {}) };
  }
  if (part.type !== "image") return undefined;
  const source = part.source;
  if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { url: `data:${source.media_type};base64,${source.data}`, ...(detail ? { detail } : {}) };
  }
  if (source?.type === "url" && typeof source.url === "string" && source.url) {
    return { url: source.url, ...(detail ? { detail } : {}) };
  }
  return undefined;
}

function canonicalContentParts(value: unknown): CanonicalContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((part: any): CanonicalContentPart[] => {
    if (["text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (isImagePart(part)) {
      const image = imageUrlPart(part);
      if (!image || !isSupportedImageUrl(image.url)) throw new UnsupportedImageContentError();
      return [{ type: "image_url", image_url: image }];
    }
    return [];
  });
}

function canonicalMessageContent(value: unknown): string | CanonicalContentPart[] | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = canonicalContentParts(value);
  if (!parts.length) return undefined;
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

function anthropicMessages(body: any): any[] {
  const system = messageText(body?.system);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const normalized = messages.flatMap((message: any) => {
    if (!Array.isArray(message?.content)) return [{ role: message.role, content: message.content }];
    const items: any[] = [];
    const content = canonicalMessageContent(message.content);
    if (content !== undefined) items.push({ role: message.role, content });
    for (const part of message.content) {
      if (part?.type === "tool_use") {
        items.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } }],
        });
      }
      if (part?.type === "tool_result") {
        items.push({ role: "tool", tool_call_id: part.tool_use_id, content: messageText(part.content) ?? String(part.content ?? "") });
      }
    }
    return items;
  });
  return system ? [{ role: "system", content: system }, ...normalized] : normalized;
}

function responsesMessages(body: any): any[] {
  const input = typeof body?.input === "string" ? [{ role: "user", content: body.input }] : Array.isArray(body?.input) ? body.input : [];
  const messages = input.flatMap((item: any) => {
    if (item?.type === "function_call") {
      return [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } }],
      }];
    }
    if (item?.type === "function_call_output") {
      return [{ role: "tool", tool_call_id: item.call_id, content: messageText(item.output) ?? String(item.output ?? "") }];
    }
    if (item?.type === "input_image" || item?.type === "input_text") {
      const content = canonicalMessageContent([item]);
      return content === undefined ? [] : [{ role: "user", content }];
    }
    if (TEXT_MESSAGE_ROLES.has(item?.role)) {
      const content = canonicalMessageContent(item.content);
      return content === undefined ? [] : [{ role: item.role, content }];
    }
    return [];
  });
  const instructions = messageText(body?.instructions);
  return instructions ? [{ role: "system", content: instructions }, ...messages] : messages;
}

function normalizeIngress(body: any, protocol: IngressProtocol): any {
  if (protocol === "chat") return body;
  if (protocol === "anthropic") {
    const tools = (Array.isArray(body?.tools) ? body.tools : []).map((tool: any) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));
    return {
      model: body.model,
      messages: anthropicMessages(body),
      stream: body.stream,
      max_completion_tokens: body.max_tokens,
      ...(tools.length ? { tools } : {}),
    };
  }
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === "function" && tool.name)
    .map((tool: any) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  return {
    model: body.model,
    messages: responsesMessages(body),
    stream: body.stream,
    max_completion_tokens: body.max_output_tokens,
    ...(tools.length ? { tools } : {}),
  };
}

function textMessages(body: any): TextMessage[] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.flatMap((message: any) => {
    const content = messageText(message?.content);
    if (!TEXT_MESSAGE_ROLES.has(message?.role) || content === undefined) return [];
    return [{ role: message.role, content } as TextMessage];
  });
}

function lastUserText(messages: TextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function zenTools(body: any): unknown[] {
  return (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === "function" && tool.function?.name)
    .map((tool: any) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
}

function responseInputContent(value: unknown): string | unknown[] | undefined {
  const content = canonicalMessageContent(value);
  if (content === undefined || typeof content === "string") return content;
  if (content.every((part) => part.type === "text")) {
    return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) },
  );
}

function zenInput(body: any): unknown[] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.flatMap((message: any) => {
    if (message?.role === "tool") {
      return [{ type: "function_call_output", call_id: message.tool_call_id, output: messageText(message.content) ?? "" }];
    }
    const content = TEXT_MESSAGE_ROLES.has(message?.role) ? responseInputContent(message?.content) : undefined;
    const text = content !== undefined ? [{ role: message.role, content }] : [];
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
          .filter((call: any) => call?.function?.name)
          .map((call: any) => ({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments ?? "{}",
          }))
      : [];
    return [...text, ...calls];
  });
}

function zenRequest(body: any, model: string): Record<string, unknown> {
  const tools = zenTools(body);
  const maxOutputTokens = body?.max_completion_tokens ?? body?.max_tokens;
  return {
    model,
    input: zenInput(body),
    ...(tools.length ? { tools } : {}),
    ...(typeof maxOutputTokens === "number" ? { max_output_tokens: maxOutputTokens } : {}),
    ...(typeof body?.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body?.top_p === "number" ? { top_p: body.top_p } : {}),
  };
}

function zenFunctionCalls(payload: any): Array<{ id: string; name: string; arguments: string }> {
  return (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item: any) => item?.type === "function_call" && item.name)
    .flatMap((item: any) => {
      const normalized = normalizeProviderToolCall(item.call_id ?? item.id, item.name, item.arguments ?? "{}");
      return normalized ? [{ id: normalized.id, name: normalized.name, arguments: JSON.stringify(normalized.arguments) }] : [];
    });
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: raw ?? "" };
  } catch {
    return { result: raw ?? "" };
  }
}

function anthropicContentBlocks(content: unknown): unknown[] {
  return canonicalContentParts(content).map((part) => {
    if (part.type === "text") return part;
    const data = imageDataUrl(part.image_url.url);
    return data
      ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } }
      : { type: "image", source: { type: "url", url: part.image_url.url } };
  });
}

function anthropicRequestMessages(body: any): unknown[] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.flatMap((message: any) => {
    if (message?.role === "system" || message?.role === "developer") return [];
    if (message?.role === "tool") {
      return [{ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: messageText(message.content) ?? "" }] }];
    }
    if (message?.role !== "user" && message?.role !== "assistant") return [];
    const contentBlocks = anthropicContentBlocks(message.content);
    const toolBlocks = Array.isArray(message?.tool_calls)
      ? message.tool_calls
          .filter((call: any) => call?.function?.name)
          .map((call: any) => ({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          }))
      : [];
    const blocks = [...contentBlocks, ...toolBlocks];
    if (!blocks.length) return [];
    return [{ role: message.role, content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks }];
  });
}

function anthropicRequest(body: any, model: string): Record<string, unknown> {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages
    .filter((message: any) => message?.role === "system" || message?.role === "developer")
    .map((message: any) => messageText(message.content) ?? "")
    .filter(Boolean)
    .join("\n");
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === "function" && tool.function?.name)
    .map((tool: any) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  const maxTokens = body?.max_completion_tokens ?? body?.max_tokens;
  return {
    model,
    messages: anthropicRequestMessages(body),
    ...(system ? { system } : {}),
    ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

const GEMINI_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "enum",
  "items",
  "format",
  "nullable",
  "default",
  "example",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "minItems",
  "propertyOrdering",
  "title",
]);

function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_ALLOW.has(key)) continue;
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      const props: Record<string, unknown> = {};
      for (const [pKey, pVal] of Object.entries(child as Record<string, unknown>)) {
        props[pKey] = geminiSchema(pVal);
      }
      out[key] = props;
    } else if (key === "items" && child && typeof child === "object") {
      out[key] = geminiSchema(child);
    } else if (key === "properties" || key === "required" || key === "enum" || key === "propertyOrdering") {
      out[key] = child;
    } else if (typeof child === "object" && child !== null) {
      // for nested schema objects, recurse but only if they look like schema
      // if child is plain string/value, keep as is
      const sanitized = geminiSchema(child);
      // Only keep if sanitized is object with allowed keys or primitive
      if (sanitized && typeof sanitized === "object" && Object.keys(sanitized as object).length === 0) continue;
      out[key] = sanitized;
    } else {
      out[key] = child;
    }
  }
  return out;
}

function geminiTools(body: any): unknown[] {
  const declarations = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === "function" && tool.function?.name)
    .map((tool: any) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: geminiSchema(tool.function.parameters),
    }));
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function geminiContentParts(content: unknown): unknown[] {
  return canonicalContentParts(content).map((part) => {
    if (part.type === "text") return { text: part.text };
    const data = imageDataUrl(part.image_url.url);
    if (!data) throw new UnsupportedImageContentError("Google image translation requires base64 image data");
    return { inlineData: { mimeType: data.mediaType, data: data.data } };
  });
}

const geminiThoughtSignatures = new Map<string, string>();

function antigravitySessionId(sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey || "global").digest();
  const value = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${value.toString()}`;
}

function antigravityModel(model: string): string {
  return ANTIGRAVITY_MODEL_ALIASES[model] ?? model;
}

function antigravityRequest(model: string, body: any, projectId: string | undefined, sessionKey: string): Record<string, unknown> {
  const upstreamModel = antigravityModel(model);
  const request = geminiRequest(body);
  const imageModel = upstreamModel.toLowerCase().includes("image");
  return {
    model: upstreamModel,
    userAgent: "antigravity",
    requestType: imageModel ? "image_gen" : "agent",
    requestId: imageModel ? `image_gen/${Date.now()}/${randomUUID()}/12` : `agent-${randomUUID()}`,
    ...(projectId ? { project: projectId } : {}),
    request: { ...request, sessionId: antigravitySessionId(sessionKey) },
  };
}

function unwrapAntigravityResponse(payload: any): any {
  const response = payload?.response;
  return response && typeof response === "object" ? response : payload;
}

function geminiRequest(body: any, sessionKey = "global"): Record<string, unknown> {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemParts = messages
    .filter((message: any) => message?.role === "system" || message?.role === "developer")
    .map((message: any) => ({ text: messageText(message.content) ?? "" }))
    .filter((part: { text: string }) => part.text);
  const contents: unknown[] = [];
  for (const message of messages) {
    if (message?.role === "system" || message?.role === "developer") continue;
    if (message?.role === "tool") {
      const name = messages
        .flatMap((item: any) => item?.tool_calls ?? [])
        .find((call: any) => call.id === message.tool_call_id)?.function?.name;
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: name ?? "tool", response: { result: messageText(message.content) ?? "" } } }],
      });
      continue;
    }
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = geminiContentParts(message?.content);
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
          .filter((call: any) => call?.function?.name)
          .map((call: any) => {
            const sig =
              (call as any).thoughtSignature ??
              (call as any).thought_signature ??
              (call as any).function?.thoughtSignature ??
              (call as any).function?.thought_signature ??
              geminiThoughtSignatures.get(`${sessionKey}:${call.id}`);
            const fc: Record<string, unknown> = { name: call.function.name, args: parseToolArguments(call.function.arguments) };
            if ((call as any).id) (fc as any).id = (call as any).id;
            if (sig) return { functionCall: fc, thoughtSignature: sig } as unknown;
            return { functionCall: fc };
          })
      : [];
    const parts = [...text, ...calls];
    if (!parts.length) continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }
  const tools = geminiTools(body);
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
    ...(tools.length ? { tools } : {}),
  };
}

function geminiFunctionCalls(payload: any, sessionKey = "global"): Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }> {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return (Array.isArray(parts) ? parts : [])
    .filter((part: any) => part?.functionCall?.name)
    .map((part: any, index: number) => {
      const sig = part.thoughtSignature ?? part.thought_signature ?? part.functionCall?.thoughtSignature ?? part.functionCall?.thought_signature;
       const id = part.functionCall?.id ?? `call_${randomUUID()}`;
       if (sig) geminiThoughtSignatures.set(`${sessionKey}:${id}`, sig);
      return {
        id,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
        ...(sig ? { thoughtSignature: sig } : {}),
      };
    });
}

interface UpstreamRequest {
  body: unknown;
  path: string;
  translateResponse: boolean;
  useGemini: boolean;
}

function upstreamRequest(
  protocol: IngressProtocol,
  originalBody: any,
  normalizedBody: any,
  provider: string,
  model: string,
  token: string | undefined,
  projectId?: string,
  sessionKey?: string,
  googleOAuth?: boolean,
  openaiOAuth?: boolean,
  anthropicOAuth?: boolean,
): UpstreamRequest {
  if (provider === "openai" && openaiOAuth) {
    const converted = protocol === "responses" ? { ...originalBody, model } : zenRequest(normalizedBody, model);
    const { max_output_tokens: _max, temperature: _temp, top_p: _top, ...rest } = converted as Record<string, unknown>;
    const body = { ...rest, store: false, stream: true };
    return {
      body,
      path: "https://chatgpt.com/backend-api/codex/responses",
      translateResponse: protocol !== "responses",
      useGemini: false,
    };
  }
  if (provider === "openai" && protocol === "responses") {
    return { body: { ...originalBody, model }, path: "/v1/responses", translateResponse: false, useGemini: false };
  }
  if (provider === "google") {
    const isStream = !!normalizedBody.stream && protocol === "chat";
    if (token && googleOAuth) {
      const action = isStream ? "streamGenerateContent" : "generateContent";
      const alt = isStream ? "?alt=sse" : "";
      return {
        body: antigravityRequest(model, normalizedBody, projectId, sessionKey ?? "global"),
        path: `${ANTIGRAVITY_GENERATE_BASE_URL}/v1internal:${action}${alt}`,
        translateResponse: true,
        useGemini: true,
      };
    }
    const key = token ? `?key=${encodeURIComponent(token)}` : "";
    const alt = isStream ? (key ? "&alt=sse" : "?alt=sse") : "";
    const action = isStream ? "streamGenerateContent" : "generateContent";
    return { body: geminiRequest(normalizedBody, sessionKey ?? "global"), path: `/models/${model}:${action}${key}${alt}`, translateResponse: true, useGemini: true };
  }
  if (provider === "anthropic") {
    const native = protocol === "anthropic";
    const messagesPath = anthropicOAuth ? "/v1/messages?beta=true" : "/v1/messages";
    if (native) {
      return { body: { ...originalBody, model }, path: messagesPath, translateResponse: !native, useGemini: false };
    }
    const body: any = { ...anthropicRequest(normalizedBody, model), stream: false };
    if (anthropicOAuth) {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
      body.system = body.system ? `${prefix}\n\n${body.system}` : prefix;
    }
    return { body, path: messagesPath, translateResponse: !native, useGemini: false };
  }
  if (provider === "opencode") {
    const body: any = { ...zenRequest(normalizedBody, model), stream: false };
    return { body, path: "/v1/responses", translateResponse: true, useGemini: false };
  }

  const body = { ...normalizedBody, ...(protocol === "chat" ? {} : { stream: false }), model };
  return {
    body,
    path: "/v1/chat/completions",
    translateResponse: protocol !== "chat",
    useGemini: false,
  };
}

function hasImageContent(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.some((item: any) => {
    if (!item || typeof item !== "object") return false;
    if (["image", "image_url", "input_image"].includes(item.type)) return true;
    return typeof item.source?.media_type === "string" && item.source.media_type.toLowerCase().startsWith("image/");
  });
}

function routingCapabilities(body: any): RoutingCapability[] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const input = Array.isArray(body?.input) ? body.input : [];
  const declaredTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const toolMessages = messages.some(
    (message: any) =>
      message?.role === "tool" ||
      (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
  );
  const inputToolMessages = input.some((item: any) => ["function_call", "function_call_output"].includes(item?.type));
  const capabilities: RoutingCapability[] = ["text"];
  if (declaredTools || toolMessages || inputToolMessages) capabilities.push("tools");
  if (messages.some((message: any) => hasImageContent(message?.content)) || input.some((item: any) => hasImageContent(item) || hasImageContent(item?.content))) {
    capabilities.push("vision");
  }
  const formats = [body?.response_format, body?.text?.format, body?.output_config?.format, body?.outputConfig?.format];
  if (formats.some((format: any) => format && typeof format === "object" && format.type !== "text")) capabilities.push("structured-output");
  return capabilities;
}

function discoveryCapabilities(body: any): DiscoveryCapability[] {
  return routingCapabilities(body).flatMap((capability) => {
    if (capability === "vision") return ["image"];
    if (capability === "text" || capability === "tools") return [capability];
    return [];
  });
}

function selectionRequirements(body: any, protocol: IngressProtocol, lifetimeTokens: number): SelectionRequirements {
  return {
    lifetimeTokens,
    requiredCapabilities: routingCapabilities(body),
    transport: protocol as RoutingTransport,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function addFileHints(args: Record<string, unknown>, files: Set<string>): void {
  for (const key of ["path", "file", "filePath"]) {
    const value = args[key];
    if (typeof value === "string" && value) files.add(value);
  }
  const listed = args.files;
  if (Array.isArray(listed)) {
    for (const value of listed) if (typeof value === "string" && value) files.add(value);
  }
  const patch = args.patchText ?? args.patch;
  if (typeof patch !== "string") return;
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm)) files.add(match[1]);
}

function requestSignals(body: any): { filesTouched: number; diffHunks: number; toolDepth: number; priorErrors: number } {
  const files = new Set<string>();
  let diffHunks = 0;
  let toolDepth = 0;
  let priorErrors = 0;
  const messages = Array.isArray(body?.messages) ? body.messages : [];

  for (const message of messages) {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    toolDepth += calls.length;
    for (const call of calls) {
      const args = parseToolArguments(call?.function?.arguments);
      addFileHints(args, files);
      const patch = args.patchText ?? args.patch;
      if (typeof patch === "string") diffHunks += patch.match(/^@@/gm)?.length ?? 0;
    }
    if (message?.role === "tool" && /error|failed|exception|not found/i.test(messageText(message.content) ?? "")) priorErrors += 1;
  }

  return { filesTouched: files.size, diffHunks, toolDepth, priorErrors };
}

function sessionState(body: any, text: string, isNewSession: boolean): SessionState {
  const promptTokens = estimateTokens(text);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const taskTokens = estimateTokens(JSON.stringify({ messages, tools }));
  const signals = requestSignals(body);
  return {
    lifetimeTokens: taskTokens,
    currentTask: {
      promptTokens,
      taskTokens,
      filesTouched: signals.filesTouched,
      diffHunks: signals.diffHunks,
      toolDepth: signals.toolDepth,
      lastUserMessage: text,
      priorErrors: signals.priorErrors,
    },
    isNewSession,
  };
}

function html(res: ServerResponse, status: number, body: string): void {
  if (typeof res.writeHead === "function") res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  else {
    res.statusCode = status;
    res.setHeader?.("content-type", "text/html; charset=utf-8");
  }
  res.end(body);
}

function parseSsePayload(raw: string): unknown {
  let last: Record<string, unknown> | undefined;
  let message: unknown;
  let text = "";
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find((part) => part.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { type?: string; text?: string; item?: unknown; response?: Record<string, unknown> };
      if (parsed.type === "response.output_text.done" && parsed.text) text += parsed.text;
      if (parsed.type === "response.output_item.done" && parsed.item) message = parsed.item;
      last = parsed.response ?? parsed;
    } catch {}
  }
  if (!last) return undefined;
  const output = Array.isArray(last.output) ? last.output : [];
  if (output.length) return last;
  if (message) return { ...last, output: [message] };
  if (text) return { ...last, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
  return last;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  if (typeof res.writeHead === "function") res.writeHead(status, { "content-type": "application/json" });
  else {
    res.statusCode = status;
    res.setHeader?.("content-type", "application/json");
  }
  res.end(body);
}

function nativeResponse(payload: any, provider: string): { content: string; refusal?: string } {
  const normalized = normalizeProviderCompletion(payload, provider);
  return { content: normalized.text, ...(normalized.refusal ? { refusal: normalized.refusal } : {}) };
}

type ChatFinishReason = "stop" | "length" | "content_filter" | "tool_calls";

function nativeFinishReason(payload: any, provider: string, refusal?: string, toolCalls: unknown[] = []): ChatFinishReason {
  if (toolCalls.length) return "tool_calls";
  if (provider === "openai" && Array.isArray(payload?.output)) {
    if (refusal) return "content_filter";
    if (!payload?.status || payload.status === "completed") return "stop";
    if (payload.status === "incomplete" && payload?.incomplete_details?.reason === "max_output_tokens") return "length";
    return "content_filter";
  }
  if (provider === "openai") {
    const reason = payload?.choices?.[0]?.finish_reason;
    if (reason === "length") return "length";
    if (reason === "content_filter" || refusal) return "content_filter";
    return "stop";
  }
  if (provider === "google") {
    const reason = payload?.candidates?.[0]?.finishReason ?? payload?.promptFeedback?.blockReason;
    if (!reason || reason === "STOP") return "stop";
    if (reason === "MAX_TOKENS") return "length";
    return "content_filter";
  }
  if (provider === "anthropic") {
    const reason = payload?.stop_reason;
    if (reason === "max_tokens") return "length";
    if (reason === "refusal" || refusal) return "content_filter";
    return "stop";
  }

  if (refusal) return "content_filter";
  if (!payload?.status || payload.status === "completed") return "stop";
  if (payload.status === "incomplete" && payload?.incomplete_details?.reason === "max_output_tokens") return "length";
  return "content_filter";
}

type ResponseStatus = "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
const RESPONSE_STATUSES = new Set<ResponseStatus>(["completed", "failed", "in_progress", "cancelled", "queued", "incomplete"]);

function nativeResponseStatus(payload: any, finishReason: ChatFinishReason): ResponseStatus {
  if (RESPONSE_STATUSES.has(payload?.status)) return payload.status;
  if (finishReason === "length" || finishReason === "content_filter") return "incomplete";
  return "completed";
}

function nativeIncompleteDetails(payload: any, status: ResponseStatus, finishReason: ChatFinishReason): unknown {
  if (status !== "incomplete") return undefined;
  if (payload?.incomplete_details) return payload.incomplete_details;
  if (finishReason === "length") return { reason: "max_output_tokens" };
  if (finishReason === "content_filter") return { reason: "content_filter" };
  return undefined;
}

interface NativeChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
}

/**
 * Maps each upstream provider's native usage envelope to OpenAI chat-completion
 * usage shape so downstream consumers (billing, eval collection) get real
 * provider-reported token counts instead of silently missing usage.
 */
function nativeUsage(payload: any, provider: string): NativeChatUsage | undefined {
  const usage = normalizeProviderCompletion(payload, provider).usage;
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadInputTokens || usage.cacheWriteInputTokens
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens, cache_creation_tokens: usage.cacheWriteInputTokens } }
      : {}),
  };
}

function writeChatCompletion(res: ServerResponse, body: any, provider: string, model: string, payload: any, sessionKey = "global"): void {
  const id = String(payload?.id ?? `chatcmpl-${Date.now()}`);
  const created = Math.floor(Date.now() / 1000);
  const { content, refusal } = nativeResponse(payload, provider);
  const toolCalls = nativeToolCalls(payload, provider, sessionKey);
  const finishReason = nativeFinishReason(payload, provider, refusal, toolCalls);
  const usage = nativeUsage(payload, provider);
  const message = refusal
    ? { role: "assistant", content: content || null, refusal }
    : toolCalls.length
      ? {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        }
      : { role: "assistant", content };

  if (!body?.stream) {
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
    return;
  }

  const delta = refusal
    ? { role: "assistant", content: content || null, refusal }
    : toolCalls.length
      ? {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        }
      : { role: "assistant", content };
  const chunks = [
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }] },
  ];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
}

function nativeToolCalls(payload: any, provider: string, sessionKey = "global"): Array<{ id: string; name: string; arguments: string }> {
  if (provider === "openai" && Array.isArray(payload?.output)) return zenFunctionCalls(payload);
  if (provider === "openai") {
    const calls = payload?.choices?.[0]?.message?.tool_calls;
    return (Array.isArray(calls) ? calls : [])
      .filter((call: any) => call?.function?.name)
      .flatMap((call: any) => {
        const normalized = normalizeProviderToolCall(call.id, call.function.name, call.function.arguments ?? "{}");
        return normalized ? [{ id: normalized.id, name: normalized.name, arguments: JSON.stringify(normalized.arguments) }] : [];
      });
  }
  if (provider === "google") return geminiFunctionCalls(payload, sessionKey);
  if (provider === "anthropic") {
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    return blocks
      .filter((block: any) => block?.type === "tool_use" && block.id && block.name)
      .flatMap((block: any) => {
        const normalized = normalizeProviderToolCall(block.id, block.name, block.input ?? {});
        return normalized ? [{ id: normalized.id, name: normalized.name, arguments: JSON.stringify(normalized.arguments) }] : [];
      });
  }
  if (provider === "opencode") return zenFunctionCalls(payload);
  return [];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function writeAnthropicMessage(res: ServerResponse, body: any, provider: string, model: string, payload: any, sessionKey = "global"): void {
  const { content, refusal } = nativeResponse(payload, provider);
  const toolCalls = nativeToolCalls(payload, provider, sessionKey);
  const finishReason = nativeFinishReason(payload, provider, refusal, toolCalls);
  const blocks: AnthropicContentBlock[] = [
    ...(content || refusal ? [{ type: "text" as const, text: content || refusal || "" }] : []),
    ...toolCalls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: parseToolArguments(call.arguments) })),
  ];
  const message = {
    id: String(payload?.id ?? `msg_${Date.now()}`),
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: payload?.usage?.input_tokens ?? 0, output_tokens: payload?.usage?.output_tokens ?? 0 },
  };
  if (!body?.stream) {
    json(res, 200, message);
    return;
  }

  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } }],
  ];
  blocks.forEach((block, index) => {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } }]);
    if (block.type === "text") {
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(
    ["message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage }],
    ["message_stop", { type: "message_stop" }]
  );
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
}

function responsesStreamEvents(response: any): Array<[string, unknown]> {
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown>): [string, unknown] => [type, { type, sequence_number: sequence++, ...data }];
  const events = [event("response.created", { response: { ...response, status: "in_progress", output: [] } })];
  const output = Array.isArray(response.output) ? response.output : [];
  output.forEach((item: any, outputIndex: number) => {
    events.push(event("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : {}) } }));
    if (item.type === "message") {
      const parts = Array.isArray(item.content) ? item.content : [];
      parts.forEach((part: any, contentIndex: number) => {
        const refusal = part?.type === "refusal";
        events.push(event("response.content_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: refusal ? { type: "refusal", refusal: "" } : { ...part, text: "" },
        }));
        if (refusal) {
          events.push(event("response.refusal.delta", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.refusal ?? "" }));
          events.push(event("response.refusal.done", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, refusal: part.refusal ?? "" }));
        } else {
          events.push(event("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text ?? "" }));
          events.push(event("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text ?? "" }));
        }
        events.push(event("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, part }));
      });
    } else {
      events.push(event("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: item.arguments ?? "" }));
      events.push(event("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: item.arguments ?? "" }));
    }
    events.push(event("response.output_item.done", { output_index: outputIndex, item }));
  });
  const terminalEvent = response.status === "incomplete" ? "response.incomplete" : response.status === "failed" ? "response.failed" : "response.completed";
  events.push(event(terminalEvent, { response }));
  return events;
}

function writeResponsesPayload(res: ServerResponse, body: any, provider: string, model: string, payload: any, sessionKey = "global"): void {
  const { content, refusal } = nativeResponse(payload, provider);
  const toolCalls = nativeToolCalls(payload, provider, sessionKey);
  const finishReason = nativeFinishReason(payload, provider, refusal, toolCalls);
  const status = nativeResponseStatus(payload, finishReason);
  const incompleteDetails = nativeIncompleteDetails(payload, status, finishReason);
  const outputStatus = status === "incomplete" ? "incomplete" : "completed";
  const id = String(payload?.id ?? `resp_${Date.now()}`);
  const output = [
    ...(content || refusal
      ? [{ id: `msg_${id}`, type: "message", status: outputStatus, role: "assistant", content: [{ type: refusal ? "refusal" : "output_text", [refusal ? "refusal" : "text"]: refusal || content }] }]
      : []),
    ...toolCalls.map((call) => ({ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.arguments, status: outputStatus })),
  ];
  const response = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: payload?.usage,
    ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
  };
  if (!body?.stream) {
    json(res, 200, response);
    return;
  }

  const events = responsesStreamEvents(response);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
}

export function createProxyServer(opts: CreateProxyServerOptions): {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): void;
} {
  const upstreamTimeoutMs = validateUpstreamTimeout(opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS);
  const skippedProviders = new Set<string>();
  const routeLog: Array<{ at: number; via: string; modelId: string; status?: number }> = [];
  const quotas = new Map<string, ProviderQuota>();
  const limitedUntil = new Map<string, number>();
  const modelDiscovery = new ModelDiscoveryManager(opts.modelDiscovery ?? []);
  const accountsFile = () => opts.accountsPath;
  const storeQuota = (key: string, sample: ProviderQuota) => {
    const previous = quotas.get(key);
    if (previous && previous.at > sample.at) return;
    if (previous && previous.meters.length > 0 && sample.meters.length === 0 && sample.status >= 200 && sample.status < 300) return;
    quotas.set(key, sample);
  };

  interface Decision {
    result: SelectionResult;
    state: SessionState;
  }

  async function discoveryCatalog(body: any, signal?: AbortSignal): Promise<Catalog> {
    if (!opts.modelDiscovery?.length) return opts.catalog;
    const authFile = opts.authPath ?? defaultAuthPath();
    const credOpts = { env: process.env, authPath: opts.authPath, claudePath: opts.claudePath };
    const accounts = new Map<string, DiscoveryAccount[]>();
    const fetches = new Map<string, typeof fetch>();
    for (const adapter of opts.modelDiscovery) {
      const googleApiKey = adapter.provider === "google"
        ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || opts.backends.google?.apiKey
        : undefined;
      if (googleApiKey) {
        accounts.set(adapter.provider, []);
        continue;
      }
      const providerAccounts = listProviderAccounts(adapter.provider, {
        env: process.env,
        authPath: opts.authPath,
        accountsPath: accountsFile(),
      }).filter((account) => account.type === "oauth");
      const discoveredAccounts: DiscoveryAccount[] = [];
      for (const account of providerAccounts) {
        const token = await refreshAccountToken(account, {
          authPath: authFile,
          accountsPath: accountsFile(),
          fetchImpl: opts.backends[adapter.provider]?.fetchImpl ?? fetch,
          signal,
        });
        if (!token) continue;
        discoveredAccounts.push({
          id: account.id,
          token,
          ...(adapter.provider === "google"
            ? { projectId: account.projectId ?? (account.primary ? resolveGoogleProject(credOpts) : undefined) }
            : {}),
        });
      }
      accounts.set(adapter.provider, discoveredAccounts);
      const fetchImpl = opts.backends[adapter.provider]?.fetchImpl;
      if (fetchImpl) fetches.set(adapter.provider, fetchImpl);
    }
    return modelDiscovery.prepareCatalog(opts.catalog, accounts, discoveryCapabilities(body), fetches, signal);
  }

  async function decide(
    req: IncomingMessage,
    body: any,
    text: string,
    identity: SessionIdentity,
    protocol: IngressProtocol,
    capabilityBody: any = body,
    signal?: AbortSignal,
  ): Promise<Decision> {
    const id = identity.id;
    const stored = opts.sessions.get(id);
    const baseState = sessionState(body, text, !stored.taskTarget);
    const requirements = selectionRequirements(capabilityBody, protocol, baseState.lifetimeTokens);
    const state: SessionState = {
      ...baseState,
      requiredCapabilities: requirements.requiredCapabilities,
      transport: requirements.transport,
    };
    const boundary = detectBoundary(state, undefined, stored.prevMessage);
    const lockedProvider = stored.taskTarget ? resolveProvider(stored.taskTarget).provider : "";
    const persist = (next: ProxySession) => {
      if (identity.stable) opts.sessions.set(id, next);
    };
    const forcedHeader = req.headers["x-force-model"];
    if (typeof forcedHeader === "string" && forcedHeader) {
      const result: SelectionResult = {
        modelId: forcedHeader,
        tier: "simple",
        taskType: null,
        confidence: 1,
        reason: "x-force-model",
        via: "force",
        catalogSource: opts.catalog.source,
        score: 0,
        boundary,
      };
      persist({ taskTarget: result.modelId, prevMessage: text });
      return { result, state };
    }
    if (stored.taskTarget && !boundary.isBoundary && !skippedProviders.has(lockedProvider)) {
      let stickyCatalog = opts.catalog;
      let current = stickyCatalog.models.find((model) => model.id === stored.taskTarget || (model.runtimeId ?? model.id) === stored.taskTarget);
      const stickyDiscovery = !current && (opts.modelDiscovery?.some((adapter) => adapter.provider === lockedProvider) ?? false);
      if (stickyDiscovery) {
        stickyCatalog = await discoveryCatalog(capabilityBody, signal);
        current = stickyCatalog.models.find((model) => model.id === stored.taskTarget || (model.runtimeId ?? model.id) === stored.taskTarget);
        if (!current) throw new Error(`sticky model ${stored.taskTarget} is unavailable`);
      }
      if (current) {
        const eligibility = checkModelEligibility(current, requirements, opts.config);
        if (!eligibility.pass) throw new SelectionConstraintError(eligibility.code, eligibility.reason);
      }
      if (!current || passesContextFit(state.lifetimeTokens, current, opts.config).pass) {
        return {
          result: {
            modelId: stored.taskTarget,
            tier: "simple",
            taskType: null,
            confidence: 1,
            reason: "task lock",
            via: "stay-sticky",
            catalogSource: stickyCatalog.source,
            score: 0,
            boundary,
          },
          state,
        };
      }
    }

    const forced = requestedModel(body);
    if (forced) {
      const result: SelectionResult = {
        modelId: forced,
        tier: "simple",
        taskType: null,
        confidence: 1,
        reason: "x-force-model",
        via: "force",
        catalogSource: opts.catalog.source,
        score: 0,
        boundary,
      };
      persist({ taskTarget: result.modelId, prevMessage: text });
      return { result, state };
    }

    let prediction: AvengersProPrediction | undefined;
    try {
      prediction = await opts.rankAvengers?.(text);
    } catch {
      prediction = undefined;
    }

    const catalog = await discoveryCatalog(capabilityBody, signal);
    const result = opts.select(
      state,
      catalogExcluding(catalog, skippedProviders),
      opts.config,
      { currentModel: null, currentTier: null, downgradeCounter: 0 },
      undefined,
      stored.prevMessage,
      prediction,
      requirements,
    );
    persist({ taskTarget: result.modelId, prevMessage: text });
    return { result, state };
  }

  return {
    async handle(req, res) {
      const startedAt = Date.now();
      const path = requestPath(req.url);
      if (path === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === "/quota/refresh") {
        if (!isLoopbackManagement(req)) {
          json(res, 403, { error: "forbidden" });
          return;
        }
        const credOpts = { env: process.env, authPath: opts.authPath, claudePath: opts.claudePath };
        const authFile = opts.authPath ?? defaultAuthPath();
        for (const provider of ["anthropic", "openai", "xai"]) {
          const runtime = provider === "anthropic" ? "anthropic/claude" : provider === "openai" ? "openai/gpt" : "xai/grok";
          const accounts = listProviderAccounts(provider, { env: process.env, authPath: opts.authPath, accountsPath: accountsFile() });
           const tokens = accounts.length
             ? await Promise.all(
                 accounts.map(async (account) => ({
                   id: account.id,
                   sourceKey: account.sourceKey ?? accountKey(account),
                   token:
                     (await refreshAccountToken(account, { authPath: authFile, accountsPath: accountsFile() })) ?? account.token,
                 })),
               )
             : [{ id: provider, sourceKey: provider, token: (await refreshOAuthToken(provider, authFile)) ?? resolveCredential(runtime, credOpts) }];
           for (const item of tokens) {
             if (!item.token) continue;
             const quota = await reconcileUsageQuota(provider, item.token).catch(() => undefined);
             if (quota) storeQuota(item.id, { ...quota, sourceKey: item.sourceKey });
           }
        }
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === "/accounts/remove") {
        if (!isLoopbackManagement(req)) {
          json(res, 403, { error: "forbidden" });
          return;
        }
        if (!hasContentType(req, "application/json")) {
          json(res, 415, { error: "content type must be application/json" });
          return;
        }
        const file = accountsFile();
        if (!file) {
          json(res, 400, { error: "no accounts file" });
          return;
        }
        let id = "";
        try {
          const raw = await readBodyOrLimit(req, res, MANAGEMENT_BODY_LIMIT);
          if (raw === undefined) return;
          const parsed = JSON.parse(raw) as { id?: unknown };
          id = typeof parsed.id === "string" ? parsed.id : "";
        } catch {
          json(res, 400, { error: "invalid json" });
          return;
        }
        if (!id || id.includes(":")) {
          json(res, 400, { error: "id required" });
          return;
        }
        json(res, removeExtraAccount(file, id) ? 200 : 404, { ok: true });
        return;
      }
      if (req.method === "GET" && (path === "/" || path === "/ui")) {
        const envPath = opts.envPath ?? defaultEnvPath();
        const env = readEnvFile(envPath);
        const credOpts = { env: process.env, authPath: opts.authPath, claudePath: opts.claudePath };
        const providers = UI_PROVIDERS.flatMap((provider) => {
          const identity = accountIdentity(provider.id, opts.authPath);
          const accounts = listProviderAccounts(provider.id, { env: process.env, authPath: opts.authPath, accountsPath: accountsFile() });
          const base = {
            id: provider.id,
            label: provider.label,
            envKey: provider.envKey,
            envSet: Boolean(env[provider.envKey] || process.env[provider.envKey]),
          };
          if (!accounts.length) {
            return [{
              ...base,
              login: providerLoginSet(provider.id, credOpts),
              expires: loginExpires(provider.id, credOpts),
              email: identity.email,
              plan: identity.plan,
              quota: quotas.get(provider.id),
            }];
          }
          return accounts.map((account) => ({
            ...base,
            accountId: account.primary ? undefined : account.id,
            login: true,
            expires: account.expires,
            email: account.email || (account.primary ? identity.email : undefined),
            plan: account.plan || (account.primary ? identity.plan : undefined),
            quota: quotas.get(account.id) ?? (account.primary ? quotas.get(provider.id) : undefined),
          }));
        });
        html(res, 200, settingsPage(providers, true, routeLog));
        return;
      }
      if (path?.startsWith("/connect/")) {
        const parts = path.slice("/connect/".length).split("/");
        const id = parts[0] ?? "";
        const rest = parts.slice(1).join("/");
        const provider = CONNECT_PROVIDERS[id];
        const authFile = opts.authPath ?? defaultAuthPath();
        if (!provider) {
          json(res, 404, { error: "unknown provider" });
          return;
        }
        if (["oauth/start", "oauth/code", "oauth/callback", "oauth/poll"].includes(rest) && !isLoopbackManagement(req)) {
          json(res, 403, { error: "forbidden" });
          return;
        }
        if (req.method === "GET" && rest === "") {
          html(res, 200, connectPage({ id, label: provider.label, consoleUrl: provider.consoleUrl, oauth: provider.oauth }));
          return;
        }
        if (req.method === "POST" && rest === "key") {
          if (!isLoopbackManagement(req)) {
            json(res, 403, { error: "forbidden" });
            return;
          }
          if (!hasContentType(req, "application/x-www-form-urlencoded")) {
            json(res, 415, { error: "content type must be form encoded" });
            return;
          }
          const raw = await readBodyOrLimit(req, res, MANAGEMENT_BODY_LIMIT);
          if (raw === undefined) return;
          const key = new URLSearchParams(raw).get("key") ?? "";
          if (!key) {
            json(res, 400, { error: "key required" });
            return;
          }
          saveProviderCredential({
            provider: provider.authId,
            entry: { type: "api", key },
            authPath: authFile,
            accountsPath: accountsFile(),
          });
          if (typeof res.writeHead === "function") res.writeHead(303, { location: "/" });
          else {
            res.statusCode = 303;
            res.setHeader?.("location", "/");
          }
          res.end();
          return;
        }
        if (req.method === "POST" && rest === "oauth/start") {
           const started = await startOAuth(id, { statePath: opts.oauthStatePath });
          json(res, "error" in started ? 400 : 200, started);
          return;
        }
        if (req.method === "POST" && rest === "oauth/code") {
          if (!hasContentType(req, "application/x-www-form-urlencoded")) {
            json(res, 415, { error: "content type must be form encoded" });
            return;
          }
          const raw = await readBodyOrLimit(req, res, MANAGEMENT_BODY_LIMIT);
          if (raw === undefined) return;
          const params = new URLSearchParams(raw);
           const result = await completeOAuthCode(params.get("id") ?? "", params.get("code") ?? "", authFile, accountsFile(), { statePath: opts.oauthStatePath });
          if (result.done) {
            if (typeof res.writeHead === "function") res.writeHead(303, { location: "/" });
            else {
              res.statusCode = 303;
              res.setHeader?.("location", "/");
            }
            res.end();
            return;
          }
          json(res, 400, result);
          return;
        }
        if (req.method === "GET" && rest === "oauth/callback") {
          const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
           const result = await completeGoogleCallback(params.get("state") ?? "", params.get("code") ?? "", authFile, accountsFile(), { statePath: opts.oauthStatePath });
          if (result.done) {
            if (typeof res.writeHead === "function") res.writeHead(303, { location: "/" });
            else {
              res.statusCode = 303;
              res.setHeader?.("location", "/");
            }
            res.end();
            return;
          }
          json(res, 400, result);
          return;
        }
        if (req.method === "GET" && rest === "oauth/poll") {
          const sessionId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? "";
           json(res, 200, await pollOAuth(sessionId, authFile, accountsFile(), { statePath: opts.oauthStatePath }));
          return;
        }
        json(res, 404, { error: "not found" });
        return;
      }
      if (req.method === "GET" && path?.startsWith("/login/")) {
        const id = path.slice("/login/".length);
        if (!loginProviderId(id) || !CONNECT_PROVIDERS[id]) {
          json(res, 404, { error: "unknown provider" });
          return;
        }
        if (typeof res.writeHead === "function") res.writeHead(303, { location: `/connect/${id}` });
        else {
          res.statusCode = 303;
          res.setHeader?.("location", `/connect/${id}`);
        }
        res.end();
        return;
      }
      if (req.method === "POST" && path === "/settings") {
        if (!isLoopbackManagement(req)) {
          json(res, 403, { error: "forbidden" });
          return;
        }
        if (!hasContentType(req, "application/x-www-form-urlencoded")) {
          json(res, 415, { error: "content type must be form encoded" });
          return;
        }
        const raw = await readBodyOrLimit(req, res, MANAGEMENT_BODY_LIMIT);
        if (raw === undefined) return;
        const updates = Object.fromEntries(new URLSearchParams(raw));
        try {
          writeEnvFile(opts.envPath ?? defaultEnvPath(), updates);
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "invalid settings" });
          return;
        }
        for (const key of ENV_KEYS) {
          const value = updates[key];
          if (value) process.env[key] = value;
        }
        if (typeof res.writeHead === "function") res.writeHead(303, { location: "/" });
        else {
          res.statusCode = 303;
          res.setHeader?.("location", "/");
        }
        res.end();
        return;
      }
      if (req.method === "GET" && path === "/v1/models") {
        json(res, 200, {
          object: "list",
          data: [{ id: "auto", object: "model", created: 0, owned_by: "auto-router" }],
          models: [CODEX_AUTO_MODEL],
        });
        return;
      }
      if (req.method === "HEAD" && path === "/api/hello") {
        if (typeof res.writeHead === "function") res.writeHead(200);
        else res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        json(res, 404, { error: "not found" });
        return;
      }
      if (req.method !== "POST" || !INFERENCE_PATHS.has(path ?? "")) {
        json(res, 404, { error: "not found" });
        return;
      }

       const requestContext = createProxyRequestContext({ timeoutMs: upstreamTimeoutMs, request: req });
       let raw: string | undefined;
       try {
         raw = await readBodyOrLimit(req, res, REQUEST_BODY_LIMIT, requestContext.signal);
       } catch (error) {
         if (requestContext.signal.aborted) {
           requestContext.finalize({ terminalState: "failed", status: 504 });
           if (!res.headersSent) json(res, 504, { error: "request deadline exceeded" });
           else res.end();
           return;
         }
         throw error;
       }
       if (raw === undefined) {
         requestContext.finalize({ terminalState: "failed", status: res.statusCode >= 400 ? res.statusCode : 413 });
         return;
       }
       let body: any;
       try {
         body = raw ? JSON.parse(raw) : {};
       } catch {
         requestContext.finalize({ terminalState: "failed", status: 400 });
         json(res, 400, { error: "invalid json" });
         return;
       }
      const protocol = ingressProtocol(req.url);
      let normalizedBody: any;
      try {
        normalizedBody = normalizeIngress(body, protocol);
      } catch (error) {
        if (!(error instanceof UnsupportedImageContentError)) throw error;
        requestContext.finalize({ terminalState: "failed", status: 400 });
        json(res, 400, { error: error.message });
        return;
      }
      const messages = textMessages(normalizedBody);
      const text = lastUserText(messages);
       const identity = resolveSessionIdentity(req, normalizedBody);
       const id = identity.id;
       const decision = await opts.sessions.runExclusive(id, () => decide(req, normalizedBody, text, identity, protocol, body, requestContext.signal));
       let state = decision.state;
       let result = decision.result;
       const finalize = (terminalState: FinalResult["terminalState"], status: number) =>
         requestContext.finalize({ terminalState, status, runtimeModelId: result.modelId });
      const routeRow: { at: number; via: string; modelId: string; status?: number } = {
        at: Date.now(),
        via: result.via,
        modelId: result.modelId,
      };
      routeLog.unshift(routeRow);
      if (routeLog.length > 20) routeLog.length = 20;
      console.log(`[auto-router-proxy] ${result.via} ${result.modelId}`);

       if (path === "/v1/route") {
        json(res, 200, {
          modelId: result.modelId,
          via: result.via,
          ...(opts.avengersArtifactDigest ? { artifactDigest: opts.avengersArtifactDigest } : {}),
         });
         finalize("completed", 200);
         return;
      }

      if (opts.recorder && opts.recorder.mode !== "off") {
        const headerTurnId = req.headers["x-turn-id"];
        const turnId = typeof headerTurnId === "string" && headerTurnId ? headerTurnId : `${id}-${startedAt}`;
        recordProxyResponse(res, opts.recorder, {
          sessionId: id,
          turnId,
          startedAt,
          protocol,
           selection: { modelId: result.modelId, via: result.via, reason: result.reason },
           sessionState: state,
            sessionStable: identity.stable,
             requiredCapabilities: routingCapabilities(body),
           attempts: () => requestContext.attempts,
           finalRuntimeId: () => requestContext.finalState?.runtimeModelId,
           ...(Array.isArray(normalizedBody.messages) ? { messages: normalizedBody.messages } : {}),
        });
      }

      const skippedAccounts = new Set<string>();
      let zenFailovers = 0;
       let googleAuthRetries = 0;
       let lastLimited: { status: number; payload: string; type: string } | undefined;
       for (let attempt = 0; attempt < 8; attempt++) {
       if (requestContext.signal.aborted || requestContext.remainingMs() <= 0) {
         finalize("failed", 504);
         if (!res.headersSent) json(res, 504, { error: "request deadline exceeded" });
         else res.end();
         return;
       }
       const { provider, bareModel } = resolveProvider(result.modelId);
       const backend = opts.backends[provider];
       if (!backend) {
         finalize("failed", 502);
         json(res, 502, { error: `no backend for ${provider}` });
        return;
      }

        const inbound = inboundCredentials(req.headers, protocol, provider);
        const credOpts = { env: process.env, authPath: opts.authPath, claudePath: opts.claudePath };
        const picked = pickAccount(provider, result.modelId, opts, skippedAccounts, limitedUntil, modelDiscovery);
        const attemptIndex = requestContext.recordAttempt({ provider, runtimeModelId: result.modelId, accountId: picked.account?.id });
      if (picked.allAccountsLimited) {
        if (lastLimited) {
          if (typeof res.writeHead === "function") res.writeHead(lastLimited.status, { "content-type": lastLimited.type });
          else res.statusCode = lastLimited.status;
          res.end(lastLimited.payload);
         } else {
           json(res, 429, { error: "rate limited" });
         }
         finalize("failed", 429);
         return;
      }
      if (picked.discoveryConstrained && !picked.account) {
        if (lastLimited) {
          if (typeof res.writeHead === "function") res.writeHead(lastLimited.status, { "content-type": lastLimited.type });
          else res.statusCode = lastLimited.status;
          res.end(lastLimited.payload);
         } else {
           json(res, 503, { error: "no eligible account for discovered model" });
         }
         finalize("failed", 503);
         return;
      }
      const oauth = picked.oauth;
      const authFile = opts.authPath ?? defaultAuthPath();
      let resolved = picked.token ?? backend.apiKey;
      if (picked.account && (provider === "anthropic" || provider === "openai" || provider === "xai" || provider === "google")) {
        const refreshed = await refreshAccountToken(picked.account, {
          authPath: authFile,
          accountsPath: accountsFile(),
          fetchImpl: backend.fetchImpl ?? fetch,
           signal: requestContext.signal,
         });
         if (refreshed) resolved = refreshed;
       } else if (oauth && (provider === "anthropic" || provider === "openai" || provider === "xai" || provider === "google")) {
         const refreshed = await refreshOAuthToken(provider, authFile, backend.fetchImpl ?? fetch, false, requestContext.signal);
        if (refreshed) resolved = refreshed;
      }
      const authorization = resolved ? `Bearer ${resolved}` : inbound.authorization;
      let token = resolved ?? inbound.token;
      let googleProject = provider === "google" && picked.account
        ? modelDiscovery.projectIdFor(provider, picked.account.id) ?? picked.account.projectId
        : undefined;
      googleProject ??= resolveGoogleProject(credOpts);
      if (oauth && provider === "google" && token && !googleProject) {
         googleProject = await ensureGoogleProject(token, backend.fetchImpl ?? fetch, requestContext.signal).catch(() => undefined);
        if (googleProject) {
          const authFile = opts.authPath ?? defaultAuthPath();
          const current = readAuthFile(authFile).google;
          writeAuthEntry(authFile, "google", {
            ...(current && typeof current === "object" ? current : {}),
            projectId: googleProject,
          });
        }
      }
      let upstreamRequestPlan: UpstreamRequest;
      try {
        upstreamRequestPlan = upstreamRequest(
          protocol,
          body,
          normalizedBody,
          provider,
          bareModel,
          token,
          googleProject,
          id,
          oauth && provider === "google",
          oauth && provider === "openai",
          oauth && provider === "anthropic",
        );
      } catch (error) {
        if (!(error instanceof UnsupportedImageContentError)) throw error;
        finalize("failed", 400);
        json(res, 400, { error: error.message });
        return;
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (provider === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
        const beta = req.headers["anthropic-beta"];
        if (oauth) {
          headers.authorization = `Bearer ${token}`;
          headers["anthropic-beta"] = ["oauth-2025-04-20", typeof beta === "string" ? beta : ""].filter(Boolean).join(",");
          headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
        } else {
          if (token) headers["x-api-key"] = token;
          if (protocol === "anthropic" && typeof beta === "string") headers["anthropic-beta"] = beta;
        }
      } else if (provider === "google" && oauth) {
        headers.authorization = `Bearer ${token}`;
        headers["user-agent"] = antigravityUserAgent();
      } else if (!upstreamRequestPlan.useGemini && typeof authorization === "string" && authorization) {
        headers.authorization = authorization;
        if (oauth && provider === "openai" && token) {
          const account = chatgptAccountId(token);
          if (account) headers["chatgpt-account-id"] = account;
        }
      }
      const fetchImpl = backend.fetchImpl ?? fetch;
      const upstreamUrl = upstreamRequestPlan.path.startsWith("http") ? upstreamRequestPlan.path : `${backend.baseUrl}${upstreamRequestPlan.path}`;
       let upstream: Response;
       try {
         upstream = await fetchImpl(upstreamUrl, {
           method: req.method,
           redirect: "error",
           signal: upstreamSignal(requestContext, upstreamTimeoutMs),
           headers,
           body: JSON.stringify(upstreamRequestPlan.body),
         });
       } catch (error) {
         if (requestContext.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
           finalize("failed", 504);
           if (!res.headersSent) json(res, 504, { error: "upstream request timed out" });
           else res.end();
           return;
         }
         throw error;
       }
       const quota = parseQuota(upstream.headers, upstream.status, picked.account ? accountKey(picked.account) : provider);
       storeQuota(picked.account?.id ?? provider, quota);
       requestContext.updateAttempt(attemptIndex, upstream.status);
       routeRow.status = upstream.status;
      routeRow.via = result.via;
      routeRow.modelId = result.modelId;
      if (
        oauth &&
        provider === "google" &&
        googleAuthRetries === 0 &&
        (upstream.status === 401 || upstream.status === 403)
      ) {
        googleAuthRetries += 1;
        const previous = resolved;
        const refreshed = picked.account
          ? await refreshAccountToken(picked.account, {
              authPath: authFile,
              accountsPath: accountsFile(),
              fetchImpl: backend.fetchImpl ?? fetch,
              force: true,
              signal: requestContext.signal,
            })
          : await refreshOAuthToken(provider, authFile, backend.fetchImpl ?? fetch, true, requestContext.signal);
        if (refreshed && refreshed !== previous) {
          await upstream.arrayBuffer();
          continue;
        }
      }
      if (upstream.status === 429 && picked.account) {
         const limitedAccountKey = accountKey(picked.account);
         skippedAccounts.add(limitedAccountKey);
         limitedUntil.set(limitedAccountKey, Date.now() + retryAfterMs(upstream.headers));
        const limitedPayload = await upstream.text();
        lastLimited = { status: 429, payload: limitedPayload, type: upstream.headers.get("content-type") ?? "application/json" };
        if (picked.discoveryConstrained || nextOpenAccount(listProviderAccounts(provider, { env: process.env, authPath: opts.authPath, accountsPath: accountsFile() }), skippedAccounts)) {
          continue;
        }
         if (typeof res.writeHead === "function") res.writeHead(429, { "content-type": lastLimited.type });
         else res.statusCode = 429;
         res.end(limitedPayload);
         finalize("failed", 429);
         return;
      }

      const isUpstreamEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      const wantsStream = !!normalizedBody.stream;

      if (wantsStream && isUpstreamEventStream && upstream.ok) {
        if (!upstreamRequestPlan.translateResponse) {
          // Native passthrough: pipe upstream SSE directly
          if (typeof (res as any).writeHead === "function") (res as any).writeHead(upstream.status, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          else {
            (res as any).statusCode = upstream.status;
            (res as any).setHeader?.("content-type", "text/event-stream");
          }
          if (upstream.body) {
            const reader = (upstream.body as any).getReader?.() ?? (upstream.body as any)[Symbol.asyncIterator]?.();
            if (reader && typeof reader.read === "function") {
              const decoder = new TextDecoder();
              let buf = "";
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });
                buf += chunk;
                let separator: RegExpExecArray | null;
                while ((separator = /\r?\n\r?\n/.exec(buf))) {
                  const raw = buf.slice(0, separator.index);
                  buf = buf.slice(separator.index + separator[0].length);
                  if (raw.trim()) await writeWithBackpressure(res, raw + "\n\n");
                }
              }
              if (buf.trim()) await writeWithBackpressure(res, buf);
            } else {
              const text = await upstream.text();
              await writeWithBackpressure(res, text);
            }
           }
           (res as any).end();
           finalize("completed", upstream.status);
           return;
        }

        // Translated streaming: Gemini -> Chat
        if (upstreamRequestPlan.useGemini && protocol === "chat") {
          const id = `chatcmpl-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);
          if (typeof (res as any).writeHead === "function") (res as any).writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          else {
            (res as any).statusCode = 200;
            (res as any).setHeader?.("content-type", "text/event-stream");
          }
          const reader = (upstream.body as any).getReader?.();
          if (!reader) {
            const text = await upstream.text();
            // fallback to buffered
             const parsedFallback = JSON.parse(text);
             // synthesize from fallback? but we are in streaming branch, shouldn't happen
             (res as any).end(text);
             finalize("completed", upstream.status);
             return;
          }
          const decoder = new TextDecoder();
          let buf = "";
          let firstDelta = true;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });
            buf += chunk;
            let separator: RegExpExecArray | null;
            while ((separator = /\r?\n\r?\n/.exec(buf))) {
              const raw = buf.slice(0, separator.index);
              buf = buf.slice(separator.index + separator[0].length);
              const line = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
              if (!line || line === "[DONE]") continue;
              try {
                const payloadJson = unwrapAntigravityResponse(JSON.parse(line));
                const textDelta = payloadJson.candidates?.[0]?.content?.parts?.[0]?.text ?? payloadJson.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
                if (textDelta) {
                  const delta: any = firstDelta ? { role: "assistant", content: textDelta } : { content: textDelta };
                  firstDelta = false;
                  const downstreamChunk = { id, object: "chat.completion.chunk", created, model: bareModel, choices: [{ index: 0, delta, logprobs: null, finish_reason: null }] };
                  await writeWithBackpressure(res, `data: ${JSON.stringify(downstreamChunk)}\n\n`);
                }
                // handle finishReason if present
                const finishReason = payloadJson.candidates?.[0]?.finishReason;
                if (finishReason && finishReason !== "STOP") {
                  // ignore for now
                }
              } catch {}
            }
          }
          const finalChunk = { id, object: "chat.completion.chunk", created, model: bareModel, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }] };
          await writeWithBackpressure(res, `data: ${JSON.stringify(finalChunk)}\n\n`);
           await writeWithBackpressure(res, "data: [DONE]\n\n");
           (res as any).end();
           finalize("completed", upstream.status);
           return;
        }
      }

      const payload = await upstream.text();
      if (upstream.ok && upstreamRequestPlan.translateResponse) {
        const parsed =
          isUpstreamEventStream || payload.trimStart().startsWith("event:") || payload.trimStart().startsWith("data:")
            ? parseSsePayload(payload)
            : JSON.parse(payload);
         if (parsed == null) {
           finalize("failed", 502);
           json(res, 502, { error: "empty upstream stream" });
          return;
        }
        const translated = provider === "google" ? unwrapAntigravityResponse(parsed) : parsed;
         if (protocol === "chat") writeChatCompletion(res, normalizedBody, provider, bareModel, translated, id);
         if (protocol === "anthropic") writeAnthropicMessage(res, normalizedBody, provider, bareModel, translated, id);
         if (protocol === "responses") writeResponsesPayload(res, normalizedBody, provider, bareModel, translated, id);
         finalize(normalizeProviderCompletion(translated, provider).terminalState, upstream.status);
         return;
      }
      if (zenFailovers < 1 && provider === "opencode" && isZenBillingError(upstream.status, payload)) {
        zenFailovers += 1;
        skippedProviders.add("opencode");
        if (identity.stable) opts.sessions.set(id, { taskTarget: null, prevMessage: text });
         const nextDecision = await opts.sessions.runExclusive(id, () => decide(req, normalizedBody, text, identity, protocol, body, requestContext.signal));
        state = nextDecision.state;
        result = nextDecision.result;
        continue;
      }
      if (typeof res.writeHead === "function") res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
       else res.statusCode = upstream.status;
       res.end(payload);
       finalize(upstream.ok ? "completed" : "failed", upstream.status);
       return;
      }
      if (lastLimited) {
        if (typeof res.writeHead === "function") res.writeHead(lastLimited.status, { "content-type": lastLimited.type });
       else res.statusCode = lastLimited.status;
       res.end(lastLimited.payload);
       finalize("failed", lastLimited.status);
       return;
      }
       json(res, 429, { error: "rate limited" });
       finalize("failed", 429);
    },
    close() {
      void opts.recorder?.flush().catch(() => {
        console.warn("[auto-router] eval recording flush failed");
      });
    },
  };
}

export function bootstrapProxyOptions(): CreateProxyServerOptions {
  const stored = readEnvFile(defaultEnvPath());
  for (const [key, value] of Object.entries(stored)) {
    if (!process.env[key]) process.env[key] = value;
  }
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value) validateEnvValue(key, value);
  }
  const config = loadConfig();
  const catalog = loadCatalogSync(config);
  const upstreamTimeoutMs = configuredUpstreamTimeout();
  const authPath = join(homedir(), ".local/share/opencode/auth.json");
  const allowed = new Set(["openai", "anthropic", "xai"]);
  const accountsPath = defaultAccountsPath();
  const credOpts = { env: process.env, authPath, accountsPath };
  if (resolveCredential("google/gemini", credOpts) || listProviderAccounts("google", credOpts).length) allowed.add("google");
  if (resolveCredential("opencode/muse-spark-1.3-contributor-free", credOpts) || listProviderAccounts("opencode", credOpts).length) {
    allowed.add("opencode");
  }
  catalog.models = catalog.models.filter((model) => {
    const id = model.runtimeId ?? model.id;
    const provider = id.slice(0, Math.max(0, id.indexOf("/")));
    return allowed.has(provider);
  });
  const runtime = createAvengersRuntime({
    config,
    catalog,
    env: process.env,
    warn: (event) => console.warn("[auto-router]", event.code),
  });
  return {
    select: selectModel,
    catalog,
    config,
    sessions: memorySessions(),
    upstreamTimeoutMs,
    avengersArtifactDigest: runtime?.artifactDigest,
    backends: {
      openai: { baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com", apiKey: process.env.OPENAI_API_KEY },
      opencode: { baseUrl: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen", apiKey: process.env.OPENCODE_API_KEY },
      anthropic: { baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", apiKey: process.env.ANTHROPIC_API_KEY },
      google: {
        baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
        apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
      },
      xai: { baseUrl: process.env.XAI_BASE_URL ?? "https://api.x.ai", apiKey: process.env.XAI_API_KEY },
    },
    rankAvengers: runtime ? (text) => runtime.rank(text) : undefined,
    recorder: createProxyRecorderFromEnv(),
    authPath,
    accountsPath: defaultAccountsPath(),
    claudePath: join(homedir(), ".claude/.credentials.json"),
    oauthStatePath: defaultOAuthStatePath(),
    modelDiscovery: [googleModelDiscovery],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "login") {
    process.exit(await mainLogin(process.argv.slice(3)));
  }
  const host = process.env.AUTO_ROUTER_HOST ?? "127.0.0.1";
  const port = Number(process.env.AUTO_ROUTER_PORT ?? 8787);
  if (!isLoopbackHostname(host)) {
    console.error("[auto-router-proxy] AUTO_ROUTER_HOST must be a loopback address");
    process.exitCode = 1;
  } else {
    const server = createProxyServer(bootstrapProxyOptions());
    createServer((req, res) => {
      void server.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "internal error" }));
          return;
        }
        res.end();
      });
    }).listen(port, host, () => {
      console.log(`[auto-router-proxy] listening on http://${host}:${port}`);
    });
  }
}
