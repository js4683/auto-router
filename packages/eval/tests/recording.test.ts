import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJsonlRecorder, redactContent } from "../src/recording.js";
import type { EvalRecordInput } from "../src/types.js";
import { fixtureTurn } from "./fixtures.js";

function record(id: string): EvalRecordInput {
  const turn = fixtureTurn();
  return {
    sessionId: "session-1",
    turnId: id,
    recordedAt: "2026-08-31T00:00:00.000Z",
    durationMs: 10,
    status: "completed",
    selection: { modelId: "provider/cheap", via: "value", reason: "fixture" },
    sessionState: turn.sessionState,
    usageSource: "estimated",
    usage: turn.usage,
    requiredCapabilities: ["text"],
    messages: [{ role: "user", content: "Bearer token-value" }],
    output: "key sk-ant-api-value",
  };
}

describe("recording redaction", () => {
  it("redacts representative credentials recursively", () => {
    expect(
      redactContent({
        bearer: "Bearer token-value",
        openai: "sk-examplevalue123456",
        anthropic: "sk-ant-examplevalue123456",
        gemini: "AIzaExampleValue1234567890",
        query: "api_key=example-value",
        nested: ["ordinary text"],
      })
    ).toEqual({
      bearer: "Bearer [REDACTED]",
      openai: "[REDACTED]",
      anthropic: "[REDACTED]",
      gemini: "[REDACTED]",
      query: "api_key=[REDACTED]",
      nested: ["ordinary text"],
    });
  });

  it("redacts values under structured credential keys", () => {
    expect(
      redactContent({
        apiKey: "plain-api-value",
        nested: {
          access_token: "plain-token-value",
          password: "plain-password-value",
          clientSecret: "plain-secret-value",
          promptTokens: 100,
        },
      })
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: {
        access_token: "[REDACTED]",
        password: "[REDACTED]",
        clientSecret: "[REDACTED]",
        promptTokens: 100,
      },
    });
  });

  it("rejects cyclic content", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactContent(cyclic)).toThrow("recording content must not be cyclic");
  });
});

describe("JSONL recorder", () => {
  it("writes nothing in off mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    const recorder = createJsonlRecorder({ mode: "off", directory, retentionDays: 30 });
    await recorder.record(record("turn-1"));
    await recorder.flush();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("minimizes metadata and redacts opt-in content with restrictive permissions", async () => {
    const metadataDirectory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    const metadata = createJsonlRecorder({ mode: "metadata", directory: metadataDirectory, retentionDays: 30 });
    await metadata.record(record("turn-1"));
    await metadata.flush();
    const metadataFile = join(metadataDirectory, readdirSync(metadataDirectory)[0]);
    const metadataLine = JSON.parse(readFileSync(metadataFile, "utf8"));
    expect(metadataLine.messages).toBeUndefined();
    expect(metadataLine.output).toBeUndefined();
    expect(metadataLine.usageSource).toBe("estimated");
    expect(metadataLine.requiredCapabilities).toEqual(["text"]);
    expect(metadataLine.sessionState.currentTask.lastUserMessage).toBe("[REDACTED]");
    expect(metadataLine.sessionState.currentTask.promptTokens).toBe(20);
    expect(metadataLine.sessionState.currentTask.taskTokens).toBe(1000);
    expect(JSON.stringify(metadataLine)).not.toContain("Implement the fixture");

    const contentDirectory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    const content = createJsonlRecorder({ mode: "content", directory: contentDirectory, retentionDays: 30 });
    await content.record(record("turn-1"));
    await content.flush();
    const contentFile = join(contentDirectory, readdirSync(contentDirectory)[0]);
    const contentLine = readFileSync(contentFile, "utf8");
    expect(contentLine).toContain("[REDACTED]");
    expect(contentLine).not.toContain("token-value");
    expect(contentLine).not.toContain("api-value");
    expect(statSync(contentFile).mode & 0o777).toBe(0o600);
  });

  it("serializes concurrent writes in call order and rejects headers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    const recorder = createJsonlRecorder({ mode: "metadata", directory, retentionDays: 30 });
    await Promise.all([recorder.record(record("turn-1")), recorder.record(record("turn-2")), recorder.record(record("turn-3"))]);
    await recorder.flush();
    const lines = readFileSync(join(directory, readdirSync(directory)[0]), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
    await expect(recorder.record({ ...record("turn-4"), headers: { authorization: "secret" } } as any)).rejects.toThrow(
      "recording input must not contain headers"
    );
  });

  it("prunes only expired recorder files", () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    const old = join(directory, "auto-router-eval-old.jsonl");
    const recent = join(directory, "auto-router-eval-recent.jsonl");
    const unrelated = join(directory, "keep.txt");
    writeFileSync(old, "");
    writeFileSync(recent, "");
    writeFileSync(unrelated, "");
    utimesSync(old, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
    utimesSync(recent, new Date("2026-08-30T00:00:00.000Z"), new Date("2026-08-30T00:00:00.000Z"));

    createJsonlRecorder({ mode: "metadata", directory, retentionDays: 30, now: () => new Date("2026-08-31T00:00:00.000Z") });

    expect(readdirSync(directory).sort()).toEqual(["auto-router-eval-recent.jsonl", "keep.txt"]);
  });

  it("bounds queued writes and reports dropped records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = vi.fn(async (...args: any[]) => {
      const [path, line] = args;
      writeFileSync(path, line, { flag: "a", mode: 0o600 });
      await gate;
    });
    const recorder = createJsonlRecorder({ mode: "metadata", directory, retentionDays: 30, maxQueuedRecords: 1, appendFileImpl: append });

    const first = recorder.record(record("turn-1"));
    const dropped = recorder.record(record("turn-2"));
    expect(recorder.stats?.()).toMatchObject({ queued: 1, dropped: 1 });
    release();
    await first;
    await dropped;
    expect(recorder.stats?.()).toMatchObject({ queued: 0, dropped: 1, written: 1 });
  });

  it("prunes expired files during recorder activity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    const old = join(directory, "auto-router-eval-old.jsonl");
    writeFileSync(old, "");
    utimesSync(old, new Date("2026-08-01T00:00:30.000Z"), new Date("2026-08-01T00:00:30.000Z"));
    let current = new Date("2026-08-31T00:00:00.000Z");
    const recorder = createJsonlRecorder({ mode: "metadata", directory, retentionDays: 30, now: () => current });

    current = new Date("2026-08-31T00:01:01.000Z");
    await recorder.record(record("turn-maintenance"));
    await recorder.flush();

    expect(readdirSync(directory)).not.toContain("auto-router-eval-old.jsonl");
  });

  it("persists final target and ordered attempts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-recording-"));
    const recorder = createJsonlRecorder({ mode: "metadata", directory, retentionDays: 30 });
    await recorder.record({
      ...record("turn-final"),
      attempts: [{ provider: "openai", runtimeModelId: "openai/slow", status: 429 }, { provider: "anthropic", runtimeModelId: "anthropic/fast", status: 200 }],
      finalRuntimeId: "anthropic/fast",
    });
    await recorder.flush();

    const line = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), "utf8"));
    expect(line.attempts).toHaveLength(2);
    expect(line.finalRuntimeId).toBe("anthropic/fast");
  });
});
