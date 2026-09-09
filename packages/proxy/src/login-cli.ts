import { createInterface } from "node:readline/promises";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import { defaultAccountsPath } from "./accounts.js";
import { defaultAuthPath } from "./auth-store.js";
import { loginProviderId } from "./login.js";
import { completeOAuthCode, pollOAuth, startOAuth, type OAuthStart } from "./oauth.js";

const ALIASES: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  grok: "xai",
  zen: "opencode",
  gemini: "google",
  antigravity: "google",
};

const USAGE = "help: auto-router login <claude|codex|grok|zen|gemini|antigravity> [--code <auth-code> --id <session-id>]";

export interface LoginCliDeps {
  startOAuth: (provider: string) => Promise<OAuthStart>;
  pollOAuth: (id: string, authPath: string, accountsPath?: string) => Promise<{ done?: boolean; error?: string }>;
  completeOAuthCode: (id: string, code: string, authPath: string, accountsPath?: string) => Promise<{ done?: boolean; error?: string }>;
  authPath: string;
  accountsPath: string;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  readCode?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

function parseLoginArgs(args: string[]): { provider?: string; code?: string; id?: string; help?: boolean; error?: string } {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  let provider: string | undefined;
  let code: string | undefined;
  let id: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--code" || arg === "--id") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return { error: `error: ${arg} requires a value\n${USAGE}\n` };
      if (arg === "--code") code = value;
      else id = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return { error: `error: unknown flag ${arg}\n${USAGE}\n` };
    if (provider) return { error: `error: unexpected argument ${arg}\n${USAGE}\n` };
    provider = arg;
  }
  return { provider, code, id };
}

function connected(provider: string): string {
  return `login:\n  provider: ${provider}\n  status: connected\n`;
}

const DEVICE_POLL_ATTEMPTS = 40;

async function pollUntilDone(id: string, provider: string, deps: LoginCliDeps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < DEVICE_POLL_ATTEMPTS; attempt += 1) {
    const result = await deps.pollOAuth(id, deps.authPath, deps.accountsPath);
    if (result.done) {
      deps.stdout.write(connected(provider));
      return 0;
    }
    if (result.error) {
      deps.stdout.write(`error: ${result.error}\n${USAGE}\n`);
      return 1;
    }
    await sleep(3000);
  }
  deps.stdout.write(`error: login timed out\n${USAGE}\n`);
  return 1;
}

export async function runLogin(args: string[], deps: LoginCliDeps): Promise<number> {
  const parsed = parseLoginArgs(args);
  if (parsed.help) {
    deps.stdout.write(`usage: auto-router login <claude|codex|grok|zen|gemini|antigravity> [--code <auth-code> --id <session-id>]\n${USAGE}\n`);
    return 0;
  }
  if (parsed.error) {
    deps.stdout.write(parsed.error);
    return 2;
  }
  if (!parsed.provider) {
    deps.stdout.write(`error: provider required\n${USAGE}\n`);
    return 2;
  }
  const provider = ALIASES[parsed.provider] ?? parsed.provider;
  if (!loginProviderId(provider)) {
    deps.stdout.write(`error: unknown provider ${parsed.provider}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.code) {
    if (!parsed.id) {
      deps.stdout.write(`error: --id is required with --code\n${USAGE}\n`);
      return 2;
    }
    const result = await deps.completeOAuthCode(parsed.id, parsed.code.trim(), deps.authPath, deps.accountsPath);
    if (!result.done) {
      deps.stdout.write(`error: ${result.error ?? "login failed"}\n${USAGE}\n`);
      return 1;
    }
    deps.stdout.write(connected(provider));
    return 0;
  }
  const started = await deps.startOAuth(provider);
  if ("error" in started) {
    deps.stdout.write(`error: ${started.error}\n${USAGE}\n`);
    return 1;
  }
  deps.stderr.write(`Open ${started.url}\n`);
  if (started.method === "device") {
    deps.stderr.write(`Code: ${started.user_code}\n`);
    return pollUntilDone(started.id, provider, deps);
  }
  deps.stderr.write(`id: ${started.id}\n`);
  const pasted = ((await deps.readCode?.()) ?? "").trim();
  if (!pasted) {
    deps.stdout.write(`error: --code is required\n${USAGE}\n`);
    return 2;
  }
  const result = await deps.completeOAuthCode(started.id, pasted, deps.authPath, deps.accountsPath);
  if (!result.done) {
    deps.stdout.write(`error: ${result.error ?? "login failed"}\n${USAGE}\n`);
    return 1;
  }
  deps.stdout.write(connected(provider));
  return 0;
}

async function readStdinCode(): Promise<string> {
  if (!stdinStream.isTTY) return "";
  const rl = createInterface({ input: stdinStream, output: stdoutStream });
  try {
    return await rl.question("Authorization code: ");
  } finally {
    rl.close();
  }
}

export async function mainLogin(args = process.argv.slice(3)): Promise<number> {
  return runLogin(args, {
    startOAuth,
    pollOAuth,
    completeOAuthCode,
    authPath: defaultAuthPath(),
    accountsPath: defaultAccountsPath(),
    stdout: process.stdout,
    stderr: process.stderr,
    readCode: readStdinCode,
  });
}
