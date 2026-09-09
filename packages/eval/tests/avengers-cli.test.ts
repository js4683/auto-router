import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

function io(fetchImpl?: typeof fetch) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      env: {
        AUTO_ROUTER_EVAL_BASE_URL: "https://example.com/v1",
        AUTO_ROUTER_EVAL_API_KEY: "key",
        AUTO_ROUTER_EVAL_JUDGE_MODEL: "judge",
        AUTO_ROUTER_EMBEDDING_BASE_URL: "https://embed.test/v1",
        AUTO_ROUTER_EMBEDDING_API_KEY: "embed-key",
        AUTO_ROUTER_EMBEDDING_MODEL: "embed/test",
      } as NodeJS.ProcessEnv,
      fetch: fetchImpl,
    },
  };
}

describe("Phase 4 CLI", () => {
  it("refuses every networked Phase 4 command without confirmation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "avengers-cli-"));
    const datasetPath = join(directory, "dataset.json");
    const corpusPath = join(directory, "corpus.json");
    writeFileSync(datasetPath, JSON.stringify(fixtureDataset([fixtureTurn()])));
    writeFileSync(corpusPath, "{}");
    const output = io();
    expect(await runCli(["collect-avengers", "--dataset", datasetPath], output.value)).toBe(1);
    expect(await runCli(["train-avengers", "--corpus", corpusPath], output.value)).toBe(1);
    expect(await runCli(["validate-avengers", "--corpus", corpusPath], output.value)).toBe(1);
    expect(output.stderr.join("\n")).toContain("requires --confirm-live");
  });

  it("prints collection call counts before the first request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "avengers-cli-"));
    const datasetPath = join(directory, "dataset.json");
    const outputPath = join(directory, "out.jsonl");
    writeFileSync(
      datasetPath,
      JSON.stringify(
        fixtureDataset([
          fixtureTurn({ id: "turn-1", judgeRubric: "Score.", messages: [{ role: "user", content: "one" }] }),
          fixtureTurn({ id: "turn-2", judgeRubric: "Score.", messages: [{ role: "user", content: "two" }] }),
        ])
      )
    );
    const bodies: unknown[] = [];
    const output = io(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.model === "judge") {
        const request = JSON.parse(body.messages[1].content);
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: JSON.stringify({ scores: Object.fromEntries(request.responses.map((item: { label: string }) => [item.label, 80])) }) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );
    });
    const status = await runCli(
      ["collect-avengers", "--dataset", datasetPath, "--models", "paper/a=provider/cheap,paper/b=provider/frontier,paper/c=provider/cheap", "--output", outputPath, "--confirm-live"],
      output.value
    );
    expect(status).toBe(0);
    expect(output.stdout[0]).toBe("planned calls: 6 generation, 2 judge, 8 total");
    expect(bodies.length).toBeGreaterThan(0);
  });

  it("writes transport-failure evidence but exits non-zero", async () => {
    const directory = mkdtempSync(join(tmpdir(), "avengers-cli-"));
    const datasetPath = join(directory, "dataset.json");
    const outputPath = join(directory, "out.jsonl");
    writeFileSync(datasetPath, JSON.stringify(fixtureDataset([fixtureTurn({ judgeRubric: "Score." })])));
    const output = io(async () => new Response("rate limited", { status: 429 }));
    output.value.env.AUTO_ROUTER_EVAL_RETRY_MAX_ATTEMPTS = "1";

    const status = await runCli(
      ["collect-avengers", "--dataset", datasetPath, "--models", "paper/a=provider/cheap,paper/b=provider/frontier", "--output", outputPath, "--confirm-live"],
      output.value,
    );

    expect(status).toBe(1);
    expect(output.stderr.join("\n")).toContain("generation failed");
    expect(readFileSync(outputPath, "utf8")).toContain('"terminalState":"failed"');
  });

  it("rejects malformed paper=runtime aliases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "avengers-cli-"));
    const datasetPath = join(directory, "dataset.json");
    writeFileSync(datasetPath, JSON.stringify(fixtureDataset()));
    const output = io();
    expect(
      await runCli(["collect-avengers", "--dataset", datasetPath, "--models", "bad", "--output", join(directory, "out.jsonl"), "--confirm-live"], output.value)
    ).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/alias|2 and 26/);
  });

  it("rejects invalid training settings before requesting embeddings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "avengers-cli-"));
    const corpusPath = fileURLToPath(new URL("../fixtures/phase-4-corpus.v1.json", import.meta.url));
    let requests = 0;
    const output = io(async () => {
      requests += 1;
      throw new Error("embedding request should not run");
    });

    const status = await runCli([
      "train-avengers",
      "--corpus", corpusPath,
      "--artifact-dir", join(directory, "artifact"),
      "--cache", join(directory, "embeddings.json"),
      "--clusters", "2",
      "--seed", "fixture-seed",
      "--held-out-ratio", "0.34",
      "--top-k", "3",
      "--beta", "9",
      "--min-observations", "1",
      "--max-input-chars", "16000",
      "--timeout-ms", "400",
      "--confirm-live",
    ], output.value);

    expect(status).toBe(1);
    expect(requests).toBe(0);
    expect(output.stderr).toContain("topK must not exceed clusters");
  });
});
