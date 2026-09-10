import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_CONFLICT_RETRIES = 3;
const MAX_LOCK_RETRIES = 20;
const LOCK_WAIT_MS = 5;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

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

function sleepSync(milliseconds: number): void {
  Atomics.wait(LOCK_SLEEP, 0, 0, milliseconds);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "EEXIST");
}

function lockOwner(lockPath: string): { raw: string; pid: number } | undefined {
  try {
    const raw = readFileSync(join(lockPath, "owner"), "utf8").trim();
    const pid = Number(raw.split(":", 1)[0]);
    return Number.isInteger(pid) && pid > 0 ? { raw, pid } : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    return undefined;
  }
}

function acquireStoreLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(join(lockPath, "owner"), `${owner}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => {
        if (lockOwner(lockPath)?.raw !== owner) return;
        rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // A stale-lock delete can race with a new owner; fail closed instead.
      sleepSync(LOCK_WAIT_MS);
    }
  }
  throw new ConcurrentStoreUpdateError(path);
}

function withStoreLock<T>(path: string, operation: () => T): T {
  const release = acquireStoreLock(path);
  try {
    return operation();
  } finally {
    release();
  }
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
  withStoreLock(path, () => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`));
}

export function updateJsonStore<T>(
  path: string,
  initial: T,
  parse: (value: unknown) => T,
  mutate: (value: T) => T,
): T {
  let conflict: ConcurrentStoreUpdateError | undefined;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    try {
      return withStoreLock(path, () => {
        const original = readBytes(path);
        const current = original === undefined ? initial : parseBytes(path, original, parse);
        const next = mutate(current);
        writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, original, true);
        return next;
      });
    } catch (error) {
      if (!(error instanceof ConcurrentStoreUpdateError)) throw error;
      conflict = error;
    }
  }
  throw conflict ?? new ConcurrentStoreUpdateError(path);
}

export function writeAtomicText(path: string, body: string): void {
  withStoreLock(path, () => writeAtomic(path, body));
}
