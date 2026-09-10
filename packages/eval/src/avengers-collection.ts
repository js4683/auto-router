import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ModelMap } from "@auto-router/router-core";
import { runChecks } from "./checks.js";
import { calculateCost, compositeQuality } from "./metrics.js";
import { judgeLabeledOutputsDetailed, liveRequestFailure, requestCompletion, type JudgeClientConfig, type JudgeResult } from "./live.js";
import { redactContent } from "./recording.js";
import { createEvalProvenance, sourceManifestDigest, validateSourceManifest, type EvalSourceManifest } from "./provenance.js";
import { validateCostLedger, type AvengersCorpusV1, type AvengersCorpusExampleV1, type AvengersOutcomeV1 } from "./avengers-corpus.js";
import type { EvalCostLedger, EvalDatasetV1, EvalTurnV1, EvalUsage, LiveOutput } from "./types.js";

export interface AvengersCollectionPlan {
  exampleCount: number;
  candidateCount: number;
  generationCalls: number;
  judgeCalls: number;
  totalCalls: number;
}

export type AvengersAliasMap = Map<string, string>;

const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export function readAvengersSourceManifest(path: string): EvalSourceManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`source manifest is not valid JSON: ${path}`, { cause: error });
  }
  return validateSourceManifest(value);
}

function localSyntheticManifest(dataset: EvalDatasetV1, aliases: AvengersAliasMap): EvalSourceManifest {
  return {
    schemaVersion: 1,
    datasetId: dataset.id,
    collectionOrigin: "synthetic-fixture",
    records: dataset.sessions.flatMap((session) => session.turns.map((turn, sequence) => ({
      id: `${session.id}/${turn.id}`,
      sessionGroupId: session.sessionGroupId ?? session.id,
      sequence,
      candidatePaperModelIds: [...aliases.keys()].sort(),
    }))),
  };
}

function validateManifestCoverage(manifest: EvalSourceManifest, dataset: EvalDatasetV1, aliases: AvengersAliasMap): void {
  if (manifest.datasetId !== dataset.id) throw new Error("source manifest dataset ID does not match dataset");
  const expected = new Map(dataset.sessions.flatMap((session) => session.turns.map((turn, sequence) => [
    `${session.id}/${turn.id}`,
    { sessionGroupId: session.sessionGroupId ?? session.id, sequence },
  ])));
  if (manifest.records.length !== expected.size) throw new Error("source manifest record count does not match dataset");
  const candidates = [...aliases.keys()].sort();
  const seen = new Set<string>();
  for (const record of manifest.records) {
    const source = expected.get(record.id);
    if (!source || seen.has(record.id)) throw new Error(`source manifest contains an unknown or duplicate record ${record.id}`);
    seen.add(record.id);
    if (record.sessionGroupId !== source.sessionGroupId || record.sequence !== source.sequence) {
      throw new Error(`source manifest record ${record.id} does not match dataset sequence`);
    }
    if (JSON.stringify(record.candidatePaperModelIds) !== JSON.stringify(candidates)) {
      throw new Error(`source manifest record ${record.id} candidates do not match the requested aliases`);
    }
  }
}

class CollectionTurnError extends Error {
  constructor(message: string, readonly record: Record<string, unknown>) {
    super(message);
  }
}

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
  const turns = dataset.sessions.flatMap((session) => session.turns);
  for (const turn of turns) {
    lastUserText(turn);
    if (!turn.judgeRubric?.trim() && !usableDeterministicChecks(turn).length) {
      throw new Error(`turn ${turn.id} has no quality signal`);
    }
  }
  const exampleCount = turns.length;
  const candidateCount = aliases.size;
  const generationCalls = exampleCount * candidateCount;
  const judgeCalls = turns.filter((turn) => Boolean(turn.judgeRubric?.trim())).length;
  return { exampleCount, candidateCount, generationCalls, judgeCalls, totalCalls: generationCalls + judgeCalls };
}

function usableDeterministicChecks(turn: EvalTurnV1) {
  return (turn.checks ?? []).filter((check) => check.type !== "recorded-outcome");
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

function emptyUsage(): EvalUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
}

function addUsage(target: EvalUsage, source: EvalUsage | undefined): void {
  if (!source) return;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
}

async function collectTurn(
  sessionId: string,
  sessionGroupId: string,
  sequence: number,
  turn: EvalTurnV1,
  aliases: AvengersAliasMap,
  dataset: EvalDatasetV1,
  config: JudgeClientConfig,
  fetchImpl: typeof fetch
): Promise<Record<string, unknown>> {
  const papers = [...aliases.keys()].sort();
  const generations: Array<{ paper: string; runtime: string; output?: LiveOutput; error?: string; failure?: ReturnType<typeof liveRequestFailure> }> = [];
  for (const paper of papers) {
    const runtime = aliases.get(paper)!;
    try {
      const output = await requestCompletion({ model: runtime, messages: turn.messages ?? [] }, config, fetchImpl);
      const identityError = output.runtimeModelId && output.runtimeModelId !== runtime
        ? `runtime identity mismatch: requested ${runtime}, provider returned ${output.runtimeModelId}`
        : undefined;
      generations.push({
        paper,
        runtime,
        output,
        ...(identityError
          ? { error: identityError, failure: { retries: output.retries ?? [], usage: output.usage } }
          : {}),
      });
    } catch (error) {
      generations.push({
        paper,
        runtime,
        error: error instanceof Error ? error.message : "generation failed",
        failure: liveRequestFailure(error),
      });
    }
  }

  const completed = generations.every((item) => item.output?.terminalState === "completed");
  let judged: Record<string, number> = {};
  let judgeResult: JudgeResult | undefined;
  let judgeAttempted = false;
  let judgeFailure: ReturnType<typeof liveRequestFailure> = { retries: [] };
  const generationErrors = generations.filter((item) => item.error);
  let collectionError = generationErrors.length
    ? `generation failed: ${generationErrors.map((item) => `${item.paper}: ${item.error}`).join("; ")}`
    : undefined;
  if (!collectionError && completed && turn.judgeRubric) {
    judgeAttempted = true;
    try {
      judgeResult = await judgeLabeledOutputsDetailed(
        `${sessionId}/${turn.id}`,
        turn.judgeRubric,
        generations.map((item) => ({ id: item.paper, output: item.output! })),
        config,
        fetchImpl
      );
      judged = judgeResult.scores;
    } catch (error) {
      judgeFailure = liveRequestFailure(error);
      const message = error instanceof Error ? error.message : "judge request failed";
      collectionError = `judge failed: ${message}`;
    }
  }

  const outcomes = generations.map((item) => {
    const output = item.output;
    const terminalState = output?.terminalState ?? "failed";
    const contentTruncated = output ? outputTruncated(output) : false;
    const deterministic = output ? runChecks(output, usableDeterministicChecks(turn)) : null;
    const judge = judged[item.paper];
    const unjudged = terminalState === "completed" && Boolean(turn.judgeRubric?.trim()) && judge === undefined && deterministic === null;
    const quality = terminalState === "completed" ? (judge === undefined ? deterministic ?? 0 : compositeQuality(deterministic, judge)) : 0;
    const usage = output?.usage;
    const price = dataset.prices[item.runtime];
    const costUsd = usage && price ? calculateCost(usage, price) : undefined;
    return {
      paperModelId: item.paper,
      runtimeModelId: output?.runtimeModelId ?? item.runtime,
      terminalState,
      contentTruncated,
      quality,
      qualitySource: unjudged ? "unjudged" : judge === undefined ? "deterministic" : deterministic === null ? "judge" : "composite",
      ...(usage ? { usage, usageSource: "provider" as const } : {}),
      ...(costUsd !== undefined ? { costUsd, costSource: "provider-usage" as const } : {}),
      ...(output ? { response: { text: output.text, toolCalls: output.toolCalls } } : { error: item.error }),
    };
  });

  const candidateUsage = emptyUsage();
  for (const generation of generations) addUsage(candidateUsage, generation.output?.usage);
  const failedAttempts = generations
    .filter((generation) => generation.error || generation.output?.terminalState !== "completed")
    .map((generation) => {
      const failure = generation.failure;
      const usage = failure?.usage ?? generation.output?.usage;
      return {
        modelId: generation.runtime,
        ...(failure?.status === undefined ? {} : { status: failure.status }),
        ...(usage ? { usage } : {}),
      };
    });
  if (judgeAttempted && !judgeResult) {
    failedAttempts.push({
      modelId: config.judgeModel,
      ...(judgeFailure.status === undefined ? {} : { status: judgeFailure.status }),
      ...(judgeFailure.usage ? { usage: judgeFailure.usage } : {}),
    });
  }
  const costs: EvalCostLedger = {
    candidateGeneration: candidateUsage,
    judge: judgeResult?.usage ?? judgeFailure.usage ?? emptyUsage(),
    embedding: emptyUsage(),
    failedAttempts,
    retries: [
      ...generations.flatMap((generation) => generation.failure?.retries ?? generation.output?.retries ?? []),
      ...(judgeResult?.retries ?? judgeFailure.retries),
    ],
  };
  const record = redactContent({
    id: `${sessionId}/${turn.id}`,
    sessionGroupId,
    sequence,
    weight: turn.weight ?? 1,
    text: lastUserText(turn),
    taskType: turn.sessionState.userTag,
    sessionState: turn.sessionState,
    requiredCapabilities: turn.requiredCapabilities,
    outcomes,
    costs,
    ...(collectionError ? { collectionError } : {}),
  }) as Record<string, unknown>;
  if (collectionError) throw new CollectionTurnError(collectionError, record);
  return record;
}

export async function collectAvengersOutcomes(
  dataset: EvalDatasetV1,
  aliases: AvengersAliasMap,
  config: JudgeClientConfig,
  fetchImpl: typeof fetch = fetch,
  outputPath?: string,
  sourceManifest?: EvalSourceManifest,
): Promise<Record<string, unknown>[]> {
  if (outputPath && existsSync(outputPath)) throw new Error(`collection output already exists: ${outputPath}`);
  if (sourceManifest) validateManifestCoverage(sourceManifest, dataset, aliases);
  planAvengersCollection(dataset, aliases);
  const records: Record<string, unknown>[] = [];
  for (const session of dataset.sessions) {
    for (const [sequence, turn] of session.turns.entries()) {
      let record: Record<string, unknown>;
      let collectionError: Error | undefined;
      try {
        record = await collectTurn(session.id, session.sessionGroupId ?? session.id, sequence, turn, aliases, dataset, config, fetchImpl);
      } catch (error) {
        if (!(error instanceof CollectionTurnError)) throw error;
        record = error.record;
        collectionError = error;
      }
      const serialized = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error(`collection record exceeds ${MAX_RECORD_BYTES} bytes`);
      records.push(record);
      if (outputPath) {
        appendFileSync(outputPath, serialized, { mode: 0o600 });
        chmodSync(outputPath, 0o600);
      }
      if (collectionError) throw collectionError;
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

function expectedCollectionRecords(dataset: EvalDatasetV1): Map<string, Record<string, unknown>> {
  const expected = new Map<string, Record<string, unknown>>();
  for (const session of dataset.sessions) {
    for (const [sequence, turn] of session.turns.entries()) {
      const id = `${session.id}/${turn.id}`;
      expected.set(id, redactContent({
        id,
        sessionGroupId: session.sessionGroupId ?? session.id,
        sequence,
        weight: turn.weight ?? 1,
        text: lastUserText(turn),
        taskType: turn.sessionState.userTag,
        sessionState: turn.sessionState,
        requiredCapabilities: turn.requiredCapabilities,
      }) as Record<string, unknown>);
    }
  }
  return expected;
}

function validateRecordBinding(record: Record<string, unknown>, expected: Record<string, unknown>, id: string): void {
  for (const field of ["sessionGroupId", "sequence", "weight", "text", "taskType", "sessionState", "requiredCapabilities"] as const) {
    if (JSON.stringify(record[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`example ${id} does not match dataset field ${field}`);
    }
  }
}

export function curateAvengersCollection(inputPath: string, baseDataset: EvalDatasetV1, aliases: AvengersAliasMap, sourceManifest?: EvalSourceManifest): AvengersCorpusV1 {
  if (aliases.size < 2 || aliases.size > 26) throw new Error("candidate list must contain between 2 and 26 aliases");
  const manifest = sourceManifest ?? localSyntheticManifest(baseDataset, aliases);
  validateManifestCoverage(manifest, baseDataset, aliases);
  const lines = readFileSync(inputPath, "utf8").split("\n").filter((line) => line.trim());
  const expected = expectedCollectionRecords(baseDataset);
  const examples: AvengersCorpusExampleV1[] = [];
  const seenIds = new Set<string>();
  const byGroup = new Map<string, number[]>();

  for (const [index, line] of lines.entries()) {
    const record = parseCollectionLine(line, index + 1);
    const id = String(record.id ?? "");
    if (!id) throw new Error(`collection line ${index + 1} is missing id`);
    if (seenIds.has(id)) throw new Error(`duplicate example id ${id}`);
    seenIds.add(id);
    const expectedRecord = expected.get(id);
    if (!expectedRecord) throw new Error(`collection contains unknown example ${id}`);
    validateRecordBinding(record, expectedRecord, id);
    const rawOutcomes = Array.isArray(record.outcomes) ? record.outcomes as Array<Record<string, unknown>> : [];
    if (record.collectionError || rawOutcomes.some((outcome) => outcome.qualitySource === "unjudged")) {
      throw new Error(`example ${id} is unjudged`);
    }
    if (rawOutcomes.some((outcome) => outcome.terminalState !== "completed" || outcome.contentTruncated === true)) {
      throw new Error(`example ${id} is incomplete`);
    }
    const sessionGroupId = String(record.sessionGroupId ?? "");
    const sequence = Number(record.sequence);
    const group = byGroup.get(sessionGroupId) ?? [];
    group.push(sequence);
    byGroup.set(sessionGroupId, group);
    const outcomes = rawOutcomes;
    const seenModels = new Set<string>();
    const curatedOutcomes: AvengersOutcomeV1[] = outcomes.map((raw) => {
      const outcome = raw as Record<string, unknown>;
      const paperModelId = String(outcome.paperModelId ?? "");
      if (seenModels.has(paperModelId)) throw new Error(`duplicate model outcome ${paperModelId} in ${id}`);
      seenModels.add(paperModelId);
      const expectedRuntime = aliases.get(paperModelId);
      if (!expectedRuntime) throw new Error(`example ${id} contains unknown candidate ${paperModelId}`);
      const runtimeModelId = String(outcome.runtimeModelId ?? "");
      if (runtimeModelId !== expectedRuntime) {
        throw new Error(`example ${id} candidate ${paperModelId} used unexpected runtime ${runtimeModelId}`);
      }
      const { response: _response, error: _error, ...rest } = outcome;
      return rest as unknown as AvengersOutcomeV1;
    });
    for (const paper of aliases.keys()) {
      if (!seenModels.has(paper)) throw new Error(`example ${id} is missing candidate ${paper}`);
    }
    const costs = record.costs === undefined ? undefined : validateCostLedger(record.costs, `example ${id}.costs`);
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
      ...(costs ? { costs } : {}),
    });
  }

  for (const id of expected.keys()) {
    if (!seenIds.has(id)) throw new Error(`collection is missing example ${id}`);
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

  const synthetic = manifest.collectionOrigin === "synthetic-fixture";
  const config = { ...baseDataset.config, modelMap };
  const provenance = createEvalProvenance(
    baseDataset.catalog,
    config,
    manifest.digest ?? sourceManifestDigest(manifest),
    manifest.collectionOrigin,
    { sourceManifestOrigin: manifest.collectionOrigin, synthetic },
  );
  return {
    schemaVersion: 1,
    id: `${baseDataset.id}-avengers`,
    synthetic,
    candidatePaperModelIds: [...aliases.keys()].sort(),
    routingSnapshot: {
      catalog: baseDataset.catalog,
      config,
      prices: baseDataset.prices,
      capabilities: baseDataset.capabilities ?? {},
      modelMap,
    },
    provenance,
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
