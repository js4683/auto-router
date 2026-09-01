import { createHmac, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  createJsonlRecorder,
  type EvalMessage,
  type EvalRecordInput,
  type EvalRecorder,
  type RecordingMode,
} from "@auto-router/eval";

export interface ProxyEvalRecordContext {
  sessionId: string;
  turnId: string;
  startedAt: number;
  protocol: "chat" | "anthropic" | "responses";
  selection: EvalRecordInput["selection"];
  sessionState: EvalRecordInput["sessionState"];
  requiredCapabilities: string[];
  messages?: EvalMessage[];
}

const MAX_RECORDED_RESPONSE_BYTES = 512 * 1024;
const RECORDING_ID_SECRET = randomBytes(32);

function opaqueRecordingId(kind: "session" | "turn", value: string): string {
  const digest = createHmac("sha256", RECORDING_ID_SECRET).update(`${kind}\0${value}`).digest("hex");
  return `${kind}-${digest}`;
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

function objectPayload(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function responsePayloads(output: string): Record<string, any>[] {
  try {
    const payload = objectPayload(JSON.parse(output));
    if (payload) return [payload];
  } catch {}

  const payloads: Record<string, any>[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("data:")) continue;
    const data = line.slice(line.indexOf(":") + 1).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = objectPayload(JSON.parse(data));
      if (payload) payloads.push(payload);
    } catch {}
  }
  return payloads;
}

function terminalStatus(protocol: ProxyEvalRecordContext["protocol"], payload: Record<string, any>): EvalRecordInput["status"] | undefined {
  if (protocol === "chat") {
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason === "length") return "incomplete";
    if (finishReason === "content_filter") return "failed";
    if (finishReason === "stop" || finishReason === "tool_calls") return "completed";
    return undefined;
  }
  if (protocol === "anthropic") {
    const stopReason = payload.stop_reason ?? payload.delta?.stop_reason ?? payload.message?.stop_reason;
    if (stopReason === "max_tokens") return "incomplete";
    if (stopReason === "refusal") return "failed";
    if (stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === "tool_use") return "completed";
    return undefined;
  }

  const status = payload.status ?? payload.response?.status;
  if (status === "completed") return "completed";
  if (status === "incomplete" || status === "in_progress" || status === "queued") return "incomplete";
  if (status === "failed" || status === "cancelled") return "failed";
  if (payload.type === "response.completed") return "completed";
  if (payload.type === "response.incomplete") return "incomplete";
  if (payload.type === "response.failed") return "failed";
  return undefined;
}

function recordedStatus(statusCode: number, output: string, protocol: ProxyEvalRecordContext["protocol"]): EvalRecordInput["status"] {
  if (statusCode >= 400) return "failed";
  const statuses = responsePayloads(output).flatMap((payload) => {
    const status = terminalStatus(protocol, payload);
    return status ? [status] : [];
  });
  return statuses[statuses.length - 1] ?? "incomplete";
}

function tapResponse(res: ServerResponse, complete: (output: string, truncated: boolean) => Promise<void>): void {
  const target = res as any;
  const originalWrite = target.write.bind(target);
  const originalEnd = target.end.bind(target);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let completed = false;
  const capture = (chunk: unknown) => {
    if (chunk === undefined || chunk === null || truncated) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = MAX_RECORDED_RESPONSE_BYTES - bytes;
    if (buffer.byteLength > remaining) truncated = true;
    if (remaining > 0) {
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(buffer.byteLength, remaining);
    }
  };
  target.write = (chunk: unknown, ...args: unknown[]) => {
    capture(chunk);
    return originalWrite(chunk, ...args);
  };
  target.end = (chunk?: unknown, ...args: unknown[]) => {
    capture(chunk);
    const result = originalEnd(chunk, ...args);
    if (!completed) {
      completed = true;
      void complete(Buffer.concat(chunks).toString("utf8"), truncated).catch(() => {
        console.warn("[auto-router] eval recording failed");
      });
    }
    return result;
  };
}

export function recordProxyResponse(res: ServerResponse, recorder: EvalRecorder, context: ProxyEvalRecordContext): void {
  tapResponse(res, async (output, contentTruncated) => {
    await recorder.record({
      sessionId: opaqueRecordingId("session", context.sessionId),
      turnId: opaqueRecordingId("turn", context.turnId),
      recordedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - context.startedAt),
      status: recordedStatus(res.statusCode, output, context.protocol),
      selection: context.selection,
      sessionState: context.sessionState,
      requiredCapabilities: context.requiredCapabilities,
      usageSource: "estimated",
      usage: {
        inputTokens: context.sessionState.currentTask.taskTokens,
        outputTokens: estimateTokens(output),
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      ...(context.messages ? { messages: context.messages } : {}),
      ...(output ? { output } : {}),
      ...(contentTruncated ? { contentTruncated: true } : {}),
    });
  });
}

export function createProxyRecorderFromEnv(env: NodeJS.ProcessEnv = process.env): EvalRecorder | undefined {
  const mode = env.AUTO_ROUTER_EVAL_RECORD_MODE ?? "off";
  if (!["off", "metadata", "content"].includes(mode)) {
    throw new Error("AUTO_ROUTER_EVAL_RECORD_MODE must be off, metadata, or content");
  }
  if (mode === "off") return undefined;
  return createJsonlRecorder({
    mode: mode as RecordingMode,
    directory: resolve(env.AUTO_ROUTER_EVAL_RECORD_DIR ?? ".eval-recordings"),
    retentionDays: Number(env.AUTO_ROUTER_EVAL_RETENTION_DAYS ?? 30),
  });
}
