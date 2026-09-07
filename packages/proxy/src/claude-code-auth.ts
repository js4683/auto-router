import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const FILE_PATHS = [join(homedir(), ".claude/.credentials.json"), join(homedir(), ".config/claude/.credentials.json")];

export interface ClaudeCodeOauth {
  access: string;
  refresh?: string;
  expires?: number;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function parseClaudeCodeOauth(parsed: unknown): ClaudeCodeOauth | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return undefined;
  const record = oauth as Record<string, unknown>;
  const access = stringField(record.accessToken);
  if (!access) return undefined;
  const expires = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
  return { access, refresh: stringField(record.refreshToken), expires };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readKeychain(): unknown {
  if (process.platform !== "darwin") return undefined;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function readClaudeCodeOauth(): ClaudeCodeOauth | undefined {
  if (process.env.VITEST) return undefined;
  const fromKeychain = parseClaudeCodeOauth(readKeychain());
  if (fromKeychain) return fromKeychain;
  for (const path of FILE_PATHS) {
    const parsed = parseClaudeCodeOauth(readJson(path));
    if (parsed) return parsed;
  }
  return undefined;
}

function mergeOauth(parsed: unknown, next: ClaudeCodeOauth): string {
  const root = parsed && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {};
  const current = root.claudeAiOauth && typeof root.claudeAiOauth === "object" ? { ...(root.claudeAiOauth as Record<string, unknown>) } : {};
  current.accessToken = next.access;
  if (next.refresh) current.refreshToken = next.refresh;
  if (next.expires) current.expiresAt = next.expires;
  root.claudeAiOauth = current;
  return `${JSON.stringify(root)}\n`;
}

export function writeClaudeCodeOauth(next: ClaudeCodeOauth): void {
  const existing = readKeychain();
  const body = mergeOauth(existing, next).trimEnd();
  if (process.platform === "darwin") {
    try {
      execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", process.env.USER || "claude", "-w", body], {
        stdio: "ignore",
      });
      return;
    } catch {}
  }
  const path = FILE_PATHS.find((item) => {
    try {
      readFileSync(item);
      return true;
    } catch {
      return false;
    }
  }) ?? FILE_PATHS[0];
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
}
