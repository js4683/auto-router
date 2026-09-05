import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultAuthPath(): string {
  return join(homedir(), ".local/share/opencode/auth.json");
}

export function readAuthFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  return {};
}

export function writeAuthEntry(path: string, provider: string, entry: Record<string, unknown>): void {
  const current = readAuthFile(path);
  current[provider] = entry;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}
