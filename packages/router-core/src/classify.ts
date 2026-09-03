import type { SessionState, ClassifyResult, Tier, RouterConfig, BoundaryResult } from "./types.js";

// Keyword lists per design.md:169
const UP_KEYWORDS = ["refactor", "architecture", "design", "debug", "why", "race", "concurrency", "deadlock", "async", "migrate"];
const DOWN_KEYWORDS = ["rename", "typo", "format", "comment", "bump version", "bump", "lint", "prettier"];

function keywordScore(message: string): number {
  const lower = (message || "").toLowerCase();
  let score = 0;
  for (const kw of UP_KEYWORDS) if (lower.includes(kw)) score += 0.15;
  for (const kw of DOWN_KEYWORDS) if (lower.includes(kw)) score -= 0.15;
  // retry / error language boosts complexity (hard signal)
  if (lower.includes("why doesn't") || lower.includes("why doesnt") || lower.includes("not working") || lower.match(/error|fail|stack trace/)) {
    score += 0.2;
  }
  // clamp
  return Math.max(-0.3, Math.min(0.6, score));
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, value / max);
}

/**
 * Tier-0 heuristic scorer (grill Q6):
 * promptTokens 0.2 + session(task)Tokens 0.2 + files 0.15 + diff 0.15 + depth 0.15 + keywords ±0.15
 * Returns score 0..1 -> tier via 0.4/0.7 thresholds, confidence = distance from nearest threshold.
 */
export function classify(session: SessionState, config: RouterConfig): ClassifyResult {
  // Forced tier for local demo / testing bypasses scoring
  if (session.forceTier) {
    return {
      tier: session.forceTier,
      score: session.forceTier === "simple" ? 0.2 : session.forceTier === "medium" ? 0.55 : 0.85,
      confidence: 1,
      signals: { forced: 1 },
      reasons: [`forceTier=${session.forceTier}`],
    };
  }

  const { promptTokens, taskTokens, filesTouched, diffHunks, toolDepth, lastUserMessage } = session.currentTask;
  const w = config.scorer.weights;
  const t = config.scorer.thresholds;

  const promptNorm = normalize(promptTokens, 4000);
  const taskNorm = normalize(taskTokens, 30000);
  const filesNorm = normalize(filesTouched, 12);
  const diffNorm = normalize(diffHunks, 20);
  const depthNorm = normalize(toolDepth, 10);
  const kw = keywordScore(lastUserMessage); // -0.3..0.6

  // keyword contribution is additive after weighting; map -0.3..0.6 -> 0..1 then weight
  const kwNorm = (kw + 0.3) / 0.9; // 0..1

  const score =
    promptNorm * w.promptTokens +
    taskNorm * w.sessionTokens +
    filesNorm * w.filesTouched +
    diffNorm * w.diffHunks +
    depthNorm * w.toolDepth +
    kwNorm * w.keywords;

  const clamped = Math.max(0, Math.min(1, score));

  let tier: Tier;
  if (clamped < t.simpleMax) tier = "simple";
  else if (clamped < t.mediumMax) tier = "medium";
  else tier = "complex";

  // confidence = distance from nearest threshold (scaled to 0..1)
  let confidence: number;
  if (tier === "simple") confidence = (t.simpleMax - clamped) / t.simpleMax;
  else if (tier === "medium") {
    const distToSimple = clamped - t.simpleMax;
    const distToComplex = t.mediumMax - clamped;
    const nearest = Math.min(distToSimple, distToComplex);
    const halfWidth = (t.mediumMax - t.simpleMax) / 2;
    confidence = nearest / halfWidth;
  } else {
    confidence = (clamped - t.mediumMax) / (1 - t.mediumMax);
  }
  confidence = Math.max(0, Math.min(1, confidence));

  // hard-signal boost: if priorErrors or depth high, confidence up + score bump already via keyword/depth
  const reasons: string[] = [];
  if (kw > 0.2) reasons.push(`up-keyword boost ${kw.toFixed(2)}`);
  if (kw < -0.1) reasons.push(`down-keyword reduce ${kw.toFixed(2)}`);
  if (toolDepth >= 8) reasons.push(`deep tool call depth ${toolDepth}`);
  if (filesTouched >= 6) reasons.push(`many files ${filesTouched}`);
  if (diffHunks >= 10) reasons.push(`large diff ${diffHunks} hunks`);

  return {
    tier,
    score: clamped,
    confidence,
    signals: {
      promptTokens: promptNorm,
      taskTokens: taskNorm,
      filesTouched: filesNorm,
      diffHunks: diffNorm,
      toolDepth: depthNorm,
      keywords: kwNorm,
      rawKeyword: kw,
    },
    reasons,
  };
}

/**
 * Task-boundary detection (grill Q4/Q4b):
 * Heuristics CAN propose boundary but must clear confidence >=0.8 AND >=2 signals agree.
 * Explicit signals: isCompacted, isNewSession, activeAgent change (compared externally), userTag change.
 * Heuristic signals: keyword topic shift, diff jump, depth reset, file-set jump.
 */
export function detectBoundary(
  session: SessionState,
  prevAgent?: string,
  prevTaskMessage?: string
): BoundaryResult {
  const signals: string[] = [];
  let confidence = 0;
  const reasons: string[] = [];

  // Explicit — single signal is enough at high confidence
  if (session.isNewSession) {
    return { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" };
  }
  if (session.isCompacted) {
    return { isBoundary: true, confidence: 0.95, signals: ["compacted"], reason: "context compacted/cleared" };
  }
  if (session.activeAgent && prevAgent && session.activeAgent !== prevAgent) {
    return { isBoundary: true, confidence: 0.9, signals: ["agentChange"], reason: `agent ${prevAgent} -> ${session.activeAgent}` };
  }
  if (session.userTag && session.userTag !== prevTaskMessage) {
    // userTag is explicit task type tag — treat as boundary if present
    signals.push("userTag");
    confidence = Math.max(confidence, 0.85);
    reasons.push(`userTag=${session.userTag}`);
  }

  // Heuristic signals — need >=2 + high confidence
  const msg = (session.currentTask.lastUserMessage || "").toLowerCase();
  const prev = (prevTaskMessage || "").toLowerCase();

  // 1. topic shift keyword (new goal language)
  const newGoalPhrase = /^(build|create|implement|add|review|test|run|monitor|debug|fix|refactor)\b/.test(msg);
  if (newGoalPhrase && prev && !prev.startsWith(msg.slice(0, 10))) {
    signals.push("newGoalPhrase");
  }

  // 2. diff jump — large diff suggests new phase
  if (session.currentTask.diffHunks >= 12) signals.push("largeDiff");

  // 3. depth reset — prior deep loop then shallow suggests new task
  if (session.currentTask.toolDepth <= 2 && session.currentTask.taskTokens > 5000) signals.push("depthReset");

  // 4. file-set jump — many files touched
  if (session.currentTask.filesTouched >= 8) signals.push("manyFiles");

  // 5. message length / new instruction
  if (msg.length > 120 && prev && msg !== prev) signals.push("longNewMessage");

  // Heuristic confidence aggregation
  if (signals.length >= 2) {
    confidence = Math.max(confidence, 0.8 + Math.min(0.15, (signals.length - 2) * 0.05));
  } else if (signals.length === 1) {
    // single heuristic never enough alone — cap at 0.6
    confidence = Math.max(confidence, 0.6);
  }

  // Hard signals raise complexity confidence but do not start a new task by themselves.
  const hardSignal = (session.currentTask.priorErrors ?? 0) > 0 || msg.includes("why doesn't") || msg.includes("not working");
  if (hardSignal) {
    signals.push("hardSignal");
    confidence = Math.max(confidence, 0.85);
  }

  const taskBoundarySignals = signals.filter((signal) => signal !== "hardSignal");
  const isHeuristicBoundary = taskBoundarySignals.length >= 2 && confidence >= 0.8;

  if (isHeuristicBoundary || (signals.includes("userTag") && confidence >= 0.8)) {
    const finalSignals = [...new Set(signals)];
    const pass = taskBoundarySignals.length >= 2 || finalSignals.includes("userTag") || finalSignals.includes("agentChange");
    if (pass && confidence >= 0.8) {
      return { isBoundary: true, confidence, signals: finalSignals, reason: reasons.join(", ") || `heuristic boundary ${finalSignals.join("+")}` };
    }
  }

  // No confident boundary
  if (signals.length > 0 && confidence < 0.8) {
    return { isBoundary: false, confidence, signals, reason: `weak boundary (${signals.join(",")} <0.8)` };
  }

  return { isBoundary: false, confidence, signals, reason: signals.length ? `signals ${signals.join(",")}` : "no boundary signal" };
}

export function tierRank(tier: Tier): number {
  return tier === "simple" ? 0 : tier === "medium" ? 1 : 2;
}
