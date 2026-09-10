import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonStore, updateJsonStore } from "./secure-json-store.js";

export function defaultAuthPath(): string {
  return join(homedir(), ".local/share/opencode/auth.json");
}

export function readAuthFile(path: string): Record<string, unknown> {
  return readJsonStore(path, (value): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth file is malformed");
    return value as Record<string, unknown>;
  }) ?? {};
}

export function writeAuthEntry(path: string, provider: string, entry: Record<string, unknown>): void {
  updateJsonStore(path, {}, (value): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth file is malformed");
    return value as Record<string, unknown>;
  }, (current) => ({ ...current, [provider]: entry }));
}
