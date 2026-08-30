import type { IncomingMessage, ServerResponse } from "node:http";
import { detectBoundary, selectModel } from "../../router-core/src/index.js";
import type { Catalog, RouterConfig, SelectionResult, SessionState } from "../../router-core/src/types.js";
import type { ProxySessionStore } from "./session.js";

export interface ProxyBackend {
  baseUrl: string;
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

function lastUserText(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map((part: any) => part?.text ?? part?.content ?? "").join("\n");
    }
  }
  return "";
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
      const text = lastUserText(body);
      const result = decide(req, text);

      if (req.url === "/v1/route") {
        json(res, 200, { modelId: result.modelId, via: result.via });
        return;
      }

      const slash = result.modelId.indexOf("/");
      const provider = slash >= 0 ? result.modelId.slice(0, slash) : "openai";
      const backend = opts.backends[provider] ?? opts.backends.openai;
      if (!backend) {
        json(res, 502, { error: `no backend for ${provider}` });
        return;
      }

      const outbound = { ...body, model: result.modelId };
      const fetchImpl = backend.fetchImpl ?? fetch;
      const upstream = await fetchImpl(`${backend.baseUrl}${req.url}`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(outbound),
      });
      const payload = await upstream.text();
      if (typeof res.writeHead === "function") res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      else res.statusCode = upstream.status;
      res.end(payload);
    },
    close() {},
  };
}
