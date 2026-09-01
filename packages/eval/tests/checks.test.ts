import { describe, expect, it } from "vitest";
import { runChecks } from "../src/checks.js";
import type { LiveOutput } from "../src/types.js";

function output(overrides: Partial<LiveOutput> = {}): LiveOutput {
  return {
    text: "Tests passed",
    toolCalls: [{ name: "read", arguments: { path: "README.md" } }],
    terminalState: "completed",
    ...overrides,
  };
}

describe("runChecks", () => {
  it("scores exact text and required fragments", () => {
    expect(runChecks(output(), [{ type: "exact-text", expected: "Tests passed" }])).toBe(1);
    expect(runChecks(output(), [{ type: "includes", expected: ["Tests", "passed"] }])).toBe(1);
    expect(runChecks(output(), [{ type: "includes", expected: ["Tests", "failed"] }])).toBe(0);
  });

  it("compares parsed JSON independent of key order", () => {
    expect(runChecks(output({ text: '{"b":2,"a":1}' }), [{ type: "json-equals", expected: { a: 1, b: 2 } }])).toBe(1);
    expect(runChecks(output({ text: "not-json" }), [{ type: "json-equals", expected: { a: 1 } }])).toBe(0);
  });

  it("checks tool calls, terminal states, and recorded outcomes", () => {
    expect(runChecks(output(), [{ type: "tool-call", name: "read", arguments: { path: "README.md" } }])).toBe(1);
    expect(runChecks(output(), [{ type: "terminal-state", expected: "completed" }])).toBe(1);
    expect(runChecks(output(), [{ type: "recorded-outcome", passed: true }])).toBe(1);
    expect(runChecks(output(), [{ type: "recorded-outcome", passed: false }])).toBe(0);
  });

  it("averages checks and returns null when no checks exist", () => {
    expect(
      runChecks(output(), [
        { type: "exact-text", expected: "Tests passed" },
        { type: "terminal-state", expected: "failed" },
      ])
    ).toBe(0.5);
    expect(runChecks(output(), [])).toBeNull();
  });
});
