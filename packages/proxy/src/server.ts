import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  detectBoundary,
  loadCatalogSync,
  loadConfig,
  selectModel,
  type Catalog,
  type RouterConfig,
  type SelectionResult,
  type SessionState,
} from "@auto-router/router-core";
import { memorySessions, type ProxySessionStore } from "./session.js";

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
  rankAvengers?: (text: string) => { paperIds: string[] };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const ZEN_RESPONSE_MODELS = /muse-spark|gpt-5|grok-/i;
const ZEN_MODEL_HINT = /muse-spark|contributor-free|big-pickle|mimo-v2|nemotron|ling-3|hy3-free|gpt-5|grok-/i;
const TEXT_MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);

interface TextMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

function bearerToken(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^Bearer\s+/i, "").trim() || undefined;
}

function resolveProvider(modelId: string): { provider: string; bareModel: string } {
  const slash = modelId.indexOf("/");
  const providerFromId = slash >= 0 ? modelId.slice(0, slash) : "";
  const bareModel = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  if (providerFromId === "google" || providerFromId === "gemini" || /^gemini/i.test(bareModel)) {
    return { provider: "google", bareModel };
  }
  if (providerFromId === "opencode" || (!providerFromId && ZEN_MODEL_HINT.test(bareModel))) {
    return { provider: "opencode", bareModel };
  }
  return { provider: providerFromId || "openai", bareModel };
}

function messageText(content: any): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
  return text || undefined;
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
  return messages.findLast((message) => message.role === "user")?.content ?? "";
}

function geminiRequest(messages: TextMessage[]): Record<string, unknown> {
  const systemParts = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => ({ text: message.content }));
  const contents = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
  };
}

function sessionId(req: IncomingMessage, text: string): string {
  return String(req.headers["x-session-id"] ?? req.headers["x-opencode-session"] ?? text.slice(0, 64) ?? "global");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function sessionState(text: string, isNewSession: boolean): SessionState {
  const promptTokens = estimateTokens(text);
  return {
    lifetimeTokens: promptTokens,
    currentTask: {
      promptTokens,
      taskTokens: promptTokens,
      filesTouched: 0,
      diffHunks: 0,
      toolDepth: 0,
      lastUserMessage: text,
    },
    isNewSession,
  };
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

function nativeResponseText(payload: any, provider: string): string {
  if (provider === "google") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) ? parts.map((part: any) => part?.text ?? "").join("") : "";
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  return output
    .filter((item: any) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item: any) => item.content)
    .filter((part: any) => part?.type === "output_text")
    .map((part: any) => part.text ?? "")
    .join("");
}

function nativeFinishReason(payload: any, provider: string): "stop" | "length" | "content_filter" {
  if (provider === "google") {
    const reason = payload?.candidates?.[0]?.finishReason ?? payload?.promptFeedback?.blockReason;
    if (!reason || reason === "STOP") return "stop";
    if (reason === "MAX_TOKENS") return "length";
    return "content_filter";
  }

  if (!payload?.status || payload.status === "completed") return "stop";
  if (payload.status === "incomplete" && payload?.incomplete_details?.reason === "max_output_tokens") return "length";
  return "content_filter";
}

function writeChatCompletion(res: ServerResponse, body: any, provider: string, model: string, payload: any): void {
  const id = String(payload?.id ?? `chatcmpl-${Date.now()}`);
  const created = Math.floor(Date.now() / 1000);
  const content = nativeResponseText(payload, provider);
  const finishReason = nativeFinishReason(payload, provider);

  if (!body?.stream) {
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, logprobs: null, finish_reason: finishReason }],
    });
    return;
  }

  const chunks = [
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content }, logprobs: null, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }] },
  ];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
}

export function createProxyServer(opts: CreateProxyServerOptions): {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): void;
} {
  function decide(req: IncomingMessage, text: string): SelectionResult {
    const id = sessionId(req, text);
    const stored = opts.sessions.get(id);
    const isNewSession = !stored.taskTarget;
    const state = sessionState(text, isNewSession);
    const boundary = detectBoundary(state, undefined, stored.prevMessage);
    if (stored.taskTarget && !boundary.isBoundary) {
      return {
        modelId: stored.taskTarget,
        tier: "simple",
        taskType: null,
        confidence: 1,
        reason: "task lock",
        via: "stay-sticky",
        catalogSource: opts.catalog.source,
        score: 0,
        boundary,
      };
    }

    let paperIds: string[] | undefined;
    try {
      paperIds = opts.rankAvengers?.(text).paperIds;
    } catch {
      paperIds = undefined;
    }

    const forced = req.headers["x-force-model"];
    if (typeof forced === "string" && forced) {
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
      opts.sessions.set(id, { taskTarget: result.modelId, prevMessage: text });
      return result;
    }

    const result = opts.select(state, opts.catalog, opts.config, { currentModel: null, currentTier: null, downgradeCounter: 0 }, undefined, stored.prevMessage, paperIds ? { paperIds } : undefined);
    opts.sessions.set(id, { taskTarget: result.modelId, prevMessage: text });
    return result;
  }

  return {
    async handle(req, res) {
      if (req.url === "/health") {
        json(res, 200, { ok: true });
        return;
      }

      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const messages = textMessages(body);
      const text = lastUserText(messages);
      const result = decide(req, text);

      if (req.url === "/v1/route") {
        json(res, 200, { modelId: result.modelId, via: result.via });
        return;
      }

      const { provider, bareModel } = resolveProvider(result.modelId);
      const backend = opts.backends[provider] ?? (provider === "google" ? opts.backends.google : provider === "opencode" ? opts.backends.opencode : opts.backends.openai);
      if (!backend) {
        json(res, 502, { error: `no backend for ${provider}` });
        return;
      }

      const inboundAuthorization = req.headers.authorization ?? req.headers.Authorization;
      const authorization = backend.apiKey ? `Bearer ${backend.apiKey}` : inboundAuthorization;
      const token = backend.apiKey ?? bearerToken(inboundAuthorization);
      const useZenResponses = provider === "opencode" && ZEN_RESPONSE_MODELS.test(bareModel);
      const useGemini = provider === "google";
      const outbound = useGemini
        ? geminiRequest(messages)
        : useZenResponses
          ? { model: bareModel, input: messages }
          : { ...body, model: provider === "opencode" ? bareModel : result.modelId };
      const path = useGemini
        ? `/models/${bareModel}:generateContent${token ? `?key=${encodeURIComponent(token)}` : ""}`
        : useZenResponses
          ? "/v1/responses"
          : req.url;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (!useGemini && typeof authorization === "string" && authorization) headers.authorization = authorization;
      const fetchImpl = backend.fetchImpl ?? fetch;
      const upstream = await fetchImpl(`${backend.baseUrl}${path}`, {
        method: req.method,
        headers,
        body: JSON.stringify(outbound),
      });
      const payload = await upstream.text();
      if (upstream.ok && req.url === "/v1/chat/completions" && (useGemini || useZenResponses)) {
        writeChatCompletion(res, body, provider, bareModel, JSON.parse(payload));
        return;
      }
      if (typeof res.writeHead === "function") res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      else res.statusCode = upstream.status;
      res.end(payload);
    },
    close() {},
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadConfig();
  const catalog = loadCatalogSync(config);
  const server = createProxyServer({
    select: selectModel,
    catalog,
    config,
    sessions: memorySessions(),
    backends: {
      openai: { baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com", apiKey: process.env.OPENAI_API_KEY },
      opencode: { baseUrl: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen", apiKey: process.env.OPENCODE_API_KEY },
      anthropic: { baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", apiKey: process.env.ANTHROPIC_API_KEY },
      google: {
        baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
        apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
      },
    },
  });
  const host = process.env.AUTO_ROUTER_HOST ?? "127.0.0.1";
  const port = Number(process.env.AUTO_ROUTER_PORT ?? 8787);
  createServer((req, res) => {
    void server.handle(req, res);
  }).listen(port, host, () => {
    console.log(`[auto-router-proxy] listening on http://${host}:${port}`);
  });
}
