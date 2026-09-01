import { describe, expect, it } from "vitest";
import { planLiveEvaluation, runLiveEvaluation, type JudgeClientConfig } from "../src/live.js";
import { replayDataset } from "../src/replay.js";
import { buildLiveReport, renderMarkdown, stableJson } from "../src/report.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

function response(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    { status, headers: { "content-type": "application/json" } }
  );
}

function liveFixture() {
  const dataset = fixtureDataset([
    fixtureTurn({
      checks: [{ type: "recorded-outcome", passed: true }],
      judgeRubric: "Score correctness.",
      messages: [{ role: "user", content: "Evaluate the fixture" }],
      weight: 2,
    }),
  ]);
  dataset.liveModelAliases = {
    "provider/cheap": "live/cheap",
    "provider/frontier": "live/frontier",
  };
  return dataset;
}

const config: JudgeClientConfig = {
  baseUrl: "https://example.com/v1",
  apiKey: "secret",
  timeoutMs: 1000,
  maxOutputTokens: 64,
  judgeModel: "live/judge",
};

describe("live evaluation orchestration", () => {
  it("runs three generations and one blinded judge call per complete case", async () => {
    const dataset = liveFixture();
    const replay = replayDataset(dataset);
    const calls: any[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (body.model !== "live/judge") return response(`${body.model}-answer`);
      const request = JSON.parse(body.messages[1].content);
      const scores = Object.fromEntries(
        request.responses.map((item: any) => [item.label, item.response.text.includes("frontier") ? 95 : 80])
      );
      return response(JSON.stringify({ scores }));
    };

    const result = await runLiveEvaluation(dataset, replay, config, fetchImpl);

    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.model === "live/judge")).toHaveLength(1);
    expect(result.plan).toMatchObject({ caseCount: 1, generationCalls: 3, judgeCalls: 1 });
    expect(result.cases[0]).toMatchObject({ complete: true, weight: 2 });
    expect(result.cases[0].scores?.router).toMatchObject({ deterministic: null, judge: 0.8, composite: 0.8 });
    expect(result.cases[0].scores?.["always-frontier"]).toMatchObject({ deterministic: null, judge: 0.95, composite: 0.95 });
    expect(result.cases[0].observedCostUsd).toEqual({ router: 0.00014, "always-frontier": 0.0016, "always-cheap": 0.00014 });
    const judgeCall = calls.find((call) => call.model === "live/judge");
    const judgeRequest = JSON.parse(judgeCall.messages[1].content);
    expect(judgeRequest.responses.every((item: any) => Object.keys(item.response).sort().join(",") === "terminalState,text")).toBe(true);
    expect(result.qualityGate).toMatchObject({ passed: false, sampleSize: 1, reason: "requires at least 30 complete live cases" });
    const report = buildLiveReport(dataset, replay, result);
    expect(report.mode).toBe("live");
    expect(report.gates.liveQuality).toMatchObject({ passed: false, reason: "requires at least 30 complete live cases" });
    expect(report.strategies.router.metrics).toMatchObject({ isEstimated: true, totalCostUsd: 0.0012 });
    expect(report.strategies.router.live).toMatchObject({
      sampleSize: 1,
      quality: { deterministic: null, judge: 0.8, composite: 0.8 },
      providerObserved: {
        usageSource: "provider",
        costSource: "provider-usage-priced-from-dataset",
        sampleSize: 1,
        totalUsage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
        totalCostUsd: 0.00014,
        incompleteReasons: [],
      },
    });
    expect(renderMarkdown(report)).toContain("Provider-observed live metrics");
    expect(renderMarkdown(report)).toContain("0.000140");
    expect(stableJson(report)).not.toContain("live/cheap-answer");
  });

  it("keeps a live strategy aggregate incomplete when provider usage is absent", async () => {
    const dataset = liveFixture();
    const replay = replayDataset(dataset);
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === "live/judge") {
        const request = JSON.parse(body.messages[1].content);
        const scores = Object.fromEntries(request.responses.map((item: any) => [item.label, 80]));
        return response(JSON.stringify({ scores }));
      }
      if (body.model === "live/cheap") {
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "cheap" } }] }), { status: 200 });
      }
      return response(`${body.model}-answer`);
    };

    const result = await runLiveEvaluation(dataset, replay, config, fetchImpl);
    const report = buildLiveReport(dataset, replay, result);

    expect(report.strategies.router.live?.providerObserved).toMatchObject({
      usageSource: "provider",
      sampleSize: 0,
      totalUsage: null,
      totalCostUsd: null,
    });
    expect(report.strategies.router.live?.providerObserved.incompleteReasons).toContain("missing provider usage for router in case session-1\u0000turn-1");
    expect(report.strategies["always-frontier"].live?.providerObserved.totalCostUsd).toBe(0.0016);
  });

  it("preserves failed generations and skips judging incomplete cases", async () => {
    const dataset = liveFixture();
    const replay = replayDataset(dataset);
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      if (body.model === "live/frontier") return new Response("unavailable", { status: 503 });
      return response(`${body.model}-answer`);
    };

    const result = await runLiveEvaluation(dataset, replay, config, fetchImpl);

    expect(calls).toBe(3);
    expect(result.cases[0].complete).toBe(false);
    expect(result.cases[0].errors.join("\n")).toContain("always-frontier: provider returned HTTP 503");
    expect(result.qualityGate.sampleSize).toBe(0);
  });

  it("validates aliases and live inputs before making a call plan", () => {
    const dataset = liveFixture();
    delete dataset.liveModelAliases!["provider/frontier"];
    expect(() => planLiveEvaluation(dataset, replayDataset(dataset))).toThrow("missing live model alias for provider/frontier");

    const missingMessages = liveFixture();
    delete missingMessages.sessions[0].turns[0].messages;
    expect(() => planLiveEvaluation(missingMessages, replayDataset(missingMessages))).toThrow("turn turn-1 has no live messages");
  });
});
