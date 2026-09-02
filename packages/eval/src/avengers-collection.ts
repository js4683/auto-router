import { appendFileSync, chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ModelMap } from "@auto-router/router-core";
import { runChecks } from "./checks.js";
import { calculateCost, compositeQuality } from "./metrics.js";
import { judgeLabeledOutputs, requestCompletion, type JudgeClientConfig } from "./live.js";
import { redactContent } from "./recording.js";
import type { AvengersCorpusV1, AvengersCorpusExampleV1, AvengersOutcomeV1 } from "./avengers-corpus.js";
import type { EvalDatasetV1, EvalTurnV1, LiveOutput } from "./types.js";

export interface AvengersCollectionPlan {
  exampleCount: number;
  candidateCount: number;
  generationCalls: number;
  judgeCalls: number;
  totalCalls: number;
}

export type AvengersAliasMap = Map<string, string>;

const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export function parseAvengersAliases(raw: string): AvengersAliasMap {
  const aliases = new Map<string, string>();
  for (const item of raw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf("=");
    if (separator <= 0 || separator === item.length - 1) throw new Error(`malformed paper=runtime alias ${item}`);
    const paper = item.slice(0, separator);
    const runtime = item.slice(separator + 1);
    if (aliases.has(paper)) throw new Error(`duplicate paper model alias ${paper}`);
    aliases.set(paper, runtime);
  }
  if (aliases.size < 2 || aliases.size > 26) throw new Error("candidate list must contain between 2 and 26 aliases");
  return aliases;
}

export function planAvengersCollection(dataset: EvalDatasetV1, aliases: AvengersAliasMap): AvengersCollectionPlan {
  if (aliases.size < 2 || aliases.size > 26) throw new Error("candidate list must contain between 2 and 26 aliases");
  const exampleCount = dataset.sessions.reduce((total, session) => total + session.turns.length, 0);
  const candidateCount = aliases.size;
  const generationCalls = exampleCount * candidateCount;
  const judgeCalls = exampleCount;
  return { exampleCount, candidateCount, generationCalls, judgeCalls, totalCalls: generationCalls + judgeCalls };
}

function lastUserText(turn: EvalTurnV1): string {
  const messages = turn.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index].content;
    if (messages[index].role === "user" && typeof content === "string" && content.trim()) return content;
  }
  throw new Error(`turn ${turn.id} has no user text`);
}

function outputTruncated(output: LiveOutput): boolean {
  return output.terminalState === "incomplete";
}

async function collectTurn(
  sessionId: string,
  sequence: number,
  turn: EvalTurnV1,
  aliases: AvengersAliasMap,
  dataset: EvalDatasetV1,
  config: JudgeClientConfig,
  fetchImpl: typeof fetch
): Promise<Record<string, unknown>> {
  const papers = [...aliases.keys()].sort();
  const generations: Array<{ paper: string; runtime: string; output?: LiveOutput; error?: string }> = [];
  for (const paper of papers) {
    const runtime = aliases.get(paper)!;
    try {
      const output = await requestCompletion({ model: runtime, messages: turn.messages ?? [] }, config, fetchImpl);
      generations.push({ paper, runtime, output });
    } catch (error) {
      generations.push({ paper, runtime, error: error instanceof Error ? error.message : "generation failed" });
    }
  }

  const completed = generations.every((item) => item.output?.terminalState === "completed");
  let judged: Record<string, number> = {};
  if (completed && turn.judgeRubric) {
    judged = await judgeLabeledOutputs(
      `${sessionId}/${turn.id}`,
      turn.judgeRubric,
      generations.map((item) => ({ id: item.paper, output: item.output! })),
      config,
      fetchImpl
    );
  }

  const outcomes = generations.map((item) => {
    const output = item.output;
    const terminalState = output?.terminalState ?? "failed";
    const contentTruncated = output ? outputTruncated(output) : false;
    const deterministic = output ? runChecks(output, turn.checks ?? []) : null;
    const judge = judged[item.paper];
    const quality = terminalState === "completed" ? (judge === undefined ? deterministic ?? 0 : compositeQuality(deterministic, judge)) : 0;
    const usage = output?.usage;
    const price = dataset.prices[item.runtime];
    const costUsd = usage && price ? calculateCost(usage, price) : undefined;
    return {
      paperModelId: item.paper,
      runtimeModelId: item.runtime,
      terminalState,
      contentTruncated,
      quality,
      qualitySource: judge === undefined ? "deterministic" : deterministic === null ? "judge" : "composite",
      ...(usage ? { usage, usageSource: "provider" as const } : {}),
      ...(costUsd !== undefined ? { costUsd, costSource: "provider-usage" as const } : {}),
      ...(output ? { response: { text: output.text, toolCalls: output.toolCalls } } : { error: item.error }),
    };
  });

  return redactContent({
    id: `${sessionId}/${turn.id}`,
    sessionGroupId: sessionId,
    sequence,
    weight: turn.weight ?? 1,
    text: lastUserText(turn),
    taskType: turn.sessionState.userTag,
    sessionState: turn.sessionState,
    requiredCapabilities: turn.requiredCapabilities,
    outcomes,
  }) as Record<string, unknown>;
}

export async function collectAvengersOutcomes(
  dataset: EvalDatasetV1,
  aliases: AvengersAliasMap,
  config: JudgeClientConfig,
  fetchImpl: typeof fetch = fetch,
  outputPath?: string
): Promise<Record<string, unknown>[]> {
  planAvengersCollection(dataset, aliases);
  const records: Record<string, unknown>[] = [];
  for (const session of dataset.sessions) {
    for (const [sequence, turn] of session.turns.entries()) {
      const record = await collectTurn(session.id, sequence, turn, aliases, dataset, config, fetchImpl);
      const serialized = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error(`collection record exceeds ${MAX_RECORD_BYTES} bytes`);
      records.push(record);
      if (outputPath) {
        appendFileSync(outputPath, serialized, { mode: 0o600 });
        chmodSync(outputPath, 0o600);
      }
    }
  }
  return records;
}

function parseCollectionLine(raw: string, index: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`collection line ${index} is not JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`collection line ${index} must be an object`);
  return value as Record<string, unknown>;
}

export function curateAvengersCollection(inputPath: string, baseDataset: EvalDatasetV1, aliases: AvengersAliasMap): AvengersCorpusV1 {
  if (aliases.size < 2 || aliases.size > 26) throw new Error("candidate list must contain between 2 and 26 aliases");
  const lines = readFileSync(inputPath, "utf8").split("\n").filter((line) => line.trim());
  const examples: AvengersCorpusExampleV1[] = [];
  const seenIds = new Set<string>();
  const byGroup = new Map<string, number[]>();

  for (const [index, line] of lines.entries()) {
    const record = parseCollectionLine(line, index + 1);
    const id = String(record.id ?? "");
    if (!id) throw new Error(`collection line ${index + 1} is missing id`);
    if (seenIds.has(id)) throw new Error(`duplicate example id ${id}`);
    seenIds.add(id);
    const sessionGroupId = String(record.sessionGroupId ?? "");
    const sequence = Number(record.sequence);
    const group = byGroup.get(sessionGroupId) ?? [];
    group.push(sequence);
    byGroup.set(sessionGroupId, group);
    const outcomes = Array.isArray(record.outcomes) ? record.outcomes : [];
    const seenModels = new Set<string>();
    const curatedOutcomes: AvengersOutcomeV1[] = outcomes.map((raw) => {
      const outcome = raw as Record<string, unknown>;
      const paperModelId = String(outcome.paperModelId ?? "");
      if (seenModels.has(paperModelId)) throw new Error(`duplicate model outcome ${paperModelId} in ${id}`);
      seenModels.add(paperModelId);
      const { response: _response, error: _error, ...rest } = outcome;
      return rest as unknown as AvengersOutcomeV1;
    });
    for (const paper of aliases.keys()) {
      if (!seenModels.has(paper)) throw new Error(`example ${id} is missing candidate ${paper}`);
    }
    examples.push({
      id,
      sessionGroupId,
      sequence,
      weight: Number(record.weight ?? 1),
      text: String(record.text ?? ""),
      ...(typeof record.taskType === "string" ? { taskType: record.taskType as AvengersCorpusExampleV1["taskType"] } : {}),
      sessionState: record.sessionState as AvengersCorpusExampleV1["sessionState"],
      requiredCapabilities: (record.requiredCapabilities as string[]) ?? [],
      outcomes: curatedOutcomes,
    });
  }

  for (const [group, sequences] of byGroup) {
    const sorted = [...sequences].sort((a, b) => a - b);
    if (sorted[0] !== 0) throw new Error(`session ${group} does not start at sequence 0`);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i) throw new Error(`session ${group} has a sequence gap`);
    }
  }

  const modelMap: ModelMap = {};
  for (const [paper, runtime] of aliases) modelMap[paper] = [{ runtimeId: runtime, source: "hand" }];

  return {
    schemaVersion: 1,
    id: `${baseDataset.id}-avengers`,
    synthetic: false,
    candidatePaperModelIds: [...aliases.keys()].sort(),
    routingSnapshot: {
      catalog: baseDataset.catalog,
      config: baseDataset.config,
      prices: baseDataset.prices,
      capabilities: baseDataset.capabilities ?? {},
      modelMap,
    },
    examples,
  };
}

export function writeCuratedCorpus(path: string, corpus: AvengersCorpusV1): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(corpus, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}
