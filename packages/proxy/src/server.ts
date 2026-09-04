import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectBoundary,
  loadCatalogSync,
  loadConfig,
  selectModel,
  type AvengersProPrediction,
  type Catalog,
  type RouterConfig,
  type SelectionResult,
  type SessionState,
} from "@auto-router/router-core";
import type { EvalRecorder } from "@auto-router/eval";
import { createAvengersRuntime } from "./avengers-runtime.js";
import { defaultEnvPath, ENV_KEYS, readEnvFile, writeEnvFile } from "./env-file.js";
import { createProxyRecorderFromEnv, recordProxyResponse } from "./eval-recording.js";
import { memorySessions, type ProxySessionStore } from "./session.js";
import { settingsPage } from "./settings-ui.js";

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
  rankAvengers?: (text: string) => AvengersProPrediction | Promise<AvengersProPrediction>;
  recorder?: EvalRecorder;
  envPath?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const ZEN_MODEL_HINT = /muse-spark|contributor-free|big-pickle|mimo-v2|nemotron|ling-3|hy3-free|gpt-5|grok-/i;
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
  const path = url?.split("?", 1)[0];
  if (path === "/v1/messages") return "anthropic";
  if (path === "/v1/responses") return "responses";
  return "chat";
}

function bearerToken(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^Bearer\s+/i, "").trim() || undefined;
}

/**
 * Inbound client credentials only apply when the client's protocol matches the
 * routed provider. A Claude Code OAuth header must never reach Zen or Gemini.
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
  const matches = protocol === "chat" || (protocol === "responses" && provider === "openai");
  if (!matches) return {};
  const authorization = headers.authorization ?? headers.Authorization;
  return { authorization, token: bearerToken(authorization) };
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
    const content = messageText(message?.content);
    const text = TEXT_MESSAGE_ROLES.has(message?.role) && content !== undefined ? [{ role: message.role, content }] : [];
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

function anthropicRequestMessages(body: any): unknown[] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.flatMap((message: any) => {
    if (message?.role === "system" || message?.role === "developer") return [];
    if (message?.role === "tool") {
      return [{ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: messageText(message.content) ?? "" }] }];
    }
    if (message?.role !== "user" && message?.role !== "assistant") return [];
    const content = messageText(message.content);
    const textBlock = content === undefined ? [] : [{ type: "text", text: content }];
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
    const blocks = [...textBlock, ...toolBlocks];
    if (!blocks.length) return [];
    return [{ role: message.role, content: blocks.length === 1 && blocks[0].type === "text" ? content : blocks }];
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

const geminiThoughtSignatures = new Map<string, string>();

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
    const content = messageText(message?.content);
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = content === undefined ? [] : [{ text: content }];
    const calls = Array.isArray(message?.tool_calls)
      ? message.tool_calls
          .filter((call: any) => call?.function?.name)
          .map((call: any) => {
            const sig =
              (call as any).thoughtSignature ??
              (call as any).thought_signature ??
              (call as any).function?.thoughtSignature ??
              (call as any).function?.thought_signature ??
              geminiThoughtSignatures.get(call.id);
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

function geminiFunctionCalls(payload: any): Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }> {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return (Array.isArray(parts) ? parts : [])
    .filter((part: any) => part?.functionCall?.name)
    .map((part: any, index: number) => {
      const sig = part.thoughtSignature ?? part.thought_signature ?? part.functionCall?.thoughtSignature ?? part.functionCall?.thought_signature;
      const id = part.functionCall?.id ?? `call_${part.functionCall.name}_${index}`;
      if (sig) geminiThoughtSignatures.set(id, sig);
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
  inboundPath: string | undefined
): UpstreamRequest {
  if (provider === "openai" && protocol === "responses") {
    return { body: { ...originalBody, model }, path: "/v1/responses", translateResponse: false, useGemini: false };
  }
  if (provider === "google") {
    const isStream = !!normalizedBody.stream && protocol === "chat";
    const key = token ? `?key=${encodeURIComponent(token)}` : "";
    const alt = isStream ? (key ? "&alt=sse" : "?alt=sse") : "";
    const action = isStream ? "streamGenerateContent" : "generateContent";
    return { body: geminiRequest(normalizedBody), path: `/models/${model}:${action}${key}${alt}`, translateResponse: true, useGemini: true };
  }
  if (provider === "anthropic") {
    const native = protocol === "anthropic";
    if (native) {
      return { body: { ...originalBody, model }, path: "/v1/messages", translateResponse: !native, useGemini: false };
    }
    const body: any = { ...anthropicRequest(normalizedBody, model), stream: false };
    return { body, path: "/v1/messages", translateResponse: !native, useGemini: false };
  }
  if (provider === "opencode") {
    const body: any = { ...zenRequest(normalizedBody, model), stream: false };
    return { body, path: "/v1/responses", translateResponse: true, useGemini: false };
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

function requiredCapabilities(body: any): string[] {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const declaredTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const toolMessages = messages.some(
    (message: any) =>
      message?.role === "tool" ||
      (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
  );
  return ["text", ...(declaredTools || toolMessages ? ["tools"] : [])];
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
  if (provider === "anthropic") {
    const parts = Array.isArray(payload?.content) ? payload.content : [];
    const content = parts
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text ?? "")
      .join("");
    const refusal = parts
      .filter((part: any) => part?.type === "refusal")
      .map((part: any) => part.refusal ?? "")
      .join("");
    return { content, ...(refusal ? { refusal } : {}) };
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

type ChatFinishReason = "stop" | "length" | "content_filter" | "tool_calls";

function nativeFinishReason(payload: any, provider: string, refusal?: string, toolCalls: unknown[] = []): ChatFinishReason {
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
  if (provider === "anthropic") {
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    return blocks
      .filter((block: any) => block?.type === "tool_use" && block.id && block.name)
      .map((block: any) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }));
  }
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

function writeResponsesPayload(res: ServerResponse, body: any, provider: string, model: string, payload: any): void {
  const { content, refusal } = nativeResponse(payload, provider);
  const toolCalls = nativeToolCalls(payload, provider);
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
  async function decide(req: IncomingMessage, body: any, text: string): Promise<SelectionResult> {
    const id = sessionId(req, text);
    const stored = opts.sessions.get(id);
    const isNewSession = !stored.taskTarget;
    const state = sessionState(body, text, isNewSession);
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

    let prediction: AvengersProPrediction | undefined;
    try {
      prediction = await opts.rankAvengers?.(text);
    } catch {
      prediction = undefined;
    }

    const result = opts.select(state, opts.catalog, opts.config, { currentModel: null, currentTier: null, downgradeCounter: 0 }, undefined, stored.prevMessage, prediction);
    opts.sessions.set(id, { taskTarget: result.modelId, prevMessage: text });
    return result;
  }

  return {
    async handle(req, res) {
      const startedAt = Date.now();
      const path = req.url?.split("?", 1)[0];
      if (path === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && (path === "/" || path === "/ui")) {
        const env = readEnvFile(opts.envPath ?? defaultEnvPath());
        const masked = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key] ? "set" : "missing"]));
        html(res, 200, settingsPage(masked));
        return;
      }
      if (req.method === "POST" && path === "/settings") {
        const raw = await readBody(req);
        const updates = Object.fromEntries(new URLSearchParams(raw));
        writeEnvFile(opts.envPath ?? defaultEnvPath(), updates);
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

      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const protocol = ingressProtocol(req.url);
      const normalizedBody = normalizeIngress(body, protocol);
      const messages = textMessages(normalizedBody);
      const text = lastUserText(messages);
      const id = sessionId(req, text);
      const state = sessionState(normalizedBody, text, !opts.sessions.get(id).taskTarget);
      const result = await decide(req, normalizedBody, text);

      if (path === "/v1/route") {
        json(res, 200, { modelId: result.modelId, via: result.via });
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
          requiredCapabilities: requiredCapabilities(normalizedBody),
          ...(Array.isArray(normalizedBody.messages) ? { messages: normalizedBody.messages } : {}),
        });
      }

      const { provider, bareModel } = resolveProvider(result.modelId);
      const backend = opts.backends[provider];
      if (!backend) {
        json(res, 502, { error: `no backend for ${provider}` });
        return;
      }

      const inbound = inboundCredentials(req.headers, protocol, provider);
      const authorization = backend.apiKey ? `Bearer ${backend.apiKey}` : inbound.authorization;
      const token = backend.apiKey ?? inbound.token;
      const upstreamRequestPlan = upstreamRequest(protocol, body, normalizedBody, provider, bareModel, token, req.url);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (provider === "anthropic") {
        if (token) headers["x-api-key"] = token;
        headers["anthropic-version"] = "2023-06-01";
        const beta = req.headers["anthropic-beta"];
        if (protocol === "anthropic" && typeof beta === "string") headers["anthropic-beta"] = beta;
      } else if (!upstreamRequestPlan.useGemini && typeof authorization === "string" && authorization) {
        headers.authorization = authorization;
      }
      const fetchImpl = backend.fetchImpl ?? fetch;
      const upstream = await fetchImpl(`${backend.baseUrl}${upstreamRequestPlan.path}`, {
        method: req.method,
        headers,
        body: JSON.stringify(upstreamRequestPlan.body),
      });

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
                let idx;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                  const raw = buf.slice(0, idx);
                  buf = buf.slice(idx + 2);
                  if (raw.trim()) (res as any).write(raw + "\n\n");
                }
              }
              if (buf.trim()) (res as any).write(buf);
            } else {
              const text = await upstream.text();
              (res as any).write(text);
            }
          }
          (res as any).end();
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
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const line = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
              if (!line || line === "[DONE]") continue;
              try {
                const payloadJson = JSON.parse(line);
                const textDelta = payloadJson.candidates?.[0]?.content?.parts?.[0]?.text ?? payloadJson.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
                if (textDelta) {
                  const delta: any = firstDelta ? { role: "assistant", content: textDelta } : { content: textDelta };
                  firstDelta = false;
                  const downstreamChunk = { id, object: "chat.completion.chunk", created, model: bareModel, choices: [{ index: 0, delta, logprobs: null, finish_reason: null }] };
                  (res as any).write(`data: ${JSON.stringify(downstreamChunk)}\n\n`);
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
          (res as any).write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          (res as any).write("data: [DONE]\n\n");
          (res as any).end();
          return;
        }
      }

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
    close() {
      void opts.recorder?.flush().catch(() => {
        console.warn("[auto-router] eval recording flush failed");
      });
    },
  };
}

export function bootstrapProxyOptions(): CreateProxyServerOptions {
  const config = loadConfig();
  const catalog = loadCatalogSync(config);
  const runtime = createAvengersRuntime({
    config,
    env: process.env,
    warn: (event) => console.warn("[auto-router]", event.code),
  });
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
    rankAvengers: runtime ? (text) => runtime.rank(text) : undefined,
    recorder: createProxyRecorderFromEnv(),
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
