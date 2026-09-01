import type { Catalog, RouterConfig, SelectionResult, SessionState, TaskType, Tier } from "@auto-router/router-core";

export const EVAL_SCHEMA_VERSION = 1 as const;

export type StrategyName = "router" | "always-frontier" | "always-cheap";

export interface EvalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export type UsageSource = "provider" | "estimated";

export interface EvalPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export type DeterministicCheck =
  | { type: "exact-text"; expected: string }
  | { type: "includes"; expected: string[] }
  | { type: "json-equals"; expected: unknown }
  | { type: "tool-call"; name: string; arguments?: Record<string, unknown> }
  | { type: "terminal-state"; expected: "completed" | "incomplete" | "failed" }
  | { type: "recorded-outcome"; passed: boolean };

export interface EvalMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface EvalTurnV1 {
  id: string;
  sessionState: SessionState;
  prevAgent?: string;
  prevMessage?: string;
  messages?: EvalMessage[];
  usage: EvalUsage;
  observed?: { modelId: string; usageSource: UsageSource; usage: EvalUsage; output?: unknown };
  requiredCapabilities?: string[];
  checks?: DeterministicCheck[];
  judgeRubric?: string;
  weight?: number;
}

export interface EvalSessionV1 {
  id: string;
  turns: EvalTurnV1[];
}

export interface EvalDatasetV1 {
  schemaVersion: 1;
  id: string;
  description: string;
  catalog: Catalog;
  config: RouterConfig;
  prices: Record<string, EvalPrice>;
  capabilities?: Record<string, string[]>;
  liveModelAliases?: Record<string, string>;
  sessions: EvalSessionV1[];
}

export type ReplayVia = SelectionResult["via"] | "always-frontier" | "always-cheap";

export interface ReplayTurnResult {
  sessionId: string;
  turnId: string;
  modelId: string;
  tier: Tier | null;
  taskType: TaskType | null;
  via: ReplayVia;
  reason: string;
  codingIndex: number;
  usage: EvalUsage;
}

export interface StrategyReplayResult {
  name: StrategyName;
  turns: ReplayTurnResult[];
  incompleteReasons: string[];
}

export interface ReplayResult {
  strategies: Record<StrategyName, StrategyReplayResult>;
}

export interface StrategyMetrics {
  isEstimated: true;
  totalCostUsd: number | null;
  switchCount: number;
  cacheReadTokens: number;
  cacheMissTokens: number;
  qualityProxy: number | null;
  incompleteReasons: string[];
}

export interface ReportGate {
  passed: boolean;
  reason: string;
}

export interface StrategyReport {
  metrics: StrategyMetrics;
  turns: Array<Omit<ReplayTurnResult, "usage">>;
}

export interface EvalReportV1 {
  schemaVersion: 1;
  datasetId: string;
  mode: "offline" | "live";
  sampleSize: number;
  providerObserved: {
    sampleSize: number;
    totalCostUsd: number | null;
    incompleteReasons: string[];
  };
  strategies: Record<StrategyName, StrategyReport>;
  comparisons: {
    routerCostSavedVsFrontier: number | null;
    routerQualityProxyRetainedVsFrontier: number | null;
  };
  gates: {
    liveQuality: ReportGate;
    estimatedCost: ReportGate;
  };
  live?: LiveEvalResult;
}

export interface LiveToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LiveOutput {
  text: string;
  toolCalls: LiveToolCall[];
  terminalState: "completed" | "incomplete" | "failed";
  usage?: EvalUsage;
}

export interface QualityCaseScore {
  routerScore: number;
  frontierScore: number;
  weight: number;
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  samples: number;
  seed: string;
}

export interface QualityGateResult {
  passed: boolean;
  sampleSize: number;
  retention: number | null;
  reason: string;
  confidenceInterval: ConfidenceInterval | null;
}

export interface LiveCallPlan {
  caseCount: number;
  generationCalls: number;
  judgeCalls: number;
  modelIds: string[];
}

export interface LiveQualityScore {
  deterministic: number | null;
  judge: number;
  composite: number;
}

export interface LiveCaseResult {
  id: string;
  sessionId: string;
  turnId: string;
  weight: number;
  complete: boolean;
  scores?: Record<StrategyName, LiveQualityScore>;
  usage?: Partial<Record<StrategyName, EvalUsage>>;
  observedCostUsd?: Partial<Record<StrategyName, number>>;
  errors: string[];
}

export interface LiveEvalResult {
  plan: LiveCallPlan;
  cases: LiveCaseResult[];
  qualityGate: QualityGateResult;
}

export type RecordingMode = "off" | "metadata" | "content";

export interface EvalRecordInput {
  sessionId: string;
  turnId: string;
  recordedAt: string;
  durationMs: number;
  status: "completed" | "incomplete" | "failed";
  selection: { modelId: string; via: string; reason: string };
  sessionState: SessionState;
  usageSource: UsageSource;
  usage: EvalUsage;
  messages?: EvalMessage[];
  output?: unknown;
  contentTruncated?: boolean;
}

export interface EvalRecorder {
  mode: RecordingMode;
  record(input: EvalRecordInput): Promise<void>;
  flush(): Promise<void>;
}
