import type { DeterministicCheck, LiveOutput } from "./types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function checkScore(output: LiveOutput, check: DeterministicCheck): number {
  if (check.type === "exact-text") return output.text === check.expected ? 1 : 0;
  if (check.type === "includes") return check.expected.every((fragment) => output.text.includes(fragment)) ? 1 : 0;
  if (check.type === "terminal-state") return output.terminalState === check.expected ? 1 : 0;
  if (check.type === "recorded-outcome") return check.passed ? 1 : 0;
  if (check.type === "tool-call") {
    return output.toolCalls.some((call) => call.name === check.name && (check.arguments === undefined || equalJson(call.arguments, check.arguments))) ? 1 : 0;
  }
  try {
    return equalJson(JSON.parse(output.text), check.expected) ? 1 : 0;
  } catch {
    return 0;
  }
}

export function runChecks(output: LiveOutput, checks: DeterministicCheck[]): number | null {
  if (!checks.length) return null;
  return checks.reduce((total, check) => total + checkScore(output, check), 0) / checks.length;
}
