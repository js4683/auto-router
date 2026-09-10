import type { Catalog, NormalizedToolCall, NormalizedUsage, RouterConfig, SelectionResult, SessionState, TaskType, Tier } from "@auto-router/router-core";
import type { EvalProvenance } from "./provenance.js";

export const EVAL_SCHEMA_VERSION = 1 as const;

export type StrategyName = "router" | "always-frontier" | "always-cheap";
export type EvalTerminalState = "completed" | "incomplete" | "failed";
export type LiveTransport = "chat" | "responses";

export interface EvalUsage extends NormalizedUsage {}

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
  | { type: "terminal-state"; expected: EvalTerminalState }
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
  terminalState: EvalTerminalState;
  contentTruncated: boolean;
  observed?: { modelId: string; usageSource: UsageSource; usage: EvalUsage; output?: unknown };
  requiredCapabilities: string[];
  checks?: DeterministicCheck[];
  judgeRubric?: string;
  weight?: number;
}

export interface EvalSessionV1 {
  id: string;
  sessionGroupId?: string;
  cohort?: string;
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
  liveTransportDefault?: LiveTransport;
  liveTransports?: Record<string, LiveTransport>;
  provenance?: EvalProvenance;
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
  weight: number;
  terminalState: EvalTerminalState;
  contentTruncated: boolean;
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

export interface ProviderObservedMetrics {
  usageSource: "provider";
  costSource: "provider-usage-priced-from-dataset";
  sampleSize: number;
  totalUsage: EvalUsage | null;
  totalCostUsd: number | null;
  incompleteReasons: string[];
}

export interface LiveStrategyMetrics {
  sampleSize: number;
  quality: {
    deterministic: number | null;
    judge: number | null;
    composite: number | null;
  };
  providerObserved: ProviderObservedMetrics;
}

export interface ReportGate {
  passed: boolean;
  reason: string;
}

export interface StrategyReport {
  metrics: StrategyMetrics;
  turns: Array<Omit<ReplayTurnResult, "usage">>;
  live?: LiveStrategyMetrics;
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
    completeness: ReportGate;
    liveQuality: ReportGate;
    estimatedCost: ReportGate;
    versionedQuality?: VersionedQualityGate;
  };
  live?: LiveEvalResult;
}

export interface LiveToolCall extends Omit<NormalizedToolCall, "id"> {
  id?: string;
}

export interface LiveOutput {
  text: string;
  toolCalls: LiveToolCall[];
  terminalState: EvalTerminalState;
  usage?: EvalUsage;
  runtimeModelId?: string;
  retries?: EvalRetryRecord[];
}

export interface EvalRetryRecord {
  operation: string;
  attempt: number;
  delayMs: number;
  status?: number;
}

export interface EvalCostLedger {
  candidateGeneration: EvalUsage;
  judge: EvalUsage;
  embedding: EvalUsage;
  failedAttempts: Array<{ modelId: string; status?: number; usage?: EvalUsage }>;
  retries: EvalRetryRecord[];
}

export interface QualityCaseScore {
  routerScore: number;
  frontierScore: number;
  weight: number;
  groupId?: string;
  cohort?: string;
}

export interface GroupedQualityCaseScore {
  groupId: string;
  cohort: string;
  routerScore: number;
  frontierScore: number;
  weight: number;
  tier0Score?: number;
  cheapScore?: number;
}

export interface VersionedQualityInput {
  overall: GroupedQualityCaseScore[];
  cohorts: Record<string, GroupedQualityCaseScore[]>;
  criticalCohorts?: string[];
  incompleteCases?: number;
}

export interface VersionedQualityGate {
  passed: boolean;
  reason: string;
  lowerBound: number | null;
  independentGroups: number;
  cohortResults: Record<string, { passed: boolean; lowerBound: number | null; independentGroups: number; reason: string }>;
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
  sessionGroupId?: string;
  cohort?: string;
  weight: number;
  complete: boolean;
  scores?: Record<StrategyName, LiveQualityScore>;
  usage?: Partial<Record<StrategyName, EvalUsage>>;
  observedCostUsd?: Partial<Record<StrategyName, number>>;
  costEvidenceComplete?: boolean;
  errors: string[];
  costs?: EvalCostLedger;
}

export interface LiveEvalResult {
  plan: LiveCallPlan;
  cases: LiveCaseResult[];
  qualityGate: QualityGateResult;
  versionedQualityGate?: VersionedQualityGate;
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
  sessionStable?: boolean;
  requiredCapabilities: string[];
  usageSource: UsageSource;
  usage: EvalUsage;
  messages?: EvalMessage[];
  output?: unknown;
  contentTruncated?: boolean;
  attempts?: ReadonlyArray<{ provider: string; runtimeModelId: string; accountId?: string; status?: number }>;
  finalRuntimeId?: string;
}

export interface EvalRecorder {
  mode: RecordingMode;
  record(input: EvalRecordInput): Promise<void>;
  flush(): Promise<void>;
  stats?(): { queued: number; dropped: number; written: number; pruned: number };
}
