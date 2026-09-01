import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replayDataset } from "../src/replay.js";
import { buildReplayReport, renderMarkdown, stableJson } from "../src/report.js";
import { readDataset } from "../src/schema.js";
import { fixtureDataset, fixtureTurn } from "./fixtures.js";

describe("offline reports", () => {
  it("matches the checked-in synthetic golden reports", () => {
    const dataset = readDataset(fileURLToPath(new URL("../fixtures/phase-3-smoke.v1.json", import.meta.url)));
    const report = buildReplayReport(dataset, replayDataset(dataset));

    expect(stableJson(report)).toBe(readFileSync(new URL("../fixtures/phase-3-smoke.report.v1.json", import.meta.url), "utf8"));
    expect(renderMarkdown(report)).toBe(readFileSync(new URL("../fixtures/phase-3-smoke.report.v1.md", import.meta.url), "utf8"));
  });

  it("renders byte-identical JSON without raw messages", () => {
    const dataset = fixtureDataset([
      fixtureTurn({ messages: [{ role: "user", content: "synthetic secret prompt" }] }),
    ]);
    const first = buildReplayReport(dataset, replayDataset(dataset));
    const second = buildReplayReport(dataset, replayDataset(dataset));

    expect(stableJson(first)).toBe(stableJson(second));
    expect(stableJson(first)).not.toContain("synthetic secret prompt");
    expect(first.mode).toBe("offline");
    expect(first.gates.liveQuality.passed).toBe(false);
    expect(first.gates.liveQuality.reason).toContain("live quality is unproven");
  });

  it("summarizes all strategies and escapes untrusted Markdown", () => {
    const dataset = fixtureDataset();
    const replay = replayDataset(dataset);
    replay.strategies.router.turns[0].reason = "<script>|line\nbreak";
    const markdown = renderMarkdown(buildReplayReport(dataset, replay));

    expect(markdown).toContain("router");
    expect(markdown).toContain("always-frontier");
    expect(markdown).toContain("always-cheap");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("|line\n");
    expect(markdown).toContain("&lt;script&gt;");
  });

  it("reports provider-observed cost separately from estimated replay cost", () => {
    const providerTurn = fixtureTurn({
      observed: {
        modelId: "provider/cheap",
        usageSource: "provider",
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      },
    });
    const providerDataset = fixtureDataset([providerTurn]);
    const providerReport = buildReplayReport(providerDataset, replayDataset(providerDataset));

    expect(providerReport.providerObserved).toEqual({ sampleSize: 1, totalCostUsd: 0.0012, incompleteReasons: [] });

    const estimatedTurn = fixtureTurn({ observed: { ...providerTurn.observed!, usageSource: "estimated" } });
    const estimatedDataset = fixtureDataset([estimatedTurn]);
    const estimatedReport = buildReplayReport(estimatedDataset, replayDataset(estimatedDataset));
    expect(estimatedReport.providerObserved).toMatchObject({ sampleSize: 0, totalCostUsd: null });
  });

  it("fails the completeness gate for incomplete or truncated replay turns", () => {
    const dataset = fixtureDataset([fixtureTurn({ terminalState: "failed", contentTruncated: true })]);
    const report = buildReplayReport(dataset, replayDataset(dataset));

    expect(report.gates.completeness).toMatchObject({ passed: false });
    expect(report.gates.estimatedCost.passed).toBe(false);
    expect(report.strategies.router.turns[0]).toMatchObject({ terminalState: "failed", contentTruncated: true });
  });
});
