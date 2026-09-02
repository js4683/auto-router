import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Catalog, ModelMap, RouterConfig, SessionState, TaskType } from "@auto-router/router-core";
import type { EvalPrice, EvalUsage, UsageSource } from "./types.js";

const MAX_EXAMPLES = 10_000;
const MAX_OUTCOMES_PER_EXAMPLE = 64;
const MAX_TEXT_BYTES = 64 * 1024;

export interface AvengersOutcomeV1 {
  paperModelId: string;
  runtimeModelId: string;
  terminalState: "completed" | "incomplete" | "failed";
  contentTruncated: boolean;
  quality: number;
  qualitySource: "judge" | "deterministic" | "composite";
  usage?: EvalUsage;
  usageSource?: UsageSource;
  costUsd?: number;
  costSource?: "provider-usage" | "estimated";
}

export interface AvengersCorpusExampleV1 {
  id: string;
  sessionGroupId: string;
  sequence: number;
  weight: number;
  text: string;
  taskType?: TaskType;
  sessionState: SessionState;
  requiredCapabilities: string[];
  outcomes: AvengersOutcomeV1[];
}

export interface AvengersCorpusV1 {
  schemaVersion: 1;
  id: string;
  synthetic: boolean;
  candidatePaperModelIds: string[];
  routingSnapshot: {
    catalog: Catalog;
    config: RouterConfig;
    prices: Record<string, EvalPrice>;
    capabilities: Record<string, string[]>;
    modelMap: ModelMap;
  };
  examples: AvengersCorpusExampleV1[];
}

export interface CorpusSplit {
  train: AvengersCorpusExampleV1[];
  heldOut: AvengersCorpusExampleV1[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item) => nonEmptyString(item, `${label} item`));
}

function validateUsage(value: unknown, label: string): EvalUsage {
  const usage = record(value, label);
  return {
    inputTokens: finiteNumber(usage.inputTokens, `${label}.inputTokens`),
    outputTokens: finiteNumber(usage.outputTokens, `${label}.outputTokens`),
    cacheReadInputTokens: finiteNumber(usage.cacheReadInputTokens, `${label}.cacheReadInputTokens`),
    cacheWriteInputTokens: finiteNumber(usage.cacheWriteInputTokens, `${label}.cacheWriteInputTokens`),
  };
}

function validateOutcome(value: unknown, label: string, knownRuntimeIds: Set<string>): AvengersOutcomeV1 {
  const outcome = record(value, label);
  const paperModelId = nonEmptyString(outcome.paperModelId, `${label}.paperModelId`);
  const runtimeModelId = nonEmptyString(outcome.runtimeModelId, `${label}.runtimeModelId`);
  if (!knownRuntimeIds.has(runtimeModelId)) throw new Error(`${label}.runtimeModelId is an unknown runtime alias`);
  if (!["completed", "incomplete", "failed"].includes(String(outcome.terminalState))) {
    throw new Error(`${label}.terminalState is invalid`);
  }
  const terminalState = outcome.terminalState as AvengersOutcomeV1["terminalState"];
  const contentTruncated = boolean(outcome.contentTruncated, `${label}.contentTruncated`);
  const quality = finiteNumber(outcome.quality, `${label}.quality`);
  if (quality < 0 || quality > 1) throw new Error(`${label}.quality must be within [0, 1]`);
  if (terminalState !== "completed" && quality !== 0) throw new Error("non-completed outcome quality must be zero");
  if (contentTruncated && (terminalState !== "incomplete" || quality !== 0)) {
    throw new Error(`${label} truncated content must use terminal state incomplete with quality zero`);
  }
  if (!["judge", "deterministic", "composite"].includes(String(outcome.qualitySource))) {
    throw new Error(`${label}.qualitySource is invalid`);
  }
  const qualitySource = outcome.qualitySource as AvengersOutcomeV1["qualitySource"];

  const result: AvengersOutcomeV1 = { paperModelId, runtimeModelId, terminalState, contentTruncated, quality, qualitySource };

  if (outcome.usage !== undefined || outcome.usageSource !== undefined) {
    if (!["provider", "estimated"].includes(String(outcome.usageSource))) throw new Error(`${label}.usageSource is invalid`);
    result.usage = validateUsage(outcome.usage, `${label}.usage`);
    result.usageSource = outcome.usageSource as UsageSource;
  }
  if (outcome.costUsd !== undefined) {
    const costUsd = finiteNumber(outcome.costUsd, `${label}.costUsd`);
    if (costUsd < 0) throw new Error(`${label}.costUsd must be non-negative`);
    result.costUsd = costUsd;
    if (!["provider-usage", "estimated"].includes(String(outcome.costSource))) throw new Error(`${label}.costSource is invalid`);
    result.costSource = outcome.costSource as AvengersOutcomeV1["costSource"];
  }
  return result;
}

function validateSessionState(value: unknown): SessionState {
  const state = record(value, "sessionState");
  const task = record(state.currentTask, "sessionState.currentTask");
  for (const field of ["promptTokens", "taskTokens", "filesTouched", "diffHunks", "toolDepth"] as const) {
    finiteNumber(task[field], `sessionState.currentTask.${field}`);
  }
  nonEmptyString(task.lastUserMessage, "sessionState.currentTask.lastUserMessage");
  finiteNumber(state.lifetimeTokens, "sessionState.lifetimeTokens");
  return value as SessionState;
}

function validateExample(value: unknown, index: number, candidatePaperModelIds: string[], knownRuntimeIds: Set<string>): AvengersCorpusExampleV1 {
  const label = `examples[${index}]`;
  const example = record(value, label);
  const id = nonEmptyString(example.id, `${label}.id`);
  const sessionGroupId = nonEmptyString(example.sessionGroupId, `${label}.sessionGroupId`);
  const sequence = finiteNumber(example.sequence, `${label}.sequence`);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error(`${label}.sequence must be a non-negative integer`);
  const weight = finiteNumber(example.weight, `${label}.weight`);
  if (weight <= 0) throw new Error(`${label}.weight must be positive`);
  const text = nonEmptyString(example.text, `${label}.text`);
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error(`${label}.text exceeds 64 KiB`);
  if (example.taskType !== undefined) nonEmptyString(example.taskType, `${label}.taskType`);
  const sessionState = validateSessionState(example.sessionState);
  const requiredCapabilities = stringArray(example.requiredCapabilities, `${label}.requiredCapabilities`);

  const rawOutcomes = array(example.outcomes, `${label}.outcomes`);
  if (rawOutcomes.length > MAX_OUTCOMES_PER_EXAMPLE) throw new Error(`${label}.outcomes must not exceed 64 entries`);
  const outcomes = rawOutcomes.map((outcome, outcomeIndex) => validateOutcome(outcome, `${label}.outcomes[${outcomeIndex}]`, knownRuntimeIds));
  const outcomeModelIds = new Set<string>();
  for (const outcome of outcomes) {
    if (outcomeModelIds.has(outcome.paperModelId)) throw new Error(`${label} has duplicate model outcomes for ${outcome.paperModelId}`);
    outcomeModelIds.add(outcome.paperModelId);
  }
  const missing = candidatePaperModelIds.filter((paperModelId) => !outcomeModelIds.has(paperModelId));
  if (missing.length) throw new Error(`${label} is missing the complete candidate matrix: ${missing.join(", ")}`);

  return {
    id,
    sessionGroupId,
    sequence,
    weight,
    text,
    ...(example.taskType !== undefined ? { taskType: example.taskType as TaskType } : {}),
    sessionState,
    requiredCapabilities,
    outcomes,
  };
}

function validateRoutingSnapshot(value: unknown): { snapshot: AvengersCorpusV1["routingSnapshot"]; knownRuntimeIds: Set<string> } {
  const snapshot = record(value, "routingSnapshot");
  const catalog = record(snapshot.catalog, "routingSnapshot.catalog");
  const config = record(snapshot.config, "routingSnapshot.config");
  const prices = record(snapshot.prices, "routingSnapshot.prices");
  const capabilities = record(snapshot.capabilities, "routingSnapshot.capabilities");
  const modelMap = record(snapshot.modelMap, "routingSnapshot.modelMap");

  const knownRuntimeIds = new Set<string>();
  for (const model of array(catalog.models, "routingSnapshot.catalog.models")) {
    const entry = record(model, "routingSnapshot.catalog.models item");
    const runtimeId = entry.runtimeId !== undefined ? nonEmptyString(entry.runtimeId, "model.runtimeId") : nonEmptyString(entry.id, "model.id");
    knownRuntimeIds.add(runtimeId);
  }

  return {
    snapshot: {
      catalog: catalog as unknown as Catalog,
      config: config as unknown as RouterConfig,
      prices: prices as unknown as Record<string, EvalPrice>,
      capabilities: capabilities as unknown as Record<string, string[]>,
      modelMap: modelMap as unknown as ModelMap,
    },
    knownRuntimeIds,
  };
}

export function parseAvengersCorpus(value: unknown): AvengersCorpusV1 {
  const corpus = record(value, "corpus");
  if (corpus.schemaVersion !== 1) throw new Error(`unsupported schemaVersion ${String(corpus.schemaVersion)}`);
  const id = nonEmptyString(corpus.id, "corpus.id");
  const synthetic = boolean(corpus.synthetic, "corpus.synthetic");
  const candidatePaperModelIds = stringArray(corpus.candidatePaperModelIds, "corpus.candidatePaperModelIds");
  const { snapshot, knownRuntimeIds } = validateRoutingSnapshot(corpus.routingSnapshot);

  const rawExamples = array(corpus.examples, "corpus.examples");
  if (rawExamples.length > MAX_EXAMPLES) throw new Error(`corpus must not exceed ${MAX_EXAMPLES} examples`);
  const examples = rawExamples.map((example, index) => validateExample(example, index, candidatePaperModelIds, knownRuntimeIds));

  const seenIds = new Set<string>();
  for (const example of examples) {
    if (seenIds.has(example.id)) throw new Error(`duplicate example id ${example.id}`);
    seenIds.add(example.id);
  }

  const bySessionGroup = new Map<string, AvengersCorpusExampleV1[]>();
  for (const example of examples) {
    const group = bySessionGroup.get(example.sessionGroupId) ?? [];
    group.push(example);
    bySessionGroup.set(example.sessionGroupId, group);
  }
  for (const [sessionGroupId, group] of bySessionGroup) {
    const sequences = group.map((example) => example.sequence).sort((a, b) => a - b);
    for (let i = 0; i < sequences.length; i++) {
      if (sequences[i] !== i) throw new Error(`sequence values for session group ${sessionGroupId} must be zero-based and contiguous`);
    }
  }

  return {
    schemaVersion: 1,
    id,
    synthetic,
    candidatePaperModelIds,
    routingSnapshot: snapshot,
    examples,
  };
}

export function readAvengersCorpus(path: string): AvengersCorpusV1 {
  return parseAvengersCorpus(JSON.parse(readFileSync(path, "utf8")));
}

function canonicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON contains an unsupported value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort(canonicalCompare);
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("canonical JSON contains an unsupported value");
}

export function avengersCorpusDigest(corpus: AvengersCorpusV1): string {
  return createHash("sha256").update(canonicalValue(corpus)).digest("hex");
}

function splitRatio(seed: string, sessionGroupId: string): number {
  const hash = createHash("sha256").update(`${seed}\0${sessionGroupId}`).digest("hex");
  const value = Number.parseInt(hash.slice(0, 13), 16);
  return value / 0x10000000000000;
}

export function splitAvengersCorpus(corpus: AvengersCorpusV1, seed: string, heldOutRatio: number): CorpusSplit {
  if (!Number.isFinite(heldOutRatio) || heldOutRatio <= 0 || heldOutRatio >= 1) {
    throw new Error("heldOutRatio must be within the open interval (0, 1)");
  }

  const train: AvengersCorpusExampleV1[] = [];
  const heldOut: AvengersCorpusExampleV1[] = [];
  for (const example of corpus.examples) {
    const bucket = splitRatio(seed, example.sessionGroupId) < heldOutRatio ? heldOut : train;
    bucket.push(example);
  }

  const sortExamples = (examples: AvengersCorpusExampleV1[]): AvengersCorpusExampleV1[] =>
    [...examples].sort((a, b) => {
      if (a.sessionGroupId !== b.sessionGroupId) return canonicalCompare(a.sessionGroupId, b.sessionGroupId);
      if (a.sequence !== b.sequence) return a.sequence - b.sequence;
      return canonicalCompare(a.id, b.id);
    });

  const sortedTrain = sortExamples(train);
  const sortedHeldOut = sortExamples(heldOut);
  if (!sortedTrain.length || !sortedHeldOut.length) throw new Error("split must produce a non-empty train and held-out partition");

  return { train: sortedTrain, heldOut: sortedHeldOut };
}
