import { randomUUID } from "node:crypto";
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

const MAX_CONFLICT_RETRIES = 3;

export class JsonStoreCorruptionError extends Error {
  readonly code = "ERR_JSON_STORE_CORRUPT";

  constructor(path: string, detail: string, cause?: unknown) {
    super(`${path} ${detail}`, { cause });
    this.name = "JsonStoreCorruptionError";
  }
}

export class ConcurrentStoreUpdateError extends Error {
  readonly code = "ERR_JSON_STORE_CONFLICT";

  constructor(path: string) {
    super(`concurrent update conflict for ${path}`);
    this.name = "ConcurrentStoreUpdateError";
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sameBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (!left || !right) return left === right;
  return left.equals(right);
}

function parseBytes<T>(path: string, bytes: Buffer, parse: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new JsonStoreCorruptionError(path, "is not valid JSON", error);
  }
  try {
    return parse(value);
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "contains invalid data";
    throw new JsonStoreCorruptionError(path, detail, error);
  }
}

function writeAtomic(path: string, body: string, expected?: Buffer, verifyExpected = false): void {
  if (verifyExpected && !sameBytes(readBytes(path), expected)) throw new ConcurrentStoreUpdateError(path);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, body, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export function readJsonStore<T>(path: string, parse: (value: unknown) => T): T | undefined {
  const bytes = readBytes(path);
  return bytes === undefined ? undefined : parseBytes(path, bytes, parse);
}

export function writeJsonStore<T>(path: string, value: T): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function updateJsonStore<T>(
  path: string,
  initial: T,
  parse: (value: unknown) => T,
  mutate: (value: T) => T,
): T {
  let conflict: ConcurrentStoreUpdateError | undefined;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    const original = readBytes(path);
    const current = original === undefined ? initial : parseBytes(path, original, parse);
    const next = mutate(current);
    try {
      writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, original, true);
      return next;
    } catch (error) {
      if (!(error instanceof ConcurrentStoreUpdateError)) throw error;
      conflict = error;
    }
  }
  throw conflict ?? new ConcurrentStoreUpdateError(path);
}

export function writeAtomicText(path: string, body: string): void {
  writeAtomic(path, body);
}
