import { describe, expect, it } from "vitest";
import { runLogin } from "../src/login-cli.js";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
      },
    },
    get out() {
      return stdout;
    },
    get err() {
      return stderr;
    },
  };
}

describe("runLogin", () => {
  it("rejects unknown providers with usage help", async () => {
    const io = capture();
    const code = await runLogin(["cursor"], {
      startOAuth: async () => ({ error: "should not start" }),
      pollOAuth: async () => ({}),
      completeOAuthCode: async () => ({}),
      authPath: "/tmp/auth.json",
      accountsPath: "/tmp/accounts.json",
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.out).toContain("error: unknown provider cursor");
    expect(io.out).toContain("login <claude|codex|grok|zen|gemini>");
  });

  it("polls a device login until connected", async () => {
    const io = capture();
    let polls = 0;
    const code = await runLogin(["codex"], {
      startOAuth: async (provider) => {
        expect(provider).toBe("openai");
        return { id: "sess-1", url: "https://auth.openai.com/codex/device", method: "device", user_code: "ABCD-1234" };
      },
      pollOAuth: async (id) => {
        expect(id).toBe("sess-1");
        polls += 1;
        return polls < 2 ? {} : { done: true };
      },
      completeOAuthCode: async () => ({ error: "should not complete" }),
      authPath: "/tmp/auth.json",
      accountsPath: "/tmp/accounts.json",
      stdout: io.stdout,
      stderr: io.stderr,
      sleep: async () => undefined,
    });
    expect(code).toBe(0);
    expect(polls).toBe(2);
    expect(io.err).toContain("ABCD-1234");
    expect(io.err).toContain("https://auth.openai.com/codex/device");
    expect(io.out).toContain("status: connected");
    expect(io.out).toContain("provider: openai");
  });

  it("completes a code login with --code and --id without starting a new session", async () => {
    const io = capture();
    let started = 0;
    const code = await runLogin(["claude", "--code", "auth-code-1", "--id", "sess-2"], {
      startOAuth: async () => {
        started += 1;
        return { error: "should not start" };
      },
      pollOAuth: async () => ({ error: "should not poll" }),
      completeOAuthCode: async (id, pasted, authPath, accountsPath) => {
        expect(id).toBe("sess-2");
        expect(pasted).toBe("auth-code-1");
        expect(authPath).toBe("/tmp/auth.json");
        expect(accountsPath).toBe("/tmp/accounts.json");
        return { done: true };
      },
      authPath: "/tmp/auth.json",
      accountsPath: "/tmp/accounts.json",
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(started).toBe(0);
    expect(io.out).toContain("provider: anthropic");
    expect(io.out).toContain("status: connected");
  });

  it("stops polling a device login after the attempt budget", async () => {
    const io = capture();
    let polls = 0;
    const code = await runLogin(["codex"], {
      startOAuth: async () => ({ id: "sess-timeout", url: "https://auth.openai.com/codex/device", method: "device", user_code: "WAIT-1" }),
      pollOAuth: async () => {
        polls += 1;
        return {};
      },
      completeOAuthCode: async () => ({}),
      authPath: "/tmp/auth.json",
      accountsPath: "/tmp/accounts.json",
      stdout: io.stdout,
      stderr: io.stderr,
      sleep: async () => undefined,
    });
    expect(code).toBe(1);
    expect(polls).toBe(40);
    expect(io.out).toContain("error: login timed out");
  });

  it("rejects --code without --id", async () => {
    const io = capture();
    const code = await runLogin(["claude", "--code", "auth-code-1"], {
      startOAuth: async () => ({ error: "should not start" }),
      pollOAuth: async () => ({}),
      completeOAuthCode: async () => ({}),
      authPath: "/tmp/auth.json",
      accountsPath: "/tmp/accounts.json",
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2);
    expect(io.out).toContain("error: --id is required with --code");
  });
});
