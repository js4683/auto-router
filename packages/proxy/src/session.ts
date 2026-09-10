import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface ProxySession {
  taskTarget: string | null;
  prevMessage?: string;
}

export interface SessionIdentity {
  id: string;
  stable: boolean;
  source: "header" | "continuation" | "opaque";
}

export interface ProxySessionStore {
  get(id: string): ProxySession;
  set(id: string, next: ProxySession): void;
  runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T>;
}

interface SessionEntry {
  session: ProxySession;
  lastUsedAt: number;
  order: number;
}

export interface MemorySessionOptions {
  maxEntries?: number;
  idleTtlMs?: number;
  now?: () => number;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed || undefined;
}

function objectValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function continuationValue(body: unknown): string | undefined {
  const directKeys = ["conversation_id", "conversationId"];
  for (const key of directKeys) {
    const value = objectValue(body, key);
    if (value) return value;
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const metadata = (body as Record<string, unknown>).metadata;
    const value = objectValue(metadata, "session_id");
    if (value) return value;
  }
  return objectValue(body, "previous_response_id");
}

export function resolveSessionIdentity(
  request: Pick<IncomingMessage, "headers">,
  body: unknown,
): SessionIdentity {
  const headers = request.headers ?? {};
  const header = headerValue(headers["x-session-id"]) ?? headerValue(headers["x-opencode-session"]);
  if (header) return { id: header, stable: true, source: "header" };

  const continuation = continuationValue(body);
  if (continuation) return { id: continuation, stable: true, source: "continuation" };

  return { id: `request:${randomUUID()}`, stable: false, source: "opaque" };
}

export function memorySessions(options: MemorySessionOptions = {}): ProxySessionStore {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000));
  const idleTtlMs = Math.max(0, options.idleTtlMs ?? 86_400_000);
  const now = options.now ?? Date.now;
  const store = new Map<string, SessionEntry>();
  const pending = new Map<string, Promise<void>>();
  let order = 0;

  function removeExpired(currentTime: number): void {
    for (const [id, entry] of store) {
      if (currentTime - entry.lastUsedAt >= idleTtlMs) store.delete(id);
    }
  }

  function retainLimit(): void {
    while (store.size > maxEntries) {
      const oldest = [...store.entries()].sort(([, left], [, right]) => left.order - right.order)[0];
      if (!oldest) return;
      store.delete(oldest[0]);
    }
  }

  return {
    get(id) {
      const currentTime = now();
      removeExpired(currentTime);
      const entry = store.get(id);
      if (!entry) return { taskTarget: null };
      entry.lastUsedAt = currentTime;
      entry.order = ++order;
      return entry.session;
    },
    set(id, next) {
      const currentTime = now();
      removeExpired(currentTime);
      store.set(id, { session: next, lastUsedAt: currentTime, order: ++order });
      retainLimit();
    },
    runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
      const previous = pending.get(id) ?? Promise.resolve();
      const queued = previous.catch(() => undefined).then(operation);
      const marker = queued.then(() => undefined, () => undefined);
      pending.set(id, marker);
      void marker.then(() => {
        if (pending.get(id) === marker) pending.delete(id);
      });
      return queued;
    },
  };
}
