import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectBoundary,
  loadAvengersProArtifacts,
  loadCatalogSync,
  loadConfig,
  scoreAvengersPro,
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

type IngressProtocol = "chat" | "anthropic" | "responses";

function ingressProtocol(url: string | undefined): IngressProtocol {
  if (url === "/v1/messages") return "anthropic";
  if (url === "/v1/responses") return "responses";
  return "chat";
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
    .filter((part: any) => ["text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
  return text || undefined;
}

function anthropicMessages(body: any): any[] {
  const system = messageText(body?.system);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const normalized = messages.flatMap((message: any) => {
    if (!Array.isArray(message?.content)) return [{ role: message.role, content: message.content }];
    const items: any[] = [];
    const text = messageText(message.content);
    if (text) items.push({ role: message.role, content: text });
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
    if (TEXT_MESSAGE_ROLES.has(item?.role)) {
      const content = messageText(item.content);
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

function zenInput(body: any): unknown[] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.flatMap((message: any) => {
    if (message?.role === "tool") {
      return [{ type: "function_call_output", call_id: message.tool_call_id, output: messageText(message.content) ?? "" }];
    }
    if (Array.isArray(message?.tool_calls)) {
      return message.tool_calls
        .filter((call: any) => call?.function?.name)
        .map((call: any) => ({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? "{}",
        }));
    }
    const content = messageText(message?.content);
    if (!TEXT_MESSAGE_ROLES.has(message?.role) || content === undefined) return [];
    return [{ role: message.role, content }];
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
    .map((item: any) => ({
      id: item.call_id ?? item.id,
      name: item.name,
      arguments: item.arguments ?? "{}",
    }));
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: raw ?? "" };
  } catch {
    return { result: raw ?? "" };
  }
}

function geminiTools(body: any): unknown[] {
  const declarations = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === "function" && tool.function?.name)
    .map((tool: any) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}

function geminiRequest(body: any): Record<string, unknown> {
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
    if (Array.isArray(message?.tool_calls)) {
      contents.push({
        role: "model",
        parts: message.tool_calls
          .filter((call: any) => call?.function?.name)
          .map((call: any) => ({ functionCall: { name: call.function.name, args: parseToolArguments(call.function.arguments) } })),
      });
      continue;
    }
    const content = messageText(message?.content);
    if ((message?.role !== "user" && message?.role !== "assistant") || content === undefined) continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: content }],
    });
  }
  const tools = geminiTools(body);
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
    ...(tools.length ? { tools } : {}),
  };
}

function geminiFunctionCalls(payload: any): Array<{ id: string; name: string; arguments: string }> {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return (Array.isArray(parts) ? parts : [])
    .filter((part: any) => part?.functionCall?.name)
    .map((part: any, index: number) => ({
      id: `call_${part.functionCall.name}_${index}`,
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {}),
    }));
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
  inboundPath: string | undefined
): UpstreamRequest {
  if (provider === "openai" && protocol === "responses") {
    return { body: { ...originalBody, model }, path: "/v1/responses", translateResponse: false, useGemini: false };
  }
  if (provider === "google") {
    const key = token ? `?key=${encodeURIComponent(token)}` : "";
    return { body: geminiRequest(normalizedBody), path: `/models/${model}:generateContent${key}`, translateResponse: true, useGemini: true };
  }
  if (provider === "opencode" && ZEN_RESPONSE_MODELS.test(model)) {
    return { body: zenRequest(normalizedBody, model), path: "/v1/responses", translateResponse: true, useGemini: false };
  }

  const body = { ...normalizedBody, ...(protocol === "chat" ? {} : { stream: false }), model };
  return {
    body,
    path: protocol === "chat" ? inboundPath ?? "/v1/chat/completions" : "/v1/chat/completions",
    translateResponse: protocol === "anthropic",
    useGemini: false,
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

function nativeResponse(payload: any, provider: string): { content: string; refusal?: string } {
  if (provider === "openai") {
    const message = payload?.choices?.[0]?.message;
    return { content: messageText(message?.content) ?? "", ...(message?.refusal ? { refusal: message.refusal } : {}) };
  }
  if (provider === "google") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    return { content: Array.isArray(parts) ? parts.map((part: any) => part?.text ?? "").join("") : "" };
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = output
    .filter((item: any) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item: any) => item.content);
  const content = parts
    .filter((part: any) => part?.type === "output_text")
    .map((part: any) => part.text ?? "")
    .join("");
  const refusal = parts
    .filter((part: any) => part?.type === "refusal")
    .map((part: any) => part.refusal ?? "")
    .join("");
  return { content, ...(refusal ? { refusal } : {}) };
}

function nativeFinishReason(payload: any, provider: string, refusal?: string, toolCalls: unknown[] = []): "stop" | "length" | "content_filter" | "tool_calls" {
  if (toolCalls.length) return "tool_calls";
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

  if (refusal) return "content_filter";
  if (!payload?.status || payload.status === "completed") return "stop";
  if (payload.status === "incomplete" && payload?.incomplete_details?.reason === "max_output_tokens") return "length";
  return "content_filter";
}

function writeChatCompletion(res: ServerResponse, body: any, provider: string, model: string, payload: any): void {
  const id = String(payload?.id ?? `chatcmpl-${Date.now()}`);
  const created = Math.floor(Date.now() / 1000);
  const { content, refusal } = nativeResponse(payload, provider);
  const toolCalls = nativeToolCalls(payload, provider);
  const finishReason = nativeFinishReason(payload, provider, refusal, toolCalls);
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

function nativeToolCalls(payload: any, provider: string): Array<{ id: string; name: string; arguments: string }> {
  if (provider === "openai") {
    const calls = payload?.choices?.[0]?.message?.tool_calls;
    return (Array.isArray(calls) ? calls : [])
      .filter((call: any) => call?.function?.name)
      .map((call: any) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? "{}" }));
  }
  if (provider === "google") return geminiFunctionCalls(payload);
  if (provider === "opencode") return zenFunctionCalls(payload);
  return [];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function writeAnthropicMessage(res: ServerResponse, body: any, provider: string, model: string, payload: any): void {
  const { content, refusal } = nativeResponse(payload, provider);
  const toolCalls = nativeToolCalls(payload, provider);
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
  response.output.forEach((item: any, outputIndex: number) => {
    events.push(event("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : {}) } }));
    if (item.type === "message") {
      const part = item.content[0];
      events.push(event("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...part, text: "" } }));
      events.push(event("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text ?? part.refusal ?? "" }));
      events.push(event("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text ?? part.refusal ?? "" }));
      events.push(event("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: 0, part }));
    } else {
      events.push(event("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: item.arguments }));
      events.push(event("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: item.arguments }));
    }
    events.push(event("response.output_item.done", { output_index: outputIndex, item }));
  });
  events.push(event("response.completed", { response }));
  return events;
}

function writeResponsesPayload(res: ServerResponse, body: any, provider: string, model: string, payload: any): void {
  const { content, refusal } = nativeResponse(payload, provider);
  const toolCalls = nativeToolCalls(payload, provider);
  const id = String(payload?.id ?? `resp_${Date.now()}`);
  const output = [
    ...(content || refusal
      ? [{ id: `msg_${id}`, type: "message", status: "completed", role: "assistant", content: [{ type: refusal ? "refusal" : "output_text", [refusal ? "refusal" : "text"]: refusal || content }] }]
      : []),
    ...toolCalls.map((call) => ({ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" })),
  ];
  const response = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: payload?.usage,
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
      const protocol = ingressProtocol(req.url);
      const normalizedBody = normalizeIngress(body, protocol);
      const messages = textMessages(normalizedBody);
      const text = lastUserText(messages);
      const result = decide(req, text);

      if (req.url === "/v1/route") {
        json(res, 200, { modelId: result.modelId, via: result.via });
        return;
      }

      const { provider, bareModel } = resolveProvider(result.modelId);
      const backend = opts.backends[provider];
      if (!backend) {
        json(res, 502, { error: `no backend for ${provider}` });
        return;
      }

      const inboundAuthorization = req.headers.authorization ?? req.headers.Authorization;
      const authorization = backend.apiKey ? `Bearer ${backend.apiKey}` : inboundAuthorization;
      const token = backend.apiKey ?? bearerToken(inboundAuthorization);
      const upstreamRequestPlan = upstreamRequest(protocol, body, normalizedBody, provider, bareModel, token, req.url);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (!upstreamRequestPlan.useGemini && typeof authorization === "string" && authorization) headers.authorization = authorization;
      const fetchImpl = backend.fetchImpl ?? fetch;
      const upstream = await fetchImpl(`${backend.baseUrl}${upstreamRequestPlan.path}`, {
        method: req.method,
        headers,
        body: JSON.stringify(upstreamRequestPlan.body),
      });
      const payload = await upstream.text();
      if (upstream.ok && upstreamRequestPlan.translateResponse) {
        const parsed = JSON.parse(payload);
        if (protocol === "chat") writeChatCompletion(res, normalizedBody, provider, bareModel, parsed);
        if (protocol === "anthropic") writeAnthropicMessage(res, normalizedBody, provider, bareModel, parsed);
        if (protocol === "responses") writeResponsesPayload(res, normalizedBody, provider, bareModel, parsed);
        return;
      }
      if (typeof res.writeHead === "function") res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      else res.statusCode = upstream.status;
      res.end(payload);
    },
    close() {},
  };
}

function resolveExistingPath(path: string): string {
  const candidates = [resolve(path), resolve("..", path), resolve("../..", path)];
  return candidates.find((candidate) => existsSync(candidate)) ?? resolve(path);
}

function fixtureEmbed(text: string): number[] {
  return /plan|architect|design/i.test(text) ? [0, 1] : [1, 0];
}

export function bootstrapProxyOptions(): CreateProxyServerOptions {
  const config = loadConfig();
  const catalog = loadCatalogSync(config);
  let rankAvengers: CreateProxyServerOptions["rankAvengers"];
  if (config.avengersPro?.enabled) {
    try {
      const artifacts = loadAvengersProArtifacts(resolveExistingPath(config.avengersPro.artifactDir));
      rankAvengers = (text) => scoreAvengersPro(fixtureEmbed(text), artifacts);
    } catch {
      rankAvengers = undefined;
    }
  }
  return {
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
    rankAvengers,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = createProxyServer(bootstrapProxyOptions());
  const host = process.env.AUTO_ROUTER_HOST ?? "127.0.0.1";
  const port = Number(process.env.AUTO_ROUTER_PORT ?? 8787);
  createServer((req, res) => {
    void server.handle(req, res);
  }).listen(port, host, () => {
    console.log(`[auto-router-proxy] listening on http://${host}:${port}`);
  });
}
