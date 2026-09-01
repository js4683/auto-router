import { readFileSync, statSync } from "node:fs";
import { redactContent } from "./recording.js";
import { parseDataset } from "./schema.js";
import type { EvalDatasetV1, EvalMessage, EvalSessionV1, EvalTurnV1, UsageSource } from "./types.js";

interface RecordedTurn {
  schemaVersion: number;
  sessionId: string;
  turnId: string;
  recordedAt: string;
  durationMs: number;
  status: "completed" | "incomplete" | "failed";
  selection: { modelId: string; via: string; reason: string };
  sessionState: EvalTurnV1["sessionState"];
  usageSource: UsageSource;
  usage: EvalTurnV1["usage"];
  messages?: EvalMessage[];
  output?: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseLine(line: string, index: number): RecordedTurn {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`recording line ${index} is invalid JSON`);
  }
  const value = object(raw, `recording line ${index}`);
  if (value.schemaVersion !== 1) throw new Error(`unsupported recording schemaVersion ${String(value.schemaVersion)}`);
  if (typeof value.sessionId !== "string" || typeof value.turnId !== "string") throw new Error(`recording line ${index} has invalid IDs`);
  if (typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new Error(`recording line ${index} has invalid recordedAt`);
  }
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    throw new Error(`recording line ${index} has invalid durationMs`);
  }
  if (!["completed", "incomplete", "failed"].includes(String(value.status))) throw new Error(`recording line ${index} has invalid status`);
  const selection = object(value.selection, `recording line ${index} selection`);
  if (typeof selection.modelId !== "string" || typeof selection.via !== "string" || typeof selection.reason !== "string") {
    throw new Error(`recording line ${index} has invalid selection`);
  }
  if (!["provider", "estimated"].includes(String(value.usageSource))) throw new Error(`recording line ${index} has invalid usageSource`);
  return raw as RecordedTurn;
}

function evalTurn(record: RecordedTurn): EvalTurnV1 {
  const messages = record.messages === undefined ? undefined : (redactContent(record.messages) as EvalMessage[]);
  const output = record.output === undefined ? undefined : redactContent(record.output);
  const sessionState = redactContent(record.sessionState) as EvalTurnV1["sessionState"];
  return {
    id: record.turnId,
    sessionState,
    usage: record.usage,
    ...(messages ? { messages } : {}),
    observed: {
      modelId: record.selection.modelId,
      usageSource: record.usageSource,
      usage: record.usage,
      ...(output === undefined ? {} : { output }),
    },
  };
}

export function curateRecording(path: string, baseDataset: EvalDatasetV1): EvalDatasetV1 {
  if (statSync(path).size > 50 * 1024 * 1024) throw new Error("recording exceeds 50 MiB");
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("recording is empty");
  const sessions = new Map<string, EvalSessionV1>();
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const record = parseLine(line, index + 1);
    const key = `${record.sessionId}/${record.turnId}`;
    if (seen.has(key)) throw new Error(`duplicate recorded turn ${key}`);
    seen.add(key);
    const session = sessions.get(record.sessionId) ?? { id: record.sessionId, turns: [] };
    session.turns.push(evalTurn(record));
    sessions.set(record.sessionId, session);
  });
  return parseDataset({
    ...baseDataset,
    id: `${baseDataset.id}-curated`,
    description: `Curated recording based on ${baseDataset.id}`,
    sessions: [...sessions.values()],
  });
}
