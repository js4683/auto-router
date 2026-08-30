import type { SessionState, RouterConfig, TaskType } from "./types.js";

const VALID_TYPES: TaskType[] = ["code_review", "run_tests", "monitoring", "planning", "implement", "debug"];

// Very small heuristic mapping for auto-detect fallback (grill Q8b gated).
const AUTO_PATTERNS: Array<{ type: TaskType; re: RegExp; weight: number }> = [
  { type: "code_review", re: /\b(review|pr|pull request|approve|comment on|nit)\b/i, weight: 0.9 },
  {
    type: "run_tests",
    re: /\b(no[- ]mistakes|lint(?:ing)?|type[- ]?check|coverage|validate|verify|verification|jest|vitest|pytest)\b|\b(?:run|running|execute|check)\s+(?:the\s+)?(?:tests?|specs?|build|compile)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck)\b/i,
    weight: 0.95,
  },
  { type: "planning", re: /\b(plan|planning|architecture|architectural|system design|technical design|design decision|trade[- ]?offs?)\b/i, weight: 0.95 },
  { type: "monitoring", re: /\b(monitor|alert|dashboard|signalfx|splunk|grafana|slo|metric|log pipeline)\b/i, weight: 0.9 },
  { type: "debug", re: /\b(debug|why.*not work|not working|stack trace|error|exception|reproduce)\b/i, weight: 0.85 },
  { type: "implement", re: /\b(implement|build|create|add feature|refactor|architecture)\b/i, weight: 0.7 },
];

function explicitResolve(session: SessionState, config: RouterConfig): { type: TaskType | null; via: string; confidence: number } | null {
  // 1. userTag explicit (highest priority)
  if (session.userTag && (VALID_TYPES as string[]).includes(session.userTag)) {
    return { type: session.userTag as TaskType, via: "userTag", confidence: 1 };
  }
  // 2. agent -> taskType map
  const map = config.agentTaskTypeMap ?? {};
  if (session.activeAgent && map[session.activeAgent]) {
    return { type: map[session.activeAgent], via: `agent:${session.activeAgent}`, confidence: 0.95 };
  }
  // 3. taskTypeModels keys via activeAgent naming convention (e.g. agent 'review' -> code_review)
  if (session.activeAgent) {
    const lower = session.activeAgent.toLowerCase();
    if (lower.includes("review")) return { type: "code_review", via: "agent-infer:review", confidence: 0.8 };
    if (lower.includes("test")) return { type: "run_tests", via: "agent-infer:test", confidence: 0.8 };
    if (lower.includes("monitor")) return { type: "monitoring", via: "agent-infer:monitoring", confidence: 0.8 };
    if (lower.includes("plan") || lower.includes("architect")) return { type: "planning", via: "agent-infer:planning", confidence: 0.8 };
  }
  return null;
}

function autoDetect(session: SessionState): { type: TaskType; confidence: number; via: string } | null {
  const msg = session.currentTask.lastUserMessage || "";
  const files = session.currentTask.filesTouched;
  const depth = session.currentTask.toolDepth;

  let best: { type: TaskType; confidence: number; via: string } | null = null;

  for (const p of AUTO_PATTERNS) {
    if (p.re.test(msg)) {
      // corroboration requirement: need file or depth signal too for high confidence
      let conf = p.weight;
      // boost if filesTouched aligns (e.g. test files)
      if (p.type === "run_tests" && files >= 3) conf = Math.min(1, conf + 0.05);
      if (p.type === "monitoring" && depth >= 3) conf = Math.min(1, conf + 0.05);
      if (!best || conf > best.confidence) best = { type: p.type, confidence: conf, via: `auto:${p.type}` };
    }
  }

  return best;
}

/**
 * Task-type resolution (grill Q8/Q8b):
 * - explicit first (userTag, agent map)
 * - auto-detect fallback is gated: needs confidence >=0.8 AND at least 2 signals (pattern + files/depth corroboration).
 *   If weak, return null -> caller falls back to tier-default.
 */
export function resolveTaskType(
  session: SessionState,
  config: RouterConfig
): { type: TaskType | null; via: string; confidence: number } {
  const explicit = explicitResolve(session, config);
  if (explicit) return explicit;

  // auto-detect gated — require corroboration
  const auto = autoDetect(session);
  if (!auto) return { type: null, via: "none", confidence: 0 };

  // Gate: need corroboration for auto. If only pattern and no other signal, down-weight.
  const hasCorroboration =
    session.currentTask.filesTouched >= 2 ||
    session.currentTask.toolDepth >= 2 ||
    session.currentTask.diffHunks >= 2 ||
    (session.currentTask.taskTokens > 2000);

  const safeWithoutCorroboration = auto.type === "run_tests" || auto.type === "planning";
  if (auto.confidence >= 0.8 && (hasCorroboration || safeWithoutCorroboration)) {
    return auto;
  }

  // weak auto — treat as no type, fallback to tier-default
  return { type: null, via: `auto-weak:${auto.type}(${auto.confidence.toFixed(2)})`, confidence: auto.confidence };
}
