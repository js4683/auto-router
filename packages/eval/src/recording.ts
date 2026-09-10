import { appendFile, chmod } from "node:fs/promises";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EvalRecordInput, EvalRecorder, RecordingMode } from "./types.js";

export interface JsonlRecorderOptions {
  mode: RecordingMode;
  directory: string;
  retentionDays: number;
  now?: () => Date;
  maxQueuedRecords?: number;
  appendFileImpl?: typeof appendFile;
}

const REDACTED_PROMPT = "[REDACTED]";
const CREDENTIAL_KEYS = new Set([
  "apikey",
  "apitoken",
  "xapikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "secretaccesskey",
  "privatekey",
]);

function redactString(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^&\s"']+/gi, "$1[REDACTED]");
}

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 20) throw new Error("recording content exceeds maximum depth 20");
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("recording content must not be cyclic");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => redact(entry, depth + 1, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          isCredentialKey(key) ? REDACTED_PROMPT : redact(entry, depth + 1, seen),
        ])
      );
  seen.delete(value);
  return result;
}

export function redactContent(value: unknown): unknown {
  return redact(value, 0, new WeakSet());
}

function metadataSessionState(input: EvalRecordInput["sessionState"]): EvalRecordInput["sessionState"] {
  return {
    ...input,
    currentTask: { ...input.currentTask, lastUserMessage: REDACTED_PROMPT },
  };
}

function prune(directory: string, retentionDays: number, now: Date): number {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith("auto-router-eval-") || !name.endsWith(".jsonl")) continue;
    const path = join(directory, name);
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      removed += 1;
    }
  }
  return removed;
}

function persistedInput(input: EvalRecordInput, mode: Exclude<RecordingMode, "off">): unknown {
  if ("headers" in (input as unknown as Record<string, unknown>)) throw new Error("recording input must not contain headers");
  const metadata = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    turnId: input.turnId,
    recordedAt: input.recordedAt,
    durationMs: input.durationMs,
    status: input.status,
    selection: input.selection,
    sessionState: mode === "metadata" ? metadataSessionState(input.sessionState) : input.sessionState,
    ...(input.sessionStable !== undefined ? { sessionStable: input.sessionStable } : {}),
    requiredCapabilities: input.requiredCapabilities,
    usageSource: input.usageSource,
    usage: input.usage,
    ...(input.attempts ? { attempts: input.attempts } : {}),
    ...(input.finalRuntimeId ? { finalRuntimeId: input.finalRuntimeId } : {}),
    ...(input.contentTruncated ? { contentTruncated: true } : {}),
  };
  if (mode === "metadata") return metadata;
  return redactContent({ ...metadata, messages: input.messages, output: input.output });
}

export function createJsonlRecorder(options: JsonlRecorderOptions): EvalRecorder {
  if (options.mode === "off") return { mode: "off", async record() {}, async flush() {} };
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) throw new Error("retentionDays must be positive");
  const maxQueuedRecords = options.maxQueuedRecords ?? 100;
  if (!Number.isInteger(maxQueuedRecords) || maxQueuedRecords < 1) throw new Error("maxQueuedRecords must be a positive integer");
  const now = options.now ?? (() => new Date());
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  let pruned = prune(options.directory, options.retentionDays, now());
  const initialNow = now();
  let lastPrunedAt = initialNow.getTime();
  const stamp = initialNow.toISOString().replace(/[:.]/g, "-");
  const path = join(options.directory, `auto-router-eval-${stamp}-${process.pid}.jsonl`);
  const append = options.appendFileImpl ?? appendFile;
  let queue = Promise.resolve();
  let queued = 0;
  let dropped = 0;
  let written = 0;
  return {
    mode: options.mode,
    record(input) {
      let line: string;
      try {
        line = `${JSON.stringify(persistedInput(input, options.mode as Exclude<RecordingMode, "off">))}\n`;
      } catch (error) {
        return Promise.reject(error);
      }
      if (Buffer.byteLength(line, "utf8") > 1024 * 1024) return Promise.reject(new Error("recording turn exceeds 1 MiB"));
      if (queued >= maxQueuedRecords) {
        dropped += 1;
        return Promise.resolve();
      }
      queued += 1;
      const write = queue.then(async () => {
        const current = now();
        if (current.getTime() - lastPrunedAt >= 60_000) {
          pruned += prune(options.directory, options.retentionDays, current);
          lastPrunedAt = current.getTime();
        }
        await append(path, line, { encoding: "utf8", mode: 0o600 });
        await chmod(path, 0o600);
        written += 1;
      });
      queue = write.catch(() => {}).finally(() => {
        queued -= 1;
      });
      return write;
    },
    flush() {
      return queue;
    },
    stats() {
      return { queued, dropped, written, pruned };
    },
  };
}
