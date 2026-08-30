import { describe, expect, it } from "vitest";
import { AutoRouterPlugin } from "../../../.opencode/plugins/auto-router.ts";

const providerData = {
  connected: ["opencode", "openai"],
  default: {
    opencode: "muse-spark-1.2-contributor-free",
    openai: "fable-latest",
  },
  all: [
    {
      id: "opencode",
      models: {
        "muse-spark-1.2-contributor-free": {
          id: "muse-spark-1.2-contributor-free",
          name: "Muse Spark 1.2 Free",
          cost: { input: 0, output: 0 },
          limit: { context: 1048576, output: 131072 },
          status: "active",
        },
      },
    },
    {
      id: "openai",
      models: {
        "fable-latest": {
          id: "fable-latest",
          name: "Fable",
          cost: { input: 2, output: 8 },
          limit: { context: 272000, output: 65536 },
          status: "active",
        },
      },
    },
  ],
};

function message(text: string) {
  return {
    message: { id: "message-1", sessionID: "session-1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "openai", modelID: "gpt-5.6-luna" } },
    parts: [{ id: "part-1", sessionID: "session-1", messageID: "message-1", type: "text", text }],
  };
}

describe("auto-router provider discovery", () => {
  it("defers provider lookup until the first routed message", async () => {
    let calls = 0;
    const client = {
      provider: { list: async () => { calls += 1; return { data: providerData }; } },
      app: { log: async () => {} },
    };
    const hooks = await AutoRouterPlugin({ client, directory: "/tmp/project" } as any);

    expect(calls).toBe(0);
    await hooks["chat.message"]!({ sessionID: "session-1" } as any, {} as any);
    expect(calls).toBe(1);
  });

  it("does not mutate unsupported chat parameter fields to switch models", async () => {
    const logs: string[] = [];
    const client = {
      provider: { list: async () => ({ data: providerData }) },
      app: { log: async ({ body }: any) => { logs.push(body.message); } },
    };
    const hooks = await AutoRouterPlugin({ client, directory: "/tmp/project" } as any);
    const output = { options: {} };
    await hooks["chat.message"]!({ sessionID: "session-2", agent: "build" } as any, message("fix typo") as any);

    await hooks["chat.params"]!({
      sessionID: "session-2",
      agent: "build",
      model: { id: "gpt-5.6-luna", providerID: "openai" },
      provider: { id: "openai" },
      message: { parts: [{ text: "fix typo" }] },
    } as any, output as any);

    expect(output).toEqual({ options: {} });
    expect(logs.some((entry) => entry.includes("[auto-router] TASK RECOMMEND"))).toBe(true);
  });

  it("selects once for follow-up messages in the same task", async () => {
    const logs: string[] = [];
    const client = {
      provider: { list: async () => ({ data: providerData }) },
      app: { log: async ({ body }: any) => { logs.push(body.message); } },
    };
    const hooks = await AutoRouterPlugin({ client, directory: "/tmp/project" } as any);

    await hooks["chat.message"]!({ sessionID: "session-follow-up", agent: "build" } as any, message("run no-mistakes") as any);
    await hooks["chat.message"]!({ sessionID: "session-follow-up", agent: "build" } as any, message("report the failures") as any);

    const decisions = logs.filter((entry) => entry.includes("[auto-router] TASK SELECT"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain("opencode/muse-spark-1.2-contributor-free");
  });

  it("selects again when an explicit tag starts a new task", async () => {
    const logs: string[] = [];
    const client = {
      provider: { list: async () => ({ data: providerData }) },
      app: { log: async ({ body }: any) => { logs.push(body.message); } },
    };
    const hooks = await AutoRouterPlugin({ client, directory: "/tmp/project" } as any);

    await hooks["chat.message"]!({ sessionID: "session-boundary", agent: "build" } as any, message("[task:run_tests] run no-mistakes") as any);
    await hooks["chat.message"]!({ sessionID: "session-boundary", agent: "build" } as any, message("report the failures") as any);
    await hooks["chat.message"]!({ sessionID: "session-boundary", agent: "build" } as any, message("[task:planning] plan the architecture") as any);

    const decisions = logs.filter((entry) => entry.includes("[auto-router] TASK SELECT"));
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toContain("opencode/muse-spark-1.2-contributor-free");
    expect(decisions[1]).toContain("openai/fable-latest");
  });

  it("emits only one recommendation for a task", async () => {
    const logs: string[] = [];
    const client = {
      provider: { list: async () => ({ data: providerData }) },
      app: { log: async ({ body }: any) => { logs.push(body.message); } },
    };
    const hooks = await AutoRouterPlugin({ client, directory: "/tmp/project" } as any);
    await hooks["chat.message"]!({ sessionID: "session-recommend", agent: "build" } as any, message("run no-mistakes") as any);
    const output = { options: {} };
    const input = {
      sessionID: "session-recommend",
      agent: "build",
      model: { id: "gpt-5.6-luna", providerID: "openai" },
      provider: { id: "openai" },
      message: { parts: [{ text: "run no-mistakes" }] },
    };

    await hooks["chat.params"]!(input as any, output as any);
    await hooks["chat.params"]!(input as any, output as any);

    expect(output).toEqual({ options: {} });
    expect(logs.filter((entry) => entry.includes("[auto-router] TASK RECOMMEND"))).toHaveLength(1);
  });
});
