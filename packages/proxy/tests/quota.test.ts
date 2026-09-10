import { describe, expect, it } from "vitest";
import { parseClaudeUsage, parseCodexUsage, parseQuota, parseXaiBilling, reconcileUsageQuota } from "../src/quota.js";
import { settingsPage } from "../src/settings-ui.js";

describe("parseQuota", () => {
  it("computes usage percent from Anthropic remaining/limit headers", () => {
    const quota = parseQuota(
      new Headers({
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "65",
      }),
      200,
    );
    expect(quota.limited).toBe(false);
    expect(quota.meters[0]).toMatchObject({ label: "Requests", percent: 35, remaining: 65, limit: 100, unit: "requests", state: "observed" });
  });

  it("marks 429 as limited", () => {
    expect(parseQuota(new Headers(), 429).limited).toBe(true);
  });

  it("parses Claude oauth usage windows", () => {
    const meters = parseClaudeUsage({
      five_hour: { utilization: 0.35, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
      seven_day: { utilization: 10, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() },
    });
    expect(meters[0]).toMatchObject({ label: "5-hour limit", percent: 35 });
    expect(meters[1]).toMatchObject({ label: "Weekly limit", percent: 10 });
  });

  it("parses Codex wham usage windows", () => {
    const meters = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 34, reset_after_seconds: 7200 },
        secondary_window: { used_percent: 80, reset_after_seconds: 5 * 86400 },
      },
    });
    expect(meters[0]).toMatchObject({ label: "5-hour limit", percent: 34 });
    expect(meters[1]).toMatchObject({ label: "Weekly limit", percent: 80 });
  });

  it("treats Codex used_percent of 1 as one percent", () => {
    const meters = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 1 } },
    });
    expect(meters[0]).toMatchObject({ label: "5-hour limit", percent: 1 });
  });

  it("does not create a Claude meter when utilization is unknown", () => {
    expect(parseClaudeUsage({ five_hour: { utilization: null } })).toEqual([]);
  });

  it("parses xAI grok billing config", () => {
    const meters = parseXaiBilling({
      config: {
        creditUsagePercent: 12,
        currentPeriod: { type: "weekly", end: new Date(Date.now() + 4 * 86400_000).toISOString() },
      },
    });
    expect(meters[0]).toMatchObject({ label: "Weekly limit", percent: 12 });
  });

  it("does not invent xAI usage when only /me succeeds", async () => {
    const quota = await reconcileUsageQuota("xai", "tok", async (url) => {
      if (String(url).includes("/v1/me")) return new Response(JSON.stringify({ id: "user" }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    expect(quota?.meters).toEqual([]);
    expect(quota?.limited).toBe(false);
  });
});

describe("settingsPage", () => {
  it("renders account email, plan, and quota percent", () => {
    const html = settingsPage(
      [
        {
          id: "anthropic",
          label: "Claude",
          envKey: "ANTHROPIC_API_KEY",
          login: true,
          envSet: false,
          email: "pro-user@example.com",
          plan: "Pro",
          quota: {
            limited: false,
            status: 200,
            at: 1,
            meters: [{ label: "5-hour limit", used: 35, limit: 100, remaining: 65, percent: 35, unit: "percent", state: "observed" }],
          },
        },
      ],
      true,
    );
    expect(html).toContain("claude-pro-user@example.com");
    expect(html).toContain("Plan Pro");
    expect(html).toContain("35%");
    expect(html).toContain("Refresh quota");
    expect(html).not.toContain("sk-secret");
  });

  it("renders one card per credential and an add-account link", () => {
    const html = settingsPage(
      [
        {
          id: "anthropic",
          label: "Claude",
          envKey: "ANTHROPIC_API_KEY",
          login: true,
          envSet: false,
          email: "one@example.com",
          plan: "Pro",
        },
        {
          id: "anthropic",
          label: "Claude",
          envKey: "ANTHROPIC_API_KEY",
          login: true,
          envSet: false,
          email: "two@example.com",
          plan: "Max",
        },
      ],
      true,
    );
    expect(html).toContain("claude-one@example.com");
    expect(html).toContain("claude-two@example.com");
    expect(html).toContain('href="/connect/anthropic"');
    expect(html).toContain("Add account");
  });

  it("labels extras without email by truncated account id", () => {
    const html = settingsPage(
      [
        {
          id: "anthropic",
          accountId: "abcdef12-9999-0000-0000-000000000000",
          label: "Claude",
          envKey: "ANTHROPIC_API_KEY",
          login: true,
          envSet: false,
        },
      ],
      true,
    );
    expect(html).toContain("claude-extra-abcdef12");
  });

  it("labels an unobserved quota without fabricating zero usage", () => {
    const html = settingsPage(
      [{
        id: "openai",
        label: "Codex",
        envKey: "OPENAI_API_KEY",
        login: true,
        envSet: false,
        quota: {
          limited: false,
          status: 200,
          at: 1,
          meters: [{ label: "5-hour limit", used: 0, limit: 100, remaining: 100, percent: 0, unit: "percent", state: "unknown" }],
        },
      }],
      true,
    );
    expect(html).toContain("Unknown");
    expect(html).not.toContain("0 / 100 remaining");
  });
});
