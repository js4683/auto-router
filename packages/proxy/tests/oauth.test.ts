import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listProviderAccounts } from "../src/accounts.js";
import { refreshAccountToken, refreshOAuthToken, startOAuth } from "../src/oauth.js";

describe("startOAuth", () => {
  it("builds a Claude Pro/Max authorize URL", async () => {
    const started = await startOAuth("anthropic");
    expect("error" in started).toBe(false);
    if ("error" in started) return;
    expect(started.method).toBe("code");
    expect(started.url).toContain("https://claude.ai/oauth/authorize");
    expect(started.url).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  it("builds an Antigravity Google-login URL", async () => {
    const previous = process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
    try {
      const started = await startOAuth("google");
      expect("error" in started).toBe(false);
      if ("error" in started) return;
      expect(started.method).toBe("code");
      expect(started.url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
      expect(started.url).toContain("antigravity.google");
      expect(started.url).toContain("test-google-client.apps.googleusercontent.com");
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = previous;
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
});
