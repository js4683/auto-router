import { appendFile, chmod } from "node:fs/promises";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EvalRecordInput, EvalRecorder, RecordingMode } from "./types.js";

export interface JsonlRecorderOptions {
  mode: RecordingMode;
  directory: string;
  retentionDays: number;
  now?: () => Date;
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

function prune(directory: string, retentionDays: number, now: Date): void {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith("auto-router-eval-") || !name.endsWith(".jsonl")) continue;
    const path = join(directory, name);
    if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
  }
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
    requiredCapabilities: input.requiredCapabilities,
    usageSource: input.usageSource,
    usage: input.usage,
    ...(input.contentTruncated ? { contentTruncated: true } : {}),
  };
  if (mode === "metadata") return metadata;
  return redactContent({ ...metadata, messages: input.messages, output: input.output });
}

export function createJsonlRecorder(options: JsonlRecorderOptions): EvalRecorder {
  if (options.mode === "off") return { mode: "off", async record() {}, async flush() {} };
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) throw new Error("retentionDays must be positive");
  const now = options.now ?? (() => new Date());
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  prune(options.directory, options.retentionDays, now());
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const path = join(options.directory, `auto-router-eval-${stamp}-${process.pid}.jsonl`);
  let queue = Promise.resolve();
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
      const write = queue.then(async () => {
        await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
        await chmod(path, 0o600);
      });
      queue = write.catch(() => {});
      return write;
    },
    flush() {
      return queue;
    },
  };
}
