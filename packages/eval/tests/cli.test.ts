import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { fixtureDataset } from "./fixtures.js";

function io(fetchImpl?: typeof fetch) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      env: {} as NodeJS.ProcessEnv,
      fetch: fetchImpl,
    },
  };
}

describe("eval CLI", () => {
  it("writes deterministic JSON and Markdown replay reports", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-eval-"));
    const datasetPath = join(directory, "dataset.json");
    const outputPath = join(directory, "report");
    writeFileSync(datasetPath, JSON.stringify(fixtureDataset()));
    const output = io();

    const status = await runCli(["replay", "--dataset", datasetPath, "--output", outputPath], output.value);

    expect(status).toBe(0);
    expect(JSON.parse(readFileSync(`${outputPath}.json`, "utf8")).mode).toBe("offline");
    expect(readFileSync(`${outputPath}.md`, "utf8")).toContain("# Eval Report");
    expect(output.stderr).toEqual([]);
  });

  it("rejects unknown commands and malformed arguments", async () => {
    const unknown = io();
    expect(await runCli(["unknown"], unknown.value)).toBe(1);
    expect(unknown.stderr.join("\n")).toContain("unknown command unknown");

    const missing = io();
    expect(await runCli(["replay", "--dataset"], missing.value)).toBe(1);
    expect(missing.stderr.join("\n")).toContain("--dataset requires a value");
  });

  it("fails invalid datasets and incomplete pricing before writing reports", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-eval-"));
    const invalidPath = join(directory, "invalid.json");
    writeFileSync(invalidPath, "{");
    const invalid = io();
    expect(await runCli(["replay", "--dataset", invalidPath], invalid.value)).toBe(1);
    expect(invalid.stderr).toHaveLength(1);

    const incompletePath = join(directory, "incomplete.json");
    writeFileSync(incompletePath, JSON.stringify({ ...fixtureDataset(), prices: {} }));
    const incomplete = io();
    expect(await runCli(["replay", "--dataset", incompletePath], incomplete.value)).toBe(1);
    expect(incomplete.stderr.join("\n")).toContain("missing price for model");
  });

  it("requires confirmation and environment credentials before live calls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-eval-"));
    const datasetPath = join(directory, "dataset.json");
    const dataset = fixtureDataset();
    dataset.sessions[0].turns[0].judgeRubric = "Score correctness.";
    dataset.liveModelAliases = { "provider/cheap": "live/cheap", "provider/frontier": "live/frontier" };
    writeFileSync(datasetPath, JSON.stringify(dataset));
    const missingConfirmation = io();
    missingConfirmation.value.env = {
      AUTO_ROUTER_EVAL_BASE_URL: "https://example.com/v1",
      AUTO_ROUTER_EVAL_API_KEY: "secret",
      AUTO_ROUTER_EVAL_JUDGE_MODEL: "live/judge",
    };

    expect(await runCli(["live", "--dataset", datasetPath], missingConfirmation.value)).toBe(1);
    expect(missingConfirmation.stderr.join("\n")).toContain("live evaluation requires --confirm-live");

    const missingEnvironment = io();
    expect(await runCli(["live", "--dataset", datasetPath, "--confirm-live"], missingEnvironment.value)).toBe(1);
    expect(missingEnvironment.stderr.join("\n")).toContain("AUTO_ROUTER_EVAL_BASE_URL is required");
  });

  it("writes a live report through an injected provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-eval-"));
    const datasetPath = join(directory, "dataset.json");
    const outputPath = join(directory, "live-report");
    const dataset = fixtureDataset();
    dataset.sessions[0].turns[0].judgeRubric = "Score correctness.";
    dataset.liveModelAliases = { "provider/cheap": "live/cheap", "provider/frontier": "live/frontier" };
    writeFileSync(datasetPath, JSON.stringify(dataset));
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      const content = body.model === "live/judge" ? JSON.stringify({ scores: { A: 90, B: 90, C: 90 } }) : "provider answer";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    };
    const output = io(fetchImpl);
    output.value.env = {
      AUTO_ROUTER_EVAL_BASE_URL: "https://example.com/v1",
      AUTO_ROUTER_EVAL_API_KEY: "secret",
      AUTO_ROUTER_EVAL_JUDGE_MODEL: "live/judge",
    };

    const status = await runCli(
      ["live", "--dataset", datasetPath, "--output", outputPath, "--confirm-live"],
      output.value
    );

    expect(status).toBe(0);
    expect(calls).toBe(4);
    expect(JSON.parse(readFileSync(`${outputPath}.json`, "utf8")).mode).toBe("live");
    expect(readFileSync(`${outputPath}.json`, "utf8")).not.toContain("secret");
    expect(output.stdout.join("\n")).toContain("planned calls: 3 generation, 1 judge");
  });

  it("writes failure evidence but exits non-zero for incomplete live cases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-eval-"));
    const datasetPath = join(directory, "dataset.json");
    const outputPath = join(directory, "live-report");
    const dataset = fixtureDataset();
    dataset.sessions[0].turns[0].judgeRubric = "Score correctness.";
    dataset.liveModelAliases = { "provider/cheap": "live/cheap", "provider/frontier": "live/frontier" };
    writeFileSync(datasetPath, JSON.stringify(dataset));
    const output = io(async () => new Response("unavailable", { status: 503 }));
    output.value.env = {
      AUTO_ROUTER_EVAL_BASE_URL: "https://example.com/v1",
      AUTO_ROUTER_EVAL_API_KEY: "secret",
      AUTO_ROUTER_EVAL_JUDGE_MODEL: "live/judge",
    };

    const status = await runCli(
      ["live", "--dataset", datasetPath, "--output", outputPath, "--confirm-live"],
      output.value
    );

    expect(status).toBe(1);
    expect(JSON.parse(readFileSync(`${outputPath}.json`, "utf8")).live.cases[0].complete).toBe(false);
    expect(output.stderr.join("\n")).toContain("live evaluation has 1 incomplete case");
  });

  it("curates a recording atomically and warns that review is still required", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-eval-"));
    const basePath = join(directory, "base.json");
    const recordingPath = join(directory, "recording.jsonl");
    const outputPath = join(directory, "curated.json");
    const base = fixtureDataset();
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(
      recordingPath,
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId: "recorded-session",
        turnId: "turn-1",
        recordedAt: "2026-08-31T00:00:00.000Z",
        durationMs: 10,
        status: "completed",
        selection: { modelId: "provider/cheap", via: "value", reason: "fixture" },
        sessionState: base.sessions[0].turns[0].sessionState,
        usageSource: "estimated",
        usage: base.sessions[0].turns[0].usage,
        messages: [{ role: "user", content: "hello" }],
      })}\n`
    );
    const output = io();

    const status = await runCli(
      ["curate", "--input", recordingPath, "--base-dataset", basePath, "--output", outputPath],
      output.value
    );

    expect(status).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).sessions[0].id).toBe("recorded-session");
    expect(output.stderr.join("\n")).toContain("manual review is required before commit");
  });
});
