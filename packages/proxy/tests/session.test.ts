import { describe, expect, it } from "vitest";
import { resolveSessionIdentity, memorySessions } from "../src/session.js";

function request(headers: Record<string, string> = {}) {
  return { headers } as any;
}

describe("session identity", () => {
  it("uses an explicit header without deriving identity from message text", () => {
    expect(resolveSessionIdentity(request({ "x-session-id": "client-1" }), { messages: [{ role: "user", content: "same greeting" }] }))
      .toEqual({ id: "client-1", stable: true, source: "header" });
  });

  it("uses a Responses continuation identifier", () => {
    expect(resolveSessionIdentity(request(), { previous_response_id: "resp-1" }))
      .toEqual({ id: "resp-1", stable: true, source: "continuation" });
  });

  it("generates a fresh opaque identity for headerless requests", () => {
    const first = resolveSessionIdentity(request(), { messages: [{ role: "user", content: "same greeting" }] });
    const second = resolveSessionIdentity(request(), { messages: [{ role: "user", content: "same greeting" }] });

    expect(first.stable).toBe(false);
    expect(first.source).toBe("opaque");
    expect(first.id).toMatch(/^request:/);
    expect(first.id).not.toBe(second.id);
  });
});

describe("bounded session store", () => {
  it("expires idle entries and evicts the least recently used entry", () => {
    let now = 0;
    const store = memorySessions({ maxEntries: 2, idleTtlMs: 10, now: () => now });

    store.set("a", { taskTarget: "model-a" });
    store.set("b", { taskTarget: "model-b" });
    expect(store.get("a").taskTarget).toBe("model-a");
    store.set("c", { taskTarget: "model-c" });
    expect(store.get("b").taskTarget).toBeNull();

    now = 11;
    expect(store.get("a").taskTarget).toBeNull();
  });

  it("serializes concurrent operations for one session", async () => {
    const store = memorySessions();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.runExclusive("session", async () => {
      events.push("first-start");
      await firstBlocked;
      events.push("first-end");
    });
    const second = store.runExclusive("session", async () => {
      events.push("second");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first-start"]);
    releaseFirst!();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});
