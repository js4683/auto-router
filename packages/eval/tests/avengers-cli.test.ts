import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
