/**
 * Auto-router core types — harness-agnostic.
 * Follows grilled decisions: two-window SessionState, gated heuristics, free-first join.
 */

export type Tier = "simple" | "medium" | "complex";
export type TaskType = "code_review" | "run_tests" | "monitoring" | "planning" | "implement" | "debug";
export type TaskStrategy = "value" | "lowest-cost" | "quality";

// ---- Session state: two windows (grill Q1) ----
export interface CurrentTaskSignals {
  /** tokens in the current user prompt (approx) */
  promptTokens: number;
  /** tokens accumulated in current task window (resets on boundary) */
  taskTokens: number;
  /** number of files touched in current task */
  filesTouched: number;
  /** diff hunk count in current turn/task */
  diffHunks: number;
  /** how deep the agent tool-call loop is */
  toolDepth: number;
  /** last user message text (for keyword signals) */
  lastUserMessage: string;
  /** prior errors in current task — hard-signal for instant upgrade */
  priorErrors?: number;
  /** raw diff token estimate (optional) */
  diffTokens?: number;
}

export interface SessionState {
  /** lifetime tokens for context-fit guard (never reset) */
  lifetimeTokens: number;
  /** signals scoped to current task — reset on confident boundary */
  currentTask: CurrentTaskSignals;
  /** explicit task-type tag from user, e.g. "code_review" */
  userTag?: TaskType | string;
  /** active opencode agent/mode name -> mapped to TaskType */
  activeAgent?: string;
  /** whether session was just compacted/cleared — triggers boundary */
  isCompacted?: boolean;
  /** whether this is a brand new session */
  isNewSession?: boolean;
  /** optional manual override for testing: force tier */
  forceTier?: Tier;
}

// ---- Classifier ----
export interface ClassifyResult {
  tier: Tier;
  score: number; // 0..1
  confidence: number; // 0..1 distance from threshold
  signals: Record<string, number>;
  reasons: string[];
}

export interface BoundaryResult {
  isBoundary: boolean;
  confidence: number;
  signals: string[];
  reason: string;
}

// ---- Catalog ----
export interface ModelEntry {
  id: string;
  /** Provider-qualified ID used when addressing the runtime model. */
  runtimeId?: string;
  /** Artificial Analysis coding_index (quality) */
  codingIndex: number;
  /** blended price per 1M tokens, 3:1 output:input */
  blendedPrice: number;
  /** derived bang-for-buck */
  value: number;
  /** context window size (from windowRegistry) */
  windowTokens: number;
  /** whether model is free to the user (providerFreeSet join) */
  isFree: boolean;
  /** tie-breakers from AA */
  medianOutputTokensPerSec?: number;
  medianTimeToFirstTokenSec?: number;
}

export interface Catalog {
  models: ModelEntry[];
  fetchedAt: string;
  source: "aa" | "cache" | "fallback" | "live";
}

export type ModelMapSource = "bench" | "hand";

export interface ModelMapEntry {
  runtimeId: string;
  source: ModelMapSource;
}

export type ModelMap = Record<string, ModelMapEntry[]>;

// ---- Policy config (from auto-router.json) ----
export interface TierConfig {
  minQuality: number;
  description?: string;
}

export interface ScorerConfig {
  weights: {
    promptTokens: number;
    sessionTokens: number;
    filesTouched: number;
    diffHunks: number;
    toolDepth: number;
    keywords: number;
  };
  thresholds: {
    simpleMax: number;
    mediumMax: number;
  };
}

export interface StickinessConfig {
  downgradeAfter: number;
  upgradeImmediate: boolean;
}

export interface GuardsConfig {
  contextFitMarginTokens: number;
}

export interface RouterConfig {
  tiers: Record<Tier, TierConfig>;
  scorer: ScorerConfig;
  stickiness: StickinessConfig;
  guards: GuardsConfig;
  taskTypeModels: Record<string, { prefer: string | null; strategy?: TaskStrategy; minQuality?: number }>;
  providerFreeSet: string[];
  windowRegistry: Record<string, number>;
  catalog: {
    cachePath: string;
    refreshIntervalHours: number;
    artificialAnalysis: { apiUrl: string; apiKeyEnv: string };
  };
  // optional agent -> taskType map
  agentTaskTypeMap?: Record<string, TaskType>;
}

// ---- Routing state (holds stickiness) ----
export interface RouterState {
  currentModel: string | null;
  currentTier: Tier | null;
  downgradeCounter: number; // consecutive boundaries requesting downgrade
  lastSelectionAt?: number;
}

export interface SelectionResult {
  modelId: string;
  tier: Tier;
  taskType: TaskType | null;
  confidence: number;
  reason: string;
  via: "taskType-prefer" | "free-first" | "lowest-cost" | "quality" | "value" | "stay-sticky" | "context-fit-block" | "force" | "fallback";
  blockedDowngrade?: boolean;
  catalogSource: Catalog["source"];
  score: number;
  boundary: BoundaryResult;
}
