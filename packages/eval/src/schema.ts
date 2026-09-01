import { readFileSync } from "node:fs";
import type { EvalDatasetV1, EvalUsage } from "./types.js";

const MAX_DATASET_BYTES = 50 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_TURNS = 1000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`${label} must be a string`);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function stringArray(value: unknown, label: string): void {
  for (const item of array(value, label)) string(item, `${label} item`);
}

function usage(value: unknown): EvalUsage {
  const item = record(value, "usage");
  const parsed = {
    inputTokens: nonNegative(item.inputTokens, "inputTokens"),
    outputTokens: nonNegative(item.outputTokens, "outputTokens"),
    cacheReadInputTokens: nonNegative(item.cacheReadInputTokens, "cacheReadInputTokens"),
    cacheWriteInputTokens: nonNegative(item.cacheWriteInputTokens, "cacheWriteInputTokens"),
  };
  if (parsed.cacheReadInputTokens + parsed.cacheWriteInputTokens > parsed.inputTokens) {
    throw new Error("cache token total must not exceed inputTokens");
  }
  return parsed;
}

function validateCurrentTask(value: unknown): void {
  const task = record(value, "currentTask");
  for (const field of ["promptTokens", "taskTokens", "filesTouched", "diffHunks", "toolDepth"] as const) {
    nonNegative(task[field], field);
  }
  string(task.lastUserMessage, "lastUserMessage");
  if (task.priorErrors !== undefined) nonNegative(task.priorErrors, "priorErrors");
  if (task.diffTokens !== undefined) nonNegative(task.diffTokens, "diffTokens");
}

function validateSessionState(value: unknown): void {
  const state = record(value, "sessionState");
  nonNegative(state.lifetimeTokens, "lifetimeTokens");
  validateCurrentTask(state.currentTask);
  optionalString(state.userTag, "userTag");
  optionalString(state.activeAgent, "activeAgent");
  optionalBoolean(state.isCompacted, "isCompacted");
  optionalBoolean(state.isNewSession, "isNewSession");
  if (state.forceTier !== undefined && !["simple", "medium", "complex"].includes(String(state.forceTier))) {
    throw new Error("forceTier must be simple, medium, or complex");
  }
}

function validateCatalog(value: unknown): void {
  const catalog = record(value, "catalog");
  string(catalog.fetchedAt, "catalog.fetchedAt");
  if (!["aa", "cache", "fallback", "live"].includes(String(catalog.source))) throw new Error("catalog.source is invalid");
  for (const value of array(catalog.models, "catalog.models")) {
    const model = record(value, "catalog model");
    string(model.id, "model.id");
    optionalString(model.runtimeId, "model.runtimeId");
    for (const field of ["codingIndex", "blendedPrice", "value", "windowTokens"] as const) nonNegative(model[field], `model.${field}`);
    boolean(model.isFree, "model.isFree");
  }
}

function validateTierConfig(value: unknown, label: string): void {
  const tier = record(value, label);
  nonNegative(tier.minQuality, `${label}.minQuality`);
  optionalString(tier.description, `${label}.description`);
}

function validateScorer(value: unknown): void {
  const scorer = record(value, "config.scorer");
  const weights = record(scorer.weights, "config.scorer.weights");
  for (const field of ["promptTokens", "sessionTokens", "filesTouched", "diffHunks", "toolDepth", "keywords"] as const) {
    nonNegative(weights[field], `config.scorer.weights.${field}`);
  }
  const thresholds = record(scorer.thresholds, "config.scorer.thresholds");
  nonNegative(thresholds.simpleMax, "config.scorer.thresholds.simpleMax");
  nonNegative(thresholds.mediumMax, "config.scorer.thresholds.mediumMax");
}

function validateTaskTypeModels(value: unknown): void {
  for (const [taskType, raw] of Object.entries(record(value, "config.taskTypeModels"))) {
    const policy = record(raw, `config.taskTypeModels.${taskType}`);
    if (!("prefer" in policy) || policy.prefer === undefined) throw new Error(`config.taskTypeModels.${taskType}.prefer is required`);
    if (policy.prefer !== null) string(policy.prefer, `config.taskTypeModels.${taskType}.prefer`);
    if (policy.strategy !== undefined && !["value", "lowest-cost", "quality"].includes(String(policy.strategy))) {
      throw new Error(`config.taskTypeModels.${taskType}.strategy is invalid`);
    }
    if (policy.minQuality !== undefined) nonNegative(policy.minQuality, `config.taskTypeModels.${taskType}.minQuality`);
  }
}

function validateStringMap(value: unknown, label: string, valuesAreArrays = false): void {
  for (const [key, entry] of Object.entries(record(value, label))) {
    string(key, `${label} key`);
    if (valuesAreArrays) {
      for (const item of array(entry, `${label}.${key}`)) string(item, `${label}.${key} item`);
    } else {
      nonNegative(entry, `${label}.${key}`);
    }
  }
}

function validateConfig(value: unknown): void {
  const config = record(value, "config");
  const tiers = record(config.tiers, "config.tiers");
  for (const tier of ["simple", "medium", "complex"] as const) validateTierConfig(tiers[tier], `config.tiers.${tier}`);
  validateScorer(config.scorer);
  const stickiness = record(config.stickiness, "config.stickiness");
  nonNegative(stickiness.downgradeAfter, "config.stickiness.downgradeAfter");
  boolean(stickiness.upgradeImmediate, "config.stickiness.upgradeImmediate");
  const guards = record(config.guards, "config.guards");
  nonNegative(guards.contextFitMarginTokens, "config.guards.contextFitMarginTokens");
  validateTaskTypeModels(config.taskTypeModels);
  for (const item of array(config.providerFreeSet, "config.providerFreeSet")) string(item, "config.providerFreeSet item");
  validateStringMap(config.windowRegistry, "config.windowRegistry");
  const catalog = record(config.catalog, "config.catalog");
  if (typeof catalog.cachePath !== "string") throw new Error("config.catalog.cachePath must be a string");
  nonNegative(catalog.refreshIntervalHours, "config.catalog.refreshIntervalHours");
  const aa = record(catalog.artificialAnalysis, "config.catalog.artificialAnalysis");
  if (typeof aa.apiUrl !== "string" || typeof aa.apiKeyEnv !== "string") throw new Error("config.catalog.artificialAnalysis is invalid");
}

function validatePrices(value: unknown): void {
  for (const [modelId, raw] of Object.entries(record(value, "prices"))) {
    string(modelId, "price model id");
    const price = record(raw, `prices.${modelId}`);
    for (const field of ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] as const) {
      nonNegative(price[field], `prices.${modelId}.${field}`);
    }
  }
}

function validateChecks(value: unknown): void {
  for (const raw of array(value, "checks")) {
    const check = record(raw, "check");
    const type = string(check.type, "check.type");
    if (type === "exact-text") string(check.expected, "check.expected");
    else if (type === "includes") for (const item of array(check.expected, "check.expected")) string(item, "check.expected item");
    else if (type === "json-equals") JSON.stringify(check.expected);
    else if (type === "tool-call") {
      string(check.name, "check.name");
      if (check.arguments !== undefined) record(check.arguments, "check.arguments");
    } else if (type === "terminal-state") {
      if (!["completed", "incomplete", "failed"].includes(String(check.expected))) throw new Error("check.expected terminal state is invalid");
    } else if (type === "recorded-outcome") boolean(check.passed, "check.passed");
    else throw new Error(`unsupported check type ${type}`);
  }
}

function validateMessages(value: unknown): void {
  for (const raw of array(value, "messages")) {
    const message = record(raw, "message");
    string(message.role, "message.role");
    let serialized: string;
    try {
      serialized = JSON.stringify(message.content);
    } catch {
      throw new Error("message content must be JSON serializable");
    }
    if (serialized === undefined) throw new Error("message content must be JSON serializable");
    if (Buffer.byteLength(serialized, "utf8") > MAX_MESSAGE_BYTES) throw new Error(`message content exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
}

function validateTurn(value: unknown, seen: Set<string>): void {
  const turn = record(value, "turn");
  const id = string(turn.id, "turn.id");
  if (seen.has(id)) throw new Error(`duplicate turn id ${id}`);
  seen.add(id);
  validateSessionState(turn.sessionState);
  usage(turn.usage);
  if (!["completed", "incomplete", "failed"].includes(String(turn.terminalState))) throw new Error("turn.terminalState is invalid");
  boolean(turn.contentTruncated, "turn.contentTruncated");
  optionalString(turn.prevAgent, "turn.prevAgent");
  optionalString(turn.prevMessage, "turn.prevMessage");
  optionalString(turn.judgeRubric, "turn.judgeRubric");
  if (turn.weight !== undefined) nonNegative(turn.weight, "turn.weight");
  if (turn.messages !== undefined) validateMessages(turn.messages);
  if (turn.checks !== undefined) validateChecks(turn.checks);
  stringArray(turn.requiredCapabilities, "requiredCapabilities");
  if (turn.observed !== undefined) {
    const observed = record(turn.observed, "observed");
    string(observed.modelId, "observed.modelId");
    if (!["provider", "estimated"].includes(String(observed.usageSource))) throw new Error("observed.usageSource is invalid");
    usage(observed.usage);
  }
}

function validateSessions(value: unknown): void {
  const sessions = array(value, "sessions");
  if (!sessions.length) throw new Error("sessions must not be empty");
  const totalTurns = sessions.reduce<number>((total, raw) => total + array(record(raw, "session").turns, "session.turns").length, 0);
  if (totalTurns > MAX_TURNS) throw new Error(`dataset exceeds ${MAX_TURNS} turns`);
  const sessionIds = new Set<string>();
  for (const raw of sessions) {
    const session = record(raw, "session");
    const id = string(session.id, "session.id");
    if (sessionIds.has(id)) throw new Error(`duplicate session id ${id}`);
    sessionIds.add(id);
    const turnIds = new Set<string>();
    const turns = array(session.turns, "session.turns");
    if (!turns.length) throw new Error(`session ${id} must contain turns`);
    for (const turn of turns) validateTurn(turn, turnIds);
  }
}

export function parseDataset(input: unknown): EvalDatasetV1 {
  const dataset = record(input, "dataset");
  if (dataset.schemaVersion !== 1) throw new Error(`unsupported schemaVersion ${String(dataset.schemaVersion)}`);
  string(dataset.id, "dataset.id");
  if (typeof dataset.description !== "string") throw new Error("dataset.description must be a string");
  validateCatalog(dataset.catalog);
  validateConfig(dataset.config);
  validatePrices(dataset.prices);
  if (dataset.capabilities !== undefined) validateStringMap(dataset.capabilities, "capabilities", true);
  if (dataset.liveModelAliases !== undefined) {
    for (const [key, value] of Object.entries(record(dataset.liveModelAliases, "liveModelAliases"))) {
      string(key, "liveModelAliases key");
      string(value, `liveModelAliases.${key}`);
    }
  }
  validateSessions(dataset.sessions);
  return input as EvalDatasetV1;
}

export function readDataset(path: string): EvalDatasetV1 {
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_DATASET_BYTES) throw new Error("dataset exceeds 50 MiB");
  return parseDataset(JSON.parse(bytes.toString("utf8")));
}
