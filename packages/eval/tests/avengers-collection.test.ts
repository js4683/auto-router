import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectAvengersOutcomes,
  curateAvengersCollection,
  parseAvengersAliases,
  planAvengersCollection,
  type AvengersAliasMap,
} from "../src/avengers-collection.js";
import { judgeLabeledOutputs, type JudgeClientConfig } from "../src/live.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

const config: JudgeClientConfig = {
  baseUrl: "https://example.com/v1",
  apiKey: "secret-key",
  timeoutMs: 20,
  maxOutputTokens: 64,
  judgeModel: "judge/model",
};

function aliases(): AvengersAliasMap {
  return parseAvengersAliases("paper/a=provider/cheap,paper/b=provider/frontier,paper/c=provider/cheap");
}

function dataset() {
  return fixtureDataset([
    fixtureTurn({ id: "turn-1", judgeRubric: "Score correctness.", messages: [{ role: "user", content: "Case one" }] }),
    fixtureTurn({ id: "turn-2", judgeRubric: "Score correctness.", messages: [{ role: "user", content: "Case two" }] }),
  ]);
}

function completion(text: string, finish = "stop"): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 }
  );
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("planAvengersCollection", () => {
  it("prints one generation per case and candidate plus one judge per judgeable case", () => {
    expect(planAvengersCollection(dataset(), aliases())).toEqual({
      exampleCount: 2,
      candidateCount: 3,
      generationCalls: 6,
      judgeCalls: 2,
      totalCalls: 8,
    });
  });

  it("rejects a case without a rubric or deterministic checks", () => {
    const noRubric = fixtureDataset([fixtureTurn({ judgeRubric: undefined })]);

    expect(() => planAvengersCollection(noRubric, aliases())).toThrow("turn turn-1 has no quality signal");
  });

  it("rejects candidate lists outside 2 through 26", () => {
    expect(() => parseAvengersAliases("only=one")).toThrow(/2 and 26/);
  });
});

describe("collectAvengersOutcomes", () => {
  it("preserves an explicit session group in collection evidence", async () => {
    const source = dataset();
    source.sessions[0].sessionGroupId = "shared-group";
    const records = await collectAvengersOutcomes(source, aliases(), config, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === config.judgeModel) {
        const request = JSON.parse(body.messages[1].content);
        return completion(JSON.stringify({ scores: Object.fromEntries(request.responses.map((item: { label: string }) => [item.label, 80])) }));
      }
      return completion("ok");
    });

    expect(records[0].sessionGroupId).toBe("shared-group");
  });

  it("does not retry a timed-out candidate call", async () => {
    let calls = 0;
    const oneTurn = fixtureDataset([fixtureTurn({ judgeRubric: "Score.", messages: [{ role: "user", content: "timeout" }] })]);
    await expect(collectAvengersOutcomes(oneTurn, aliases(), config, async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    })).rejects.toThrow("generation failed");
    expect(calls).toBe(aliases().size * oneTurn.sessions[0].turns.length);
  });

  it("blinds responses and omits model IDs from the judge prompt", async () => {
    const bodies: any[] = [];
    await collectAvengersOutcomes(fixtureDataset([fixtureTurn({ judgeRubric: "Score.", messages: [{ role: "user", content: "hi" }] })]), aliases(), config, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.model === "judge/model") {
        const request = JSON.parse(body.messages[1].content);
        const scores = Object.fromEntries(request.responses.map((item: any) => [item.label, 80]));
        return completion(JSON.stringify({ scores }));
      }
      return completion("ok");
    });
    const judge = bodies.find((body) => body.model === "judge/model");
    expect(judge.messages[1].content).not.toContain("paper/");
    expect(judge.messages[1].content).not.toContain("provider/");
    const request = JSON.parse(judge.messages[1].content);
    expect(request.responses.map((item: any) => item.label).sort()).toEqual(["A", "B", "C"]);
  });

  it("keeps candidate, judge, failed-attempt, and retry accounting separate", async () => {
    const records = await collectAvengersOutcomes(
      fixtureDataset([fixtureTurn({ judgeRubric: "Score.", messages: [{ role: "user", content: "hi" }] })]),
      aliases(),
      { ...config, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 } },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.model === "provider/frontier") return completion("failed", "content_filter");
        if (body.model === "judge/model") {
          const request = JSON.parse(body.messages[1].content);
          return completion(JSON.stringify({ scores: Object.fromEntries(request.responses.map((item: any) => [item.label, 80])) }));
        }
        return completion("ok");
      },
    );
    const costs = records[0].costs as { candidateGeneration: { inputTokens: number }; judge: { inputTokens: number }; failedAttempts: unknown[] };
    expect(costs.candidateGeneration.inputTokens).toBe(30);
    expect(costs.judge.inputTokens).toBe(0);
    expect(costs.failedAttempts).toHaveLength(1);
  });

  it("skips judging when a generation is incomplete", async () => {
    const models: string[] = [];
    await collectAvengersOutcomes(fixtureDataset([fixtureTurn({ judgeRubric: "Score.", messages: [{ role: "user", content: "hi" }] })]), aliases(), config, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      if (body.model === "provider/frontier") return completion("cut", "length");
      return completion("ok");
    });
    expect(models).not.toContain("judge/model");
  });

  it("persists generation records and stops after a judge HTTP failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avengers-judge-fail-"));
    tempDirs.push(dir);
    const output = join(dir, "collection.jsonl");
    const source = fixtureDataset([fixtureTurn({ judgeRubric: "Score.", messages: [{ role: "user", content: "first" }] })]);
    await expect(collectAvengersOutcomes(source, aliases(), config, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === "judge/model") return new Response("unavailable", { status: 503 });
      return completion("ok");
    }, output)).rejects.toThrow("judge failed: provider returned HTTP 503");

    const rows = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].collectionError).toBe("judge failed: provider returned HTTP 503");
    expect(rows[0].outcomes.every((outcome: { qualitySource: string }) => outcome.qualitySource === "unjudged")).toBe(true);
    expect(rows[0].costs.failedAttempts).toEqual([{ modelId: "judge/model", status: 503 }]);
    expect(() => curateAvengersCollection(output, source, aliases())).toThrow("example session-1/turn-1 is unjudged");
  });

  it("records judge usage when a completed judge response is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avengers-judge-payload-fail-"));
    tempDirs.push(dir);
    const output = join(dir, "collection.jsonl");
    const source = fixtureDataset([fixtureTurn({ judgeRubric: "Score.", messages: [{ role: "user", content: "first" }] })]);
    await expect(collectAvengersOutcomes(source, aliases(), config, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === "judge/model") return completion(JSON.stringify({ scores: { A: 80 } }));
      return completion("ok");
    }, output)).rejects.toThrow("judge failed");

    const row = JSON.parse(readFileSync(output, "utf8"));
    expect(row.costs.judge.inputTokens).toBe(10);
    expect(row.costs.failedAttempts).toEqual([
      { modelId: "judge/model", usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 } },
    ]);
  });

  it("preflights user text before making generation calls", async () => {
    let calls = 0;
    const invalid = fixtureDataset([fixtureTurn({ messages: [{ role: "assistant", content: "not a task" }] })]);

    await expect(
      collectAvengersOutcomes(invalid, aliases(), config, async () => {
        calls += 1;
        return completion("ok");
      })
    ).rejects.toThrow("turn turn-1 has no user text");
    expect(calls).toBe(0);
  });

  it("rejects turns without a quality signal before making generation calls", async () => {
    let calls = 0;
    const unlabeled = fixtureDataset([fixtureTurn({ judgeRubric: undefined, checks: [] })]);

    await expect(
      collectAvengersOutcomes(unlabeled, aliases(), config, async () => {
        calls += 1;
        return completion("ok");
      })
    ).rejects.toThrow("turn turn-1 has no quality signal");
    expect(calls).toBe(0);
  });

  it("does not score recorded outcomes against newly generated responses", async () => {
    const records = await collectAvengersOutcomes(
      fixtureDataset([
        fixtureTurn({
          judgeRubric: "Score.",
          checks: [{ type: "recorded-outcome", passed: false }],
          messages: [{ role: "user", content: "hi" }],
        }),
      ]),
      aliases(),
      config,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.model === "judge/model") {
          const request = JSON.parse(body.messages[1].content);
          return completion(JSON.stringify({ scores: Object.fromEntries(request.responses.map((item: any) => [item.label, 80])) }));
        }
        return completion("ok");
      }
    );

    const outcomes = records[0].outcomes as Array<{ quality: number }>;
    expect(outcomes.map((outcome) => outcome.quality)).toEqual([0.8, 0.8, 0.8]);
  });

  it("refuses to append to an existing collection output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avengers-output-"));
    tempDirs.push(dir);
    const output = join(dir, "collection.jsonl");
    const source = fixtureDataset([fixtureTurn({ checks: [{ type: "exact-text", expected: "ok" }] })]);
    const fetchImpl: typeof fetch = async () => completion("ok");
    await collectAvengersOutcomes(source, aliases(), config, fetchImpl, output);
    let calls = 0;

    await expect(
      collectAvengersOutcomes(source, aliases(), config, async () => {
        calls += 1;
        return completion("again");
      }, output)
    ).rejects.toThrow("collection output already exists");
    expect(calls).toBe(0);
    expect(readFileSync(output, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("curateAvengersCollection", () => {
  it("removes responses, keeps provenance, and redacts credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avengers-"));
    tempDirs.push(dir);
    const output = join(dir, "phase-4-collection.local.jsonl");
    const source = fixtureDataset([
      fixtureTurn({
        judgeRubric: "Score.",
        messages: [{ role: "user", content: "Implement with apiKey=sk-secret" }],
        weight: 2,
      }),
    ]);
    await collectAvengersOutcomes(source, aliases(), config, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === "judge/model") {
        const request = JSON.parse(body.messages[1].content);
        return completion(JSON.stringify({ scores: Object.fromEntries(request.responses.map((item: any) => [item.label, 70])) }));
      }
      return completion("ok");
    }, output);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const corpus = curateAvengersCollection(output, source, aliases());
    expect(JSON.stringify(corpus)).not.toContain("response");
    expect(JSON.stringify(corpus)).not.toContain("sk-secret");
    expect(corpus.examples[0].outcomes[0]).toMatchObject({ usageSource: "provider", costSource: "provider-usage" });
    expect(corpus.routingSnapshot.catalog).toEqual(source.catalog);
  });

  it("rejects a collection that omits a dataset turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avengers-missing-turn-"));
    tempDirs.push(dir);
    const output = join(dir, "collection.jsonl");
    const first = fixtureTurn({ id: "turn-1", checks: [{ type: "exact-text", expected: "ok" }] });
    const second = fixtureTurn({ id: "turn-2", checks: [{ type: "exact-text", expected: "ok" }] });
    await collectAvengersOutcomes(fixtureDataset([first]), aliases(), config, async () => completion("ok"), output);

    expect(() => curateAvengersCollection(output, fixtureDataset([first, second]), aliases())).toThrow(
      "collection is missing example session-1/turn-2"
    );
  });

  it("rejects outcomes whose runtime does not match the frozen alias", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avengers-runtime-mismatch-"));
    tempDirs.push(dir);
    const output = join(dir, "collection.jsonl");
    const source = fixtureDataset([fixtureTurn({ checks: [{ type: "exact-text", expected: "ok" }] })]);
    await collectAvengersOutcomes(source, aliases(), config, async () => completion("ok"), output);
    const record = JSON.parse(readFileSync(output, "utf8"));
    record.outcomes[0].runtimeModelId = "provider/substituted";
    writeFileSync(output, `${JSON.stringify(record)}\n`);

    expect(() => curateAvengersCollection(output, source, aliases())).toThrow(
      "example session-1/turn-1 candidate paper/a used unexpected runtime provider/substituted"
    );
  });
});

describe("judgeLabeledOutputs", () => {
  it("accepts two to twenty-six blinded labels", async () => {
    const scores = await judgeLabeledOutputs(
      "id-1",
      "Score.",
      [
        { id: "one", output: { text: "a", toolCalls: [], terminalState: "completed" } },
        { id: "two", output: { text: "b", toolCalls: [], terminalState: "completed" } },
      ],
      config,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const request = JSON.parse(body.messages[1].content);
        return completion(JSON.stringify({ scores: Object.fromEntries(request.responses.map((item: any) => [item.label, 50])) }));
      }
    );
    expect(scores).toEqual({ one: 0.5, two: 0.5 });
  });
});
