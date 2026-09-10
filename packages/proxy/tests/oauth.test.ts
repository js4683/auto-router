import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listProviderAccounts } from "../src/accounts.js";
import { completeOAuthCode, ensureGoogleProject, refreshAccountToken, refreshOAuthToken, startOAuth } from "../src/oauth.js";

const claudeCodeOauth = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));

vi.mock("../src/claude-code-auth.js", () => ({
  readClaudeCodeOauth: claudeCodeOauth.read,
  writeClaudeCodeOauth: claudeCodeOauth.write,
}));

describe("startOAuth", () => {
  it("persists pending login state with restrictive permissions and consumes it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-oauth-state-"));
    const authPath = join(dir, "auth.json");
    const statePath = join(dir, "pending.json");
    const started = await startOAuth("opencode", { statePath });

    expect("error" in started).toBe(false);
    if ("error" in started) return;
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    await expect(completeOAuthCode(started.id, "zen-key", authPath, undefined, { statePath })).resolves.toEqual({ done: true });
    await expect(completeOAuthCode(started.id, "zen-key", authPath, undefined, { statePath })).resolves.toMatchObject({ error: expect.stringMatching(/expired|used/) });
  });

  it("builds a Claude Pro/Max authorize URL", async () => {
    const started = await startOAuth("anthropic");
    expect("error" in started).toBe(false);
    if ("error" in started) return;
    expect(started.method).toBe("code");
    expect(started.url).toContain("https://claude.ai/oauth/authorize");
    expect(started.url).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  it("builds an Antigravity Google-login URL from configured client settings", async () => {
    const previousId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id";
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    try {
      const started = await startOAuth("google");
      expect("error" in started).toBe(false);
      if ("error" in started) return;
      expect(started.method).toBe("code");
      expect(started.url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
      expect(started.url).toContain("antigravity.google");
      const url = new URL(started.url);
      expect(url.searchParams.get("client_id")).toBe("test-google-client-id");
      expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cclog");
      expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/experimentsandconfigs");
      expect(url.searchParams.get("scope")).toContain("openid");
    } finally {
      if (previousId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = previousId;
      if (previousSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previousSecret;
    }
  });

  it("requires Google OAuth client configuration", async () => {
    const previousId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    try {
      await expect(startOAuth("google")).resolves.toEqual({ error: "Google OAuth requires GOOGLE_OAUTH_CLIENT_ID" });
    } finally {
      if (previousId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = previousId;
      if (previousSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previousSecret;
    }
  });

  it("exchanges an Antigravity code with configured OAuth client settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-antigravity-login-"));
    const authPath = join(dir, "auth.json");
    const previousId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const previousFetch = globalThis.fetch;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-google-client-secret";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        const body = String(init?.body ?? "");
        expect(body).toContain("client_id=test-google-client-id");
        expect(body).toContain("client_secret=test-google-client-secret");
        return new Response(JSON.stringify({ access_token: "antigravity-access", refresh_token: "antigravity-refresh", expires_in: 3600 }));
      }
      if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist") {
        expect(JSON.parse(String(init?.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
        return new Response(JSON.stringify({ cloudaicompanionProject: "antigravity-project" }));
      }
      throw new Error(`unexpected request: ${url}`);
    };
    try {
      const started = await startOAuth("google");
      expect("error" in started).toBe(false);
      if ("error" in started) return;
      const result = await completeOAuthCode(started.id, "authorization-code", authPath);
      expect(result).toEqual({ done: true });
      expect(JSON.parse(readFileSync(authPath, "utf8")).google).toMatchObject({
        type: "oauth",
        access: "antigravity-access",
        refresh: "antigravity-refresh",
        projectId: "antigravity-project",
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = previousId;
      if (previousSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previousSecret;
    }
  });

  it("does not persist a Google login when the token response has no access token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-antigravity-invalid-token-"));
    const authPath = join(dir, "auth.json");
    const previousId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const previousFetch = globalThis.fetch;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id";
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    globalThis.fetch = async (input) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      return new Response(JSON.stringify({ error: "invalid_grant" }));
    };
    try {
      const started = await startOAuth("google");
      expect("error" in started).toBe(false);
      if ("error" in started) return;
      await expect(completeOAuthCode(started.id, "authorization-code", authPath)).resolves.toEqual({
        error: "Gemini login failed",
      });
      expect(existsSync(authPath)).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = previousId;
      if (previousSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previousSecret;
    }
  });

  it("uses Antigravity metadata and daily onboarding for a missing project", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls += 1;
      if (calls === 1) {
        expect(url).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
        expect(JSON.parse(String(init?.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
        return new Response(JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }));
      }
      expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        tier_id: "free-tier",
        metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity" },
      });
      return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: "new-project" } } }));
    };
    try {
      await expect(ensureGoogleProject("access-token")).resolves.toBe("new-project");
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("opens OpenCode Zen auth for a paste-key login", async () => {
    const started = await startOAuth("opencode");
    expect("error" in started).toBe(false);
    if ("error" in started) return;
    expect(started.method).toBe("code");
    expect(started.url).toBe("https://opencode.ai/auth");
  });
});

describe("refreshOAuthToken", () => {
  it("refreshes an expired Antigravity token with Google OAuth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-refresh-google-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ google: { type: "oauth", access: "old-google", refresh: "google-refresh", expires: Date.now() - 1000 } }),
    );
    const previous = process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
    try {
      const next = await refreshOAuthToken("google", authPath, async (url, init) => {
        expect(url).toBe("https://oauth2.googleapis.com/token");
        expect(String(init?.body)).toContain("refresh_token=google-refresh");
        expect(String(init?.body)).toContain("client_id=google-client-id");
        return new Response(JSON.stringify({ access_token: "new-google", refresh_token: "new-google-refresh", expires_in: 3600 }));
      });
      expect(next).toBe("new-google");
      expect(JSON.parse(readFileSync(authPath, "utf8")).google).toMatchObject({ access: "new-google", refresh: "new-google-refresh" });
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = previous;
    }
  });

  it("refreshes an expired Claude token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-refresh-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "oauth", access: "old-access", refresh: "refresh-secret", expires: Date.now() - 1000 } }),
    );
    const next = await refreshOAuthToken("anthropic", authPath, async (_url, init) => {
      expect(String(init?.body)).toContain("refresh-secret");
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    });
    expect(next).toBe("new-access");
    const saved = JSON.parse(readFileSync(authPath, "utf8"));
    expect(saved.anthropic.access).toBe("new-access");
    expect(saved.anthropic.refresh).toBe("new-refresh");
  });

  it("skips refresh when the access token is still valid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-refresh-ok-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ openai: { type: "oauth", access: "live-access", refresh: "refresh-secret", expires: Date.now() + 3_600_000 } }),
    );
    let calls = 0;
    const next = await refreshOAuthToken("openai", authPath, async () => {
      calls += 1;
      throw new Error("should not refresh");
    });
    expect(next).toBe("live-access");
    expect(calls).toBe(0);
  });
});

describe("refreshAccountToken", () => {
  it("refreshes an auth-file account without using Claude Code credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-refresh-auth-source-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "oauth", access: "auth-access", refresh: "auth-refresh", expires: Date.now() - 1000 } }),
    );
    claudeCodeOauth.read.mockReturnValue({ access: "keychain-access", refresh: "keychain-refresh", expires: Date.now() - 1000 });
    try {
      const next = await refreshAccountToken(
        {
          id: "anthropic:primary",
          provider: "anthropic",
          token: "auth-access",
          type: "oauth",
          expires: Date.now() - 1000,
          refresh: "auth-refresh",
          primary: true,
          source: "auth",
        },
        {
          authPath,
          fetchImpl: async (_url, init) => {
            expect(String(init?.body)).toContain("auth-refresh");
            expect(String(init?.body)).not.toContain("keychain-refresh");
            return new Response(JSON.stringify({ access_token: "auth-new", refresh_token: "auth-new-refresh", expires_in: 3600 }));
          },
        },
      );

      expect(next).toBe("auth-new");
      expect(claudeCodeOauth.write).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(authPath, "utf8")).anthropic).toMatchObject({ access: "auth-new", refresh: "auth-new-refresh" });
    } finally {
      claudeCodeOauth.read.mockReset();
      claudeCodeOauth.write.mockReset();
    }
  });

  it("refreshes an expired extra account without touching primary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-refresh-extra-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(
      authPath,
      JSON.stringify({ openai: { type: "oauth", access: "primary-access", refresh: "primary-refresh", expires: Date.now() + 3_600_000 } }),
    );
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [{ id: "extra-1", provider: "openai", type: "oauth", access: "old-extra", refresh: "extra-refresh", expires: Date.now() - 1000 }],
      }),
    );
    const extra = listProviderAccounts("openai", { env: {}, authPath, accountsPath }).find((account) => account.id === "extra-1");
    expect(extra).toBeTruthy();
    const next = await refreshAccountToken(extra!, {
      authPath,
      accountsPath,
      fetchImpl: async (_url, init) => {
        expect(String(init?.body)).toContain("extra-refresh");
        return new Response(JSON.stringify({ access_token: "new-extra", refresh_token: "new-extra-refresh", expires_in: 3600 }));
      },
    });
    expect(next).toBe("new-extra");
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.access).toBe("primary-access");
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts[0]).toMatchObject({
      access: "new-extra",
      refresh: "new-extra-refresh",
    });
  });

  it("refreshes an extra-only oauth login into accounts.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-refresh-only-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, "{}");
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [{ id: "extra-only", provider: "openai", type: "oauth", access: "old-only", refresh: "only-refresh", expires: Date.now() - 1000 }],
      }),
    );
    const extra = listProviderAccounts("openai", { env: {}, authPath, accountsPath })[0];
    expect(extra).toBeTruthy();
    const next = await refreshAccountToken(extra!, {
      authPath,
      accountsPath,
      fetchImpl: async () => new Response(JSON.stringify({ access_token: "new-only", refresh_token: "new-only-refresh", expires_in: 3600 })),
    });
    expect(next).toBe("new-only");
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai).toBeUndefined();
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts[0].access).toBe("new-only");
  });

  it("single-flights concurrent refreshes for one source key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-refresh-single-flight-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, "{}");
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [{ id: "single-flight", provider: "openai", type: "oauth", access: "old", refresh: "refresh", expires: Date.now() - 1000 }],
      }),
    );
    const account = listProviderAccounts("openai", { env: {}, authPath, accountsPath })[0];
    expect(account).toBeTruthy();
    let calls = 0;
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = async () => {
      calls += 1;
      return response;
    };

    const first = refreshAccountToken(account!, { authPath, accountsPath, fetchImpl });
    const second = refreshAccountToken(account!, { authPath, accountsPath, fetchImpl });
    expect(calls).toBe(1);
    release(new Response(JSON.stringify({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 })));

    await expect(Promise.all([first, second])).resolves.toEqual(["new", "new"]);
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts[0].access).toBe("new");
  });
});
