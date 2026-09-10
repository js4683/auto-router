import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createProxyRequestContext, writeWithBackpressure } from "../src/request-context.js";

describe("proxy request context", () => {
  it("tracks a monotonic deadline and keeps the first final result", () => {
    let now = 0;
    const context = createProxyRequestContext({ timeoutMs: 25, now: () => now });

    expect(context.startedAt).toBe(0);
    expect(context.deadlineAt).toBe(25);
    now = 10;
    expect(context.remainingMs()).toBe(15);

    context.finalize({ terminalState: "failed", status: 504, runtimeModelId: "openai/slow" });
    context.finalize({ terminalState: "completed", status: 200, runtimeModelId: "openai/fast" });
    expect(context.finalState).toEqual({ terminalState: "failed", status: 504, runtimeModelId: "openai/slow" });
  });

  it("aborts on request failure but not normal completion", () => {
    const request = new EventEmitter();
    const context = createProxyRequestContext({ timeoutMs: 100, request: request as never });

    expect(context.signal.aborted).toBe(false);
    request.emit("close");
    expect(context.signal.aborted).toBe(false);
    request.emit("aborted");
    expect(context.signal.aborted).toBe(true);
  });

  it("records attempts in order", () => {
    const context = createProxyRequestContext({ timeoutMs: 100 });
    const first = context.recordAttempt({ provider: "openai", runtimeModelId: "openai/one" });
    context.updateAttempt(first, 429);
    context.recordAttempt({ provider: "anthropic", runtimeModelId: "anthropic/two", accountId: "account-2", status: 200 });

    expect(context.attempts).toEqual([
      { provider: "openai", runtimeModelId: "openai/one", status: 429 },
      { provider: "anthropic", runtimeModelId: "anthropic/two", accountId: "account-2", status: 200 },
    ]);
  });

  it("waits for drain when a response applies backpressure", async () => {
    const response = new EventEmitter() as any;
    response.destroyed = false;
    response.write = () => false;

    let settled = false;
    const write = writeWithBackpressure(response, "chunk").then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    response.emit("drain");
    await expect(write).resolves.toBe(true);
  });
});
