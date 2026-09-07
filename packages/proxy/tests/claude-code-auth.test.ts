import { describe, expect, it } from "vitest";
import { parseClaudeCodeOauth } from "../src/claude-code-auth.js";

describe("parseClaudeCodeOauth", () => {
  it("reads Claude Code Pro/Max keychain JSON", () => {
    const parsed = parseClaudeCodeOauth({
      claudeAiOauth: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: 123,
        subscriptionType: "pro",
      },
    });
    expect(parsed).toEqual({ access: "access-token", refresh: "refresh-token", expires: 123 });
  });

  it("ignores unrelated JSON", () => {
    expect(parseClaudeCodeOauth({ type: "oauth", access: "nope" })).toBeUndefined();
  });
});
