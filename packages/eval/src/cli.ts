import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { curateRecording } from "./curate.js";
import { planLiveEvaluation, runLiveEvaluation, type JudgeClientConfig } from "./live.js";
import { replayDataset } from "./replay.js";
import { buildLiveReport, buildReplayReport, renderMarkdown, stableJson } from "./report.js";
import { readDataset } from "./schema.js";
import type { EvalReportV1 } from "./types.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface ParsedArgs {
  command: string;
  values: Record<string, string>;
  flags: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0];
  if (!command) throw new Error("command is required");
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument ${flag}`);
    if (values[flag] !== undefined || flags.has(flag)) throw new Error(`duplicate flag ${flag}`);
    if (flag === "--confirm-live") {
      flags.add(flag);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values[flag] = value;
    index += 1;
  }
  return { command, values, flags };
}

function requireValue(parsed: ParsedArgs, flag: string): string {
  const value = parsed.values[flag];
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function writeReport(outputPath: string, report: EvalReportV1, io: CliIo): void {
  writeFileSync(`${outputPath}.json`, stableJson(report), { mode: 0o600 });
  writeFileSync(`${outputPath}.md`, renderMarkdown(report), { mode: 0o600 });
  io.stdout(`wrote ${outputPath}.json`);
  io.stdout(`wrote ${outputPath}.md`);
}

function assertComplete(report: EvalReportV1): void {
  const incomplete = Object.values(report.strategies).flatMap((strategy) => strategy.metrics.incompleteReasons);
  if (incomplete.length) throw new Error([...new Set(incomplete)].join("; "));
}

function runReplay(parsed: ParsedArgs, io: CliIo): number {
  const datasetPath = requireValue(parsed, "--dataset");
  const outputPath = parsed.values["--output"] ?? `${datasetPath}.eval-report.local`;
  const dataset = readDataset(datasetPath);
  const report = buildReplayReport(dataset, replayDataset(dataset));
  try {
    assertComplete(report);
  } catch (error) {
    if (!report.gates.completeness.passed) writeReport(outputPath, report, io);
    throw error;
  }
  writeReport(outputPath, report, io);
  return 0;
}

function requiredEnv(io: CliIo, name: string): string {
  const value = io.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveEnv(io: CliIo, name: string, fallback: number): number {
  const raw = io.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

async function runLive(parsed: ParsedArgs, io: CliIo): Promise<number> {
  if (!parsed.flags.has("--confirm-live")) throw new Error("live evaluation requires --confirm-live");
  const datasetPath = requireValue(parsed, "--dataset");
  const outputPath = parsed.values["--output"] ?? `${datasetPath}.live.eval-report.local`;
  const dataset = readDataset(datasetPath);
  const replay = replayDataset(dataset);
  const offline = buildReplayReport(dataset, replay);
  assertComplete(offline);
  const config: JudgeClientConfig = {
    baseUrl: requiredEnv(io, "AUTO_ROUTER_EVAL_BASE_URL"),
    apiKey: requiredEnv(io, "AUTO_ROUTER_EVAL_API_KEY"),
    judgeModel: requiredEnv(io, "AUTO_ROUTER_EVAL_JUDGE_MODEL"),
    timeoutMs: positiveEnv(io, "AUTO_ROUTER_EVAL_TIMEOUT_MS", 60_000),
    maxOutputTokens: positiveEnv(io, "AUTO_ROUTER_EVAL_MAX_OUTPUT_TOKENS", 1024),
  };
  const plan = planLiveEvaluation(dataset, replay);
  io.stdout(`planned calls: ${plan.generationCalls} generation, ${plan.judgeCalls} judge`);
  const live = await runLiveEvaluation(dataset, replay, config, io.fetch ?? fetch);
  writeReport(outputPath, buildLiveReport(dataset, replay, live), io);
  const incompleteCases = live.cases.filter((item) => !item.complete).length;
  if (incompleteCases) {
    io.stderr(`live evaluation has ${incompleteCases} incomplete case${incompleteCases === 1 ? "" : "s"}`);
    return 1;
  }
  return 0;
}

function runCurate(parsed: ParsedArgs, io: CliIo): number {
  const inputPath = requireValue(parsed, "--input");
  const basePath = requireValue(parsed, "--base-dataset");
  const outputPath = requireValue(parsed, "--output");
  const dataset = curateRecording(inputPath, readDataset(basePath));
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(dataset, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
  io.stderr("automatic redaction is incomplete; manual review is required before commit");
  io.stdout(`wrote ${outputPath}`);
  return 0;
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.command === "replay") return runReplay(parsed, io);
    if (parsed.command === "live") return await runLive(parsed, io);
    if (parsed.command === "curate") return runCurate(parsed, io);
    throw new Error(`unknown command ${parsed.command}`);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "eval command failed");
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void runCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
  }).then((status) => {
    process.exitCode = status;
  });
}
