import type { IncomingMessage } from "node:http";

export interface AttemptRecord {
  provider: string;
  runtimeModelId: string;
  accountId?: string;
  status?: number;
}

export interface FinalResult {
  terminalState: "completed" | "incomplete" | "failed";
  status: number;
  runtimeModelId?: string;
}

export interface ProxyRequestContext {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly attempts: readonly AttemptRecord[];
  readonly finalState?: FinalResult;
  remainingMs(): number;
  recordAttempt(attempt: AttemptRecord): number;
  updateAttempt(index: number, status: number): void;
  finalize(result: FinalResult): void;
}

export async function writeWithBackpressure(res: any, chunk: string | Buffer): Promise<boolean> {
  if (res.destroyed) return false;
  const accepted = res.write(chunk);
  if (accepted !== false || typeof res.once !== "function") return !res.destroyed;
  return new Promise((resolve) => {
    const done = () => {
      res.removeListener?.("drain", done);
      res.removeListener?.("close", done);
      resolve(!res.destroyed);
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

export function createProxyRequestContext(options: {
  timeoutMs: number;
  now?: () => number;
  request?: Pick<IncomingMessage, "on">;
}): ProxyRequestContext {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error("request timeout must be positive");
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const deadlineAt = startedAt + options.timeoutMs;
  const controller = new AbortController();
  const attempts: AttemptRecord[] = [];
  let finalState: FinalResult | undefined;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  options.request?.on("aborted", abort);
  options.request?.on("error", abort);
  const timer = setTimeout(abort, options.timeoutMs);
  timer.unref?.();

  return {
    startedAt,
    deadlineAt,
    signal: controller.signal,
    get attempts() {
      return attempts.slice();
    },
    get finalState() {
      return finalState;
    },
    remainingMs() {
      return Math.max(0, deadlineAt - now());
    },
    recordAttempt(attempt) {
      if (finalState) return -1;
      attempts.push({ ...attempt });
      return attempts.length - 1;
    },
    updateAttempt(index, status) {
      if (finalState || !attempts[index]) return;
      attempts[index] = { ...attempts[index], status };
    },
    finalize(result) {
      if (finalState) return;
      finalState = { ...result };
      clearTimeout(timer);
    },
  };
}
