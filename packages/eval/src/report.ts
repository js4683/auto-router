import { calculateCost, calculateStrategyMetrics, qualityRetained, weightedMean } from "./metrics.js";
import type {
  EvalDatasetV1,
  EvalReportV1,
  EvalUsage,
  LiveEvalResult,
  LiveStrategyMetrics,
  ProviderObservedMetrics,
  ReplayResult,
  StrategyName,
  StrategyReport,
} from "./types.js";

const STRATEGIES = ["router", "always-frontier", "always-cheap"] as const;

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

function replayCompleteness(replay: ReplayResult): EvalReportV1["gates"]["completeness"] {
  const reasons = [
    ...new Set(
      Object.values(replay.strategies).flatMap((strategy) =>
        strategy.turns.flatMap((turn) => [
          ...(turn.terminalState === "completed" ? [] : [`recorded turn ${turn.sessionId}/${turn.turnId} has terminal state ${turn.terminalState}`]),
          ...(turn.contentTruncated ? [`recorded turn ${turn.sessionId}/${turn.turnId} has truncated content`] : []),
        ])
      )
    ),
  ];
  return { passed: reasons.length === 0, reason: reasons.length ? reasons.join("; ") : "all replay turns are complete" };
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
  const completeness = replayCompleteness(replay);
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
      completeness,
      liveQuality: { passed: false, reason: "live quality is unproven by offline replay" },
      estimatedCost: {
        passed: completeness.passed && saved !== null && saved >= 0.5,
        reason: !completeness.passed
          ? "replay completeness is incomplete"
          : saved === null
            ? "estimated cost is incomplete"
            : `router cost savings ${(saved * 100).toFixed(2)}%`,
      },
    },
  };
}

function emptyUsage(): EvalUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
}

function addUsage(total: EvalUsage, usage: EvalUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadInputTokens += usage.cacheReadInputTokens;
  total.cacheWriteInputTokens += usage.cacheWriteInputTokens;
}

function providerObservedLiveMetrics(live: LiveEvalResult, name: StrategyName): ProviderObservedMetrics {
  const totalUsage = emptyUsage();
  let sampleSize = 0;
  let totalCostUsd = 0;
  const incompleteReasons: string[] = [];

  for (const item of live.cases) {
    if (!item.complete) {
      incompleteReasons.push(`incomplete live case ${item.id}`);
      continue;
    }
    const usage = item.usage?.[name];
    if (!usage) {
      incompleteReasons.push(`missing provider usage for ${name} in case ${item.id}`);
      continue;
    }
    sampleSize += 1;
    addUsage(totalUsage, usage);
    const cost = item.observedCostUsd?.[name];
    if (cost === undefined) incompleteReasons.push(`missing provider cost for ${name} in case ${item.id}`);
    else totalCostUsd += cost;
  }

  if (!sampleSize) incompleteReasons.push(`no provider-observed usage for ${name}`);
  return {
    usageSource: "provider",
    costSource: "provider-usage-priced-from-dataset",
    sampleSize,
    totalUsage: sampleSize ? totalUsage : null,
    totalCostUsd: incompleteReasons.length ? null : totalCostUsd,
    incompleteReasons,
  };
}

function liveQuality(live: LiveEvalResult, name: StrategyName): LiveStrategyMetrics["quality"] {
  const deterministic: Array<{ score: number; weight: number }> = [];
  const judge: Array<{ score: number; weight: number }> = [];
  const composite: Array<{ score: number; weight: number }> = [];
  for (const item of live.cases) {
    const scores = item.complete ? item.scores?.[name] : undefined;
    if (!scores) continue;
    const weight = item.weight;
    if (scores.deterministic !== null) deterministic.push({ score: scores.deterministic, weight });
    judge.push({ score: scores.judge, weight });
    composite.push({ score: scores.composite, weight });
  }
  return { deterministic: weightedMean(deterministic), judge: weightedMean(judge), composite: weightedMean(composite) };
}

function liveStrategyMetrics(live: LiveEvalResult, name: StrategyName): LiveStrategyMetrics {
  return {
    sampleSize: live.cases.filter((item) => item.complete && item.scores?.[name]).length,
    quality: liveQuality(live, name),
    providerObserved: providerObservedLiveMetrics(live, name),
  };
}

export function buildLiveReport(dataset: EvalDatasetV1, replay: ReplayResult, live: LiveEvalResult): EvalReportV1 {
  const report = buildReplayReport(dataset, replay);
  const strategies = Object.fromEntries(
    STRATEGIES.map((name) => [name, { ...report.strategies[name], live: liveStrategyMetrics(live, name) }])
  ) as Record<StrategyName, StrategyReport>;
  return {
    ...report,
    mode: "live",
    sampleSize: live.cases.length,
    strategies,
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
  for (const name of STRATEGIES) {
    const metrics = report.strategies[name].metrics;
    lines.push(`| ${name} | ${decimal(metrics.totalCostUsd)} | ${decimal(metrics.qualityProxy)} | ${metrics.switchCount} | ${metrics.cacheMissTokens} |`);
  }
  if (report.mode === "live") {
    lines.push(
      "",
      "## Provider-observed live metrics",
      "",
      "| Strategy | Complete cases | Deterministic quality | Judge quality | Composite quality | Provider cases | Input tokens | Output tokens | Cache read | Cache write | Provider cost USD | Usage source | Cost source |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|"
    );
    for (const name of STRATEGIES) {
      const live = report.strategies[name].live;
      if (!live) continue;
      const provider = live.providerObserved;
      const usage = provider.totalUsage;
      lines.push(
        `| ${name} | ${live.sampleSize} | ${decimal(live.quality.deterministic)} | ${decimal(live.quality.judge)} | ${decimal(live.quality.composite)} | ${provider.sampleSize} | ${usage?.inputTokens ?? "incomplete"} | ${usage?.outputTokens ?? "incomplete"} | ${usage?.cacheReadInputTokens ?? "incomplete"} | ${usage?.cacheWriteInputTokens ?? "incomplete"} | ${decimal(provider.totalCostUsd)} | ${provider.usageSource} | ${provider.costSource} |`
      );
    }
  }
  lines.push("", "## Selections", "", "| Strategy | Session | Turn | Model | Via | Reason |", "|---|---|---|---|---|---|");
  for (const name of STRATEGIES) {
    for (const turn of report.strategies[name].turns) {
      lines.push(
        `| ${name} | ${markdownCell(turn.sessionId)} | ${markdownCell(turn.turnId)} | ${markdownCell(turn.modelId)} | ${markdownCell(turn.via)} | ${markdownCell(turn.reason)} |`
      );
    }
  }
  lines.push(
    "",
    "## Gates",
    "",
    `- Completeness: ${report.gates.completeness.passed ? "passed" : "not passed"} (${markdownCell(report.gates.completeness.reason)})`,
    `- Live quality: ${report.gates.liveQuality.passed ? "passed" : "not passed"} (${markdownCell(report.gates.liveQuality.reason)})`
  );
  lines.push(`- Estimated cost: ${report.gates.estimatedCost.passed ? "passed" : "not passed"} (${markdownCell(report.gates.estimatedCost.reason)})`, "");
  return lines.join("\n");
}
