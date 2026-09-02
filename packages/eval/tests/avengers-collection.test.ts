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

  it("rejects candidate lists outside 2 through 26", () => {
    expect(() => parseAvengersAliases("only=one")).toThrow(/2 and 26/);
  });
});

describe("collectAvengersOutcomes", () => {
  it("does not retry a timed-out candidate call", async () => {
    let calls = 0;
    const oneTurn = fixtureDataset([fixtureTurn({ messages: [{ role: "user", content: "timeout" }] })]);
    await collectAvengersOutcomes(oneTurn, aliases(), config, async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
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
