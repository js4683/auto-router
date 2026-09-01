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

function recordedStatus(statusCode: number, output: string): EvalRecordInput["status"] {
  if (statusCode >= 400) return "failed";
  try {
    if (JSON.parse(output)?.status === "incomplete") return "incomplete";
  } catch {}
  if (output.includes('"response.incomplete"') || output.includes('"finish_reason":"length"')) return "incomplete";
  return "completed";
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
      status: recordedStatus(res.statusCode, output),
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
