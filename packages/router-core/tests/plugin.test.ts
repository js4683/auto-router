import { afterEach, describe, expect, it, vi } from "vitest";
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

function message(
  text: string,
  options: {
    sessionID?: string;
    messageID?: string;
    providerID?: string;
    modelID?: string;
    variant?: string;
  } = {}
) {
  const sessionID = options.sessionID ?? "session-1";
  const messageID = options.messageID ?? "message-1";
  return {
    message: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: {
        providerID: options.providerID ?? "openai",
        modelID: options.modelID ?? "gpt-5.6-luna",
        ...(options.variant ? { variant: options.variant } : {}),
      },
    },
    parts: [{ id: `part-${messageID}`, sessionID, messageID, type: "text", text }],
  };
}

function testClient(providerList: () => Promise<unknown> = async () => ({ data: providerData })) {
  const logs: string[] = [];
  const toasts: unknown[] = [];
  return {
    logs,
    toasts,
    client: {
      provider: { list: providerList },
      app: {
        log: async ({ body }: any) => {
          logs.push(body.message);
        },
      },
      tui: {
        showToast: async (input: unknown) => {
          toasts.push(input);
        },
      },
    },
  };
}

async function plugin(client: ReturnType<typeof testClient>["client"]) {
  const hooks = await AutoRouterPlugin({ client, directory: "/tmp/project" } as any);
  await hooks.config!({} as any);
  return hooks;
}

afterEach(() => vi.useRealTimers());

describe("auto-router provider discovery", () => {
  it("defers provider lookup until the first routed message", async () => {
    let calls = 0;
    const fixture = testClient(async () => {
      calls += 1;
      return { data: providerData };
    });
    const hooks = await plugin(fixture.client);

    expect(calls).toBe(0);
    await hooks["chat.message"]!(
      { sessionID: "deferred", agent: "build" } as any,
      message("fix typo", { sessionID: "deferred" }) as any
    );
    expect(calls).toBe(1);
  });

  it("applies a connected selected model to the pending user message", async () => {
    const fixture = testClient();
    const hooks = await plugin(fixture.client);
    const output = message("fix typo", { sessionID: "apply", variant: "high" });

    await hooks["chat.message"]!({ sessionID: "apply", agent: "build" } as any, output as any);

    expect(output.message.model).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.2-contributor-free",
    });
  });

  it("reapplies the locked target without selecting again on a sticky turn", async () => {
    const fixture = testClient();
    const hooks = await plugin(fixture.client);
    const first = message("run no-mistakes", { sessionID: "sticky", messageID: "message-1" });
    const followUp = message("report the failures", { sessionID: "sticky", messageID: "message-2" });

    await hooks["chat.message"]!({ sessionID: "sticky", agent: "build" } as any, first as any);
    await hooks["chat.message"]!({ sessionID: "sticky", agent: "build" } as any, followUp as any);

    expect(followUp.message.model).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.2-contributor-free",
    });
    expect(fixture.logs.filter((entry) => entry.includes("TASK SELECT"))).toHaveLength(1);
  });

  it("preserves a variant when the selected provider and model already match", async () => {
    const fixture = testClient();
    const hooks = await plugin(fixture.client);
    const output = message("fix typo", {
      sessionID: "same-model",
      providerID: "opencode",
      modelID: "muse-spark-1.2-contributor-free",
      variant: "high",
    });

    await hooks["chat.message"]!({ sessionID: "same-model", agent: "build" } as any, output as any);

    expect(output.message.model.variant).toBe("high");
  });

  it("selects again when an explicit tag starts a new task", async () => {
    const fixture = testClient();
    const hooks = await plugin(fixture.client);

    await hooks["chat.message"]!(
      { sessionID: "boundary", agent: "build" } as any,
      message("[task:run_tests] run no-mistakes", { sessionID: "boundary", messageID: "message-1" }) as any
    );
    await hooks["chat.message"]!(
      { sessionID: "boundary", agent: "build" } as any,
      message("report the failures", { sessionID: "boundary", messageID: "message-2" }) as any
    );
    await hooks["chat.message"]!(
      { sessionID: "boundary", agent: "build" } as any,
      message("[task:planning] plan the architecture", { sessionID: "boundary", messageID: "message-3" }) as any
    );

    const decisions = fixture.logs.filter((entry) => entry.includes("TASK SELECT"));
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toContain("opencode/muse-spark-1.2-contributor-free");
    expect(decisions[1]).toContain("openai/fable-latest");
  });

  it("does not apply a fallback target when connected discovery fails", async () => {
    const fixture = testClient(async () => Promise.reject(new Error("offline")));
    const hooks = await plugin(fixture.client);
    const output = message("fix typo", { sessionID: "fallback" });

    await hooks["chat.message"]!({ sessionID: "fallback", agent: "build" } as any, output as any);

    expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" });
  });

  it("retries discovery after an unbacked recommendation", async () => {
    let calls = 0;
    const fixture = testClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return { data: providerData };
    });
    const hooks = await plugin(fixture.client);
    const first = message("fix typo", { sessionID: "retry", messageID: "message-1" });
    const second = message("fix another typo", { sessionID: "retry", messageID: "message-2" });

    await hooks["chat.message"]!({ sessionID: "retry", agent: "build" } as any, first as any);
    await hooks["chat.message"]!({ sessionID: "retry", agent: "build" } as any, second as any);

    expect(calls).toBe(2);
    expect(second.message.model.providerID).toBe("opencode");
  });

  it("preserves slashes inside the model ID", async () => {
    const data = {
      connected: ["openrouter"],
      all: [
        {
          id: "openrouter",
          models: {
            "openai/gpt-5-mini": {
              id: "openai/gpt-5-mini",
              cost: { input: 0, output: 0 },
              limit: { context: 128000, output: 16000 },
              status: "active",
            },
          },
        },
      ],
    };
    const fixture = testClient(async () => ({ data }));
    const hooks = await plugin(fixture.client);
    const output = message("fix typo", { sessionID: "slash" });

    await hooks["chat.message"]!({ sessionID: "slash", agent: "build" } as any, output as any);

    expect(output.message.model).toEqual({ providerID: "openrouter", modelID: "openai/gpt-5-mini" });
  });

  it("fails open after the provider discovery timeout", async () => {
    vi.useFakeTimers();
    const fixture = testClient(async () => new Promise(() => {}));
    const hooks = await plugin(fixture.client);
    const output = message("fix typo", { sessionID: "timeout" });
    const turn = hooks["chat.message"]!({ sessionID: "timeout", agent: "build" } as any, output as any);

    await vi.advanceTimersByTimeAsync(1500);
    await turn;

    expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna" });
  });

  it("shares one unresolved provider lookup across retries", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fixture = testClient(async () => {
      calls += 1;
      return new Promise(() => {});
    });
    const hooks = await plugin(fixture.client);
    const first = hooks["chat.message"]!(
      { sessionID: "unresolved", agent: "build" } as any,
      message("fix typo", { sessionID: "unresolved", messageID: "message-1" }) as any
    );

    await vi.advanceTimersByTimeAsync(1500);
    await first;

    const second = hooks["chat.message"]!(
      { sessionID: "unresolved", agent: "build" } as any,
      message("fix another typo", { sessionID: "unresolved", messageID: "message-2" }) as any
    );
    await vi.advanceTimersByTimeAsync(1500);
    await second;

    expect(calls).toBe(1);
  });

  it("applies the selection from its own live snapshot", async () => {
    let calls = 0;
    let releaseFirstSelection: (() => void) | undefined;
    let firstSelectionLogged: (() => void) | undefined;
    const selectionLogged = new Promise<void>((resolve) => {
      firstSelectionLogged = resolve;
    });
    const fixture = testClient(async () => {
      calls += 1;
      return {
        data: calls === 1
          ? providerData
          : {
              connected: ["openai"],
              all: [{
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
              }],
            },
      };
    });
    const appLog = fixture.client.app.log;
    fixture.client.app.log = async ({ body }: any) => {
      await appLog({ body });
      if (body.message.includes("TASK SELECT s=first")) {
        firstSelectionLogged?.();
        await new Promise<void>((resolve) => {
          releaseFirstSelection = resolve;
        });
      }
    };
    const hooks = await plugin(fixture.client);
    const first = message("fix typo", { sessionID: "first", messageID: "message-1" });
    const firstTurn = hooks["chat.message"]!({ sessionID: "first", agent: "build" } as any, first as any);

    await selectionLogged;
    const second = message("plan the architecture", { sessionID: "second", messageID: "message-1" });
    await hooks["chat.message"]!({ sessionID: "second", agent: "build" } as any, second as any);
    releaseFirstSelection?.();
    await firstTurn;

    expect(first.message.model).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.2-contributor-free",
    });
  });

  it("confirms the applied model only for the matching message and agent", async () => {
    const fixture = testClient();
    const hooks = await plugin(fixture.client);
    const output = message("fix typo", { sessionID: "confirm" });
    await hooks["chat.message"]!({ sessionID: "confirm", agent: "build" } as any, output as any);

    await hooks["chat.params"]!(
      {
        sessionID: "confirm",
        agent: "title",
        model: { id: "small-title-model", providerID: "openai" },
        provider: { id: "openai" },
        message: output.message,
      } as any,
      { options: {} } as any
    );
    await hooks["chat.params"]!(
      {
        sessionID: "confirm",
        agent: "build",
        model: { id: "muse-spark-1.2-contributor-free", providerID: "opencode" },
        provider: { id: "opencode" },
        message: output.message,
      } as any,
      { options: {} } as any
    );

    expect(fixture.logs.filter((entry) => entry.includes("TASK APPLY "))).toHaveLength(1);
    expect(fixture.logs.some((entry) => entry.includes("TASK APPLY mismatch"))).toBe(false);
  });

  it("emits only one mismatch for the matching LLM call", async () => {
    const fixture = testClient();
    const hooks = await plugin(fixture.client);
    const output = message("fix typo", { sessionID: "mismatch" });
    await hooks["chat.message"]!({ sessionID: "mismatch", agent: "build" } as any, output as any);
    const input = {
      sessionID: "mismatch",
      agent: "build",
      model: { id: "gpt-5.6-luna", providerID: "openai" },
      provider: { id: "openai" },
      message: output.message,
    };

    await hooks["chat.params"]!(input as any, { options: {} } as any);
    await hooks["chat.params"]!(input as any, { options: {} } as any);

    expect(fixture.logs.filter((entry) => entry.includes("TASK APPLY mismatch"))).toHaveLength(1);
  });

  it("shows one boundary toast and no sticky-turn toast", async () => {
    const fixture = testClient();
    const hooks = await plugin(fixture.client);

    await hooks["chat.message"]!(
      { sessionID: "toast", agent: "build" } as any,
      message("run no-mistakes", { sessionID: "toast", messageID: "message-1" }) as any
    );
    await hooks["chat.message"]!(
      { sessionID: "toast", agent: "build" } as any,
      message("report the failures", { sessionID: "toast", messageID: "message-2" }) as any
    );

    expect(fixture.toasts).toHaveLength(1);
  });
});
