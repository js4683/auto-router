import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { curateRecording } from "../src/curate.js";
import { parseDataset } from "../src/schema.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

function recording(sessionId: string, turnId: string) {
  const turn = fixtureTurn();
  return {
    schemaVersion: 1,
    sessionId,
    turnId,
    recordedAt: "2026-08-31T00:00:00.000Z",
    durationMs: 10,
    status: "completed",
    selection: { modelId: "provider/cheap", via: "value", reason: "fixture" },
    sessionState: turn.sessionState,
    usageSource: "estimated",
    usage: turn.usage,
    messages: [{ role: "user", content: "Bearer private-token" }],
    output: "completed",
  };
}

function writeLines(lines: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), "auto-router-curate-"));
  const path = join(directory, "recording.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

describe("curateRecording", () => {
  it("groups ordered turns into a validated, defensively redacted dataset", () => {
    const path = writeLines([recording("session-1", "turn-1"), recording("session-1", "turn-2"), recording("session-2", "turn-1")]);
    const dataset = curateRecording(path, fixtureDataset());

    expect(parseDataset(dataset)).toBe(dataset);
    expect(dataset.sessions.map((session) => session.id)).toEqual(["session-1", "session-2"]);
    expect(dataset.sessions[0].turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2"]);
    expect(JSON.stringify(dataset)).not.toContain("private-token");
    expect(dataset.sessions[0].turns[0].observed).toMatchObject({ modelId: "provider/cheap", usageSource: "estimated", output: "completed" });
  });

  it("rejects malformed, unsupported, and duplicate recording lines", () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-curate-"));
    const malformed = join(directory, "malformed.jsonl");
    writeFileSync(malformed, "{\n");
    expect(() => curateRecording(malformed, fixtureDataset())).toThrow("recording line 1 is invalid JSON");

    expect(() => curateRecording(writeLines([{ ...recording("session-1", "turn-1"), schemaVersion: 2 }]), fixtureDataset())).toThrow(
      "unsupported recording schemaVersion 2"
    );
    expect(() => curateRecording(writeLines([recording("session-1", "turn-1"), recording("session-1", "turn-1")]), fixtureDataset())).toThrow(
      "duplicate recorded turn session-1/turn-1"
    );
    expect(() => curateRecording(writeLines([{ ...recording("session-1", "turn-1"), status: "unknown" }]), fixtureDataset())).toThrow(
      "recording line 1 has invalid status"
    );
    expect(() => curateRecording(writeLines([{ ...recording("session-1", "turn-1"), durationMs: -1 }]), fixtureDataset())).toThrow(
      "recording line 1 has invalid durationMs"
    );
    expect(() =>
      curateRecording(
        writeLines([{ ...recording("session-1", "turn-1"), selection: { modelId: "provider/cheap", via: 1, reason: "fixture" } }]),
        fixtureDataset()
      )
    ).toThrow("recording line 1 has invalid selection");
  });
});
