import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface InstallStateTarget {
  beforeBase64: string | null;
  beforeDigest: string | null;
  installedDigest: string;
  ownedKeys: string[];
  ownedValues?: Record<string, string>;
}

export interface InstallState {
  schemaVersion: 1;
  targets: Record<string, InstallStateTarget>;
}

export function digestText(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function isStateTarget(value: unknown): value is InstallStateTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (target.beforeBase64 === null || typeof target.beforeBase64 === "string")
    && (target.beforeDigest === null || typeof target.beforeDigest === "string")
    && typeof target.installedDigest === "string"
    && Array.isArray(target.ownedKeys)
    && target.ownedKeys.every((key) => typeof key === "string")
    && (target.ownedValues === undefined
      || (!target.ownedValues || typeof target.ownedValues !== "object" || Array.isArray(target.ownedValues)
        ? false
        : Object.values(target.ownedValues).every((value) => typeof value === "string")));
}

function parseState(value: unknown): InstallState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("install state is malformed");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !record.targets || typeof record.targets !== "object" || Array.isArray(record.targets)) {
    throw new Error("install state is malformed");
  }
  for (const target of Object.values(record.targets)) {
    if (!isStateTarget(target)) throw new Error("install state contains an invalid target");
  }
  return record as unknown as InstallState;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

export function readInstallState(path: string): InstallState | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    return parseState(JSON.parse(text));
  } catch (error) {
    if (error instanceof Error && error.message === "install state is malformed") throw error;
    throw new Error("install state is not valid JSON", { cause: error });
  }
}

export function atomicWriteText(path: string, body: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, body, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export function writeInstallState(path: string, state: InstallState): void {
  atomicWriteText(path, `${JSON.stringify(state, null, 2)}\n`);
}
