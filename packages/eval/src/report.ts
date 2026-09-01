import { calculateCost, calculateStrategyMetrics, qualityRetained } from "./metrics.js";
import type { EvalDatasetV1, EvalReportV1, LiveEvalResult, ReplayResult, StrategyName, StrategyReport } from "./types.js";

function strategyReport(dataset: EvalDatasetV1, replay: ReplayResult, name: StrategyName): StrategyReport {
  const strategy = replay.strategies[name];
  return {
    metrics: calculateStrategyMetrics(strategy, dataset.prices),
    turns: strategy.turns.map(({ usage: _usage, ...turn }) => turn),
  };
}

function costSaved(routerCost: number | null, frontierCost: number | null): number | null {
  if (routerCost === null || frontierCost === null || frontierCost === 0) return null;
  return 1 - routerCost / frontierCost;
}

function providerObserved(dataset: EvalDatasetV1): EvalReportV1["providerObserved"] {
  let sampleSize = 0;
  let totalCostUsd = 0;
  const incompleteReasons: string[] = [];
  for (const turn of dataset.sessions.flatMap((session) => session.turns)) {
    if (!turn.observed || turn.observed.usageSource !== "provider") continue;
    sampleSize += 1;
    const price = dataset.prices[turn.observed.modelId];
    if (!price) incompleteReasons.push(`missing price for observed model ${turn.observed.modelId}`);
    else totalCostUsd += calculateCost(turn.observed.usage, price);
  }
  if (!sampleSize) incompleteReasons.push("no provider-observed usage");
  return { sampleSize, totalCostUsd: incompleteReasons.length ? null : totalCostUsd, incompleteReasons };
}

export function buildReplayReport(dataset: EvalDatasetV1, replay: ReplayResult): EvalReportV1 {
  const strategies = {
    router: strategyReport(dataset, replay, "router"),
    "always-frontier": strategyReport(dataset, replay, "always-frontier"),
    "always-cheap": strategyReport(dataset, replay, "always-cheap"),
  };
  const saved = costSaved(strategies.router.metrics.totalCostUsd, strategies["always-frontier"].metrics.totalCostUsd);
  const retained =
    strategies.router.metrics.qualityProxy === null || strategies["always-frontier"].metrics.qualityProxy === null
      ? null
      : qualityRetained(strategies.router.metrics.qualityProxy, strategies["always-frontier"].metrics.qualityProxy);
  return {
    schemaVersion: 1,
    datasetId: dataset.id,
    mode: "offline",
    sampleSize: dataset.sessions.reduce((total, session) => total + session.turns.length, 0),
    providerObserved: providerObserved(dataset),
    strategies,
    comparisons: {
      routerCostSavedVsFrontier: saved,
      routerQualityProxyRetainedVsFrontier: retained,
    },
    gates: {
      liveQuality: { passed: false, reason: "live quality is unproven by offline replay" },
      estimatedCost: {
        passed: saved !== null && saved >= 0.5,
        reason: saved === null ? "estimated cost is incomplete" : `router cost savings ${(saved * 100).toFixed(2)}%`,
      },
    },
  };
}

export function buildLiveReport(dataset: EvalDatasetV1, replay: ReplayResult, live: LiveEvalResult): EvalReportV1 {
  const report = buildReplayReport(dataset, replay);
  return {
    ...report,
    mode: "live",
    sampleSize: live.cases.length,
    live,
    gates: {
      ...report.gates,
      liveQuality: { passed: live.qualityGate.passed, reason: live.qualityGate.reason },
    },
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortValue(entry)]));
}

export function stableJson(report: EvalReportV1): string {
  return `${JSON.stringify(sortValue(report), null, 2)}\n`;
}

function markdownCell(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>");
}

function decimal(value: number | null): string {
  return value === null ? "incomplete" : value.toFixed(6);
}

export function renderMarkdown(report: EvalReportV1): string {
  const lines = [
    `# Eval Report: ${markdownCell(report.datasetId)}`,
    "",
    `Mode: ${report.mode}. Cases: ${report.sampleSize}.`,
    `Provider-observed cost: ${decimal(report.providerObserved.totalCostUsd)} (${report.providerObserved.sampleSize} turns).`,
    "",
    "| Strategy | Estimated cost USD | Quality proxy | Switches | Cache misses |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const name of ["router", "always-frontier", "always-cheap"] as const) {
    const metrics = report.strategies[name].metrics;
    lines.push(`| ${name} | ${decimal(metrics.totalCostUsd)} | ${decimal(metrics.qualityProxy)} | ${metrics.switchCount} | ${metrics.cacheMissTokens} |`);
  }
  lines.push("", "## Selections", "", "| Strategy | Session | Turn | Model | Via | Reason |", "|---|---|---|---|---|---|");
  for (const name of ["router", "always-frontier", "always-cheap"] as const) {
    for (const turn of report.strategies[name].turns) {
      lines.push(
        `| ${name} | ${markdownCell(turn.sessionId)} | ${markdownCell(turn.turnId)} | ${markdownCell(turn.modelId)} | ${markdownCell(turn.via)} | ${markdownCell(turn.reason)} |`
      );
    }
  }
  lines.push("", "## Gates", "", `- Live quality: ${report.gates.liveQuality.passed ? "passed" : "not passed"} (${markdownCell(report.gates.liveQuality.reason)})`);
  lines.push(`- Estimated cost: ${report.gates.estimatedCost.passed ? "passed" : "not passed"} (${markdownCell(report.gates.estimatedCost.reason)})`, "");
  return lines.join("\n");
}
