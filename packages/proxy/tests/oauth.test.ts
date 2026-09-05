import { describe, expect, it } from "vitest";
import { startOAuth } from "../src/oauth.js";

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
