import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJsonlRecorder, type EvalRecordInput, type EvalRecorder } from "@auto-router/eval";
import { selectModel, type Catalog, type RouterConfig, type SessionState } from "@auto-router/router-core";
import { createProxyServer } from "../src/server.js";
import { memorySessions } from "../src/session.js";

const catalog: Catalog = {
  fetchedAt: "t",
  source: "live",
  models: [
    {
      id: "muse-spark-1.2-contributor-free",
      runtimeId: "opencode/muse-spark-1.2-contributor-free",
      codingIndex: 78,
      blendedPrice: 0,
      value: 780,
      windowTokens: 272000,
      isFree: true,
    },
    {
      id: "gpt-5.6-sol",
      runtimeId: "openai/gpt-5.6-sol",
      codingIndex: 92,
      blendedPrice: 12,
      value: 7.6,
      windowTokens: 272000,
      isFree: false,
    },
  ],
};

const config: RouterConfig = {
  tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
  scorer: {
    weights: { promptTokens: 0.2, sessionTokens: 0.2, filesTouched: 0.15, diffHunks: 0.15, toolDepth: 0.15, keywords: 0.15 },
    thresholds: { simpleMax: 0.4, mediumMax: 0.7 },
  },
  stickiness: { downgradeAfter: 3, upgradeImmediate: true },
  guards: { contextFitMarginTokens: 8000 },
  taskTypeModels: {
    code_review: { prefer: null },
    run_tests: { prefer: null, strategy: "lowest-cost" },
    monitoring: { prefer: null },
    planning: { prefer: null, strategy: "quality", minQuality: 85 },
    implement: { prefer: null },
    debug: { prefer: null },
  },
  providerFreeSet: [],
  windowRegistry: {},
  catalog: { cachePath: "", refreshIntervalHours: 24, artificialAnalysis: { apiUrl: "", apiKeyEnv: "" } },
  modelMap: {
    "qwen/qwen3": [{ runtimeId: "opencode/muse-spark-1.2-contributor-free", source: "hand" }],
  },
};

function fakeReq(url: string, body: unknown, headers: Record<string, string | undefined> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = url;
  const requestHeaders: Record<string, string> = { "content-type": "application/json", "x-session-id": "ses_test" };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) delete requestHeaders[name];
    else requestHeaders[name] = value;
  }
  req.headers = requestHeaders;
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function collectRes() {
  let body = "";
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    get body() {
      return body;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    write(chunk: string | Buffer) {
      body += String(chunk);
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += String(chunk);
    },
  };
}

function recordingServer(recorder: EvalRecorder, output = "Hello") {
  return createProxyServer({
    catalog,
    config,
    sessions: memorySessions(),
    recorder,
    backends: {
      opencode: {
        baseUrl: "https://opencode.ai/zen",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              id: "resp_1",
              status: "completed",
              output: [{ type: "message", content: [{ type: "output_text", text: output }] }],
            }),
            { headers: { "content-type": "application/json" } }
          ),
      },
    },
    select: () =>
      ({
        modelId: "opencode/muse-spark-1.2-contributor-free",
        tier: "simple",
        taskType: null,
        confidence: 1,
        reason: "fixture",
        via: "force",
        catalogSource: "live",
        score: 0,
        boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
      }) as never,
  });
}

describe("proxy", () => {
  it("handles the Claude Code preflight without calling a backend", async () => {
    let backendCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () => {
            backendCalls += 1;
            return new Response("{}");
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });
    const req = fakeReq("/api/hello", {});
    req.method = "HEAD";
    const res = collectRes();

    await server.handle(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(backendCalls).toBe(0);
  });

  it("answers Codex model discovery locally without calling a backend", async () => {
    let backendCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () => {
            backendCalls += 1;
            return new Response("{}");
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });
    const req = fakeReq("/v1/models?client_version=0.147.0", {});
    req.method = "GET";
    const res = collectRes();

    await server.handle(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      object: "list",
      data: [{ id: "auto", object: "model", created: 0, owned_by: "auto-router" }],
      models: [{
        slug: "auto",
        display_name: "Auto Router",
        description: "Task-aware model routing",
        default_reasoning_level: "none",
        supported_reasoning_levels: [],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        model_messages: {
          instructions_template: "",
          instructions_variables: { personality_default: "", personality_friendly: "", personality_pragmatic: "" },
          approvals: null,
          collaboration_modes: null,
          auto_review: null,
          permissions: null,
        },
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        default_reasoning_summary: "none",
        support_verbosity: false,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text_and_image",
        truncation_policy: { mode: "tokens", limit: 10000 },
        supports_image_detail_original: false,
        context_window: 272000,
        max_context_window: 272000,
        comp_hash: "auto-router-v1",
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ["text"],
        supports_parallel_tool_calls: true,
        supports_search_tool: false,
        use_responses_lite: true,
        tool_mode: "code_mode_only",
        multi_agent_version: "v2",
        base_instructions: "",
        auto_compact_token_limit: 244800,
        supports_reasoning_summaries: false,
      }],
    });
    expect(backendCalls).toBe(0);
  });

  it("rewrites chat completions model to the task target and holds it on the second call", async () => {
    const outbound: Array<{ url: string; model: string }> = [];
    let rankCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "http://backend.test",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body));
            outbound.push({ url: String(url), model: parsed.model });
            return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
          },
        },
        opencode: {
          baseUrl: "http://backend.test",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body));
            outbound.push({ url: String(url), model: parsed.model });
            return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
          },
        },
      },
      rankAvengers: () => {
        rankCalls += 1;
        return { paperIds: ["qwen/qwen3"] };
      },
      select: selectModel,
    });

    const body = { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "implement the feature" }] };
    await server.handle(fakeReq("/v1/chat/completions", body), collectRes() as never);
    await server.handle(fakeReq("/v1/chat/completions", { ...body, messages: [{ role: "user", content: "continue" }] }), collectRes() as never);

    expect(outbound[0].model).toBe("muse-spark-1.2-contributor-free");
    expect(outbound[1].model).toBe(outbound[0].model);
    expect(rankCalls).toBe(1);
  });

  it("returns a route decision without calling a backend", async () => {
    let backendCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "http://backend.test",
          fetchImpl: async () => {
            backendCalls += 1;
            return new Response("{}");
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });
    const res = collectRes();
    await server.handle(
      fakeReq("/v1/route", { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "implement the feature" }] }),
      res as never
    );
    expect(backendCalls).toBe(0);
    expect(JSON.parse(res.body).modelId).toBe("opencode/muse-spark-1.2-contributor-free");
  });

  it("reconstructs routing signals from request messages and tools", async () => {
    const observed: SessionState[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {},
      select: ((state: SessionState) => {
        observed.push(state);
        return {
          modelId: "openai/gpt-5.6-sol",
          tier: "complex",
          taskType: "implement",
          confidence: 1,
          reason: "captured",
          via: "value",
          catalogSource: "live",
          score: 1,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        };
      }) as typeof selectModel,
    });
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/b.ts",
      "@@ first hunk",
      "-old",
      "+new",
      "@@ second hunk",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n");
    const body = {
      model: "auto",
      messages: [
        { role: "system", content: "Follow repository instructions." },
        { role: "user", content: "Inspect the files." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"src/a.ts"}' } },
            { id: "call_patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ patchText }) } },
          ],
        },
        { role: "tool", tool_call_id: "call_read", content: "Error: first attempt failed" },
        { role: "user", content: "continue" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file. ".repeat(40),
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    };

    await server.handle(fakeReq("/v1/route", body, { "x-session-id": "with_tools" }), collectRes() as never);
    await server.handle(fakeReq("/v1/route", { ...body, tools: [] }, { "x-session-id": "without_tools" }), collectRes() as never);

    expect(observed).toHaveLength(2);
    expect(observed[0].lifetimeTokens - observed[1].lifetimeTokens).toBeGreaterThan(100);
    expect(observed[0].currentTask).toMatchObject({
      promptTokens: 2,
      taskTokens: observed[0].lifetimeTokens,
      filesTouched: 2,
      diffHunks: 2,
      toolDepth: 2,
      priorErrors: 1,
      lastUserMessage: "continue",
    });
  });

  it("forwards authorization and sends Muse to Zen /v1/responses", async () => {
    const outbound: Array<{ url: string; model: string; auth?: string; input?: unknown }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: { baseUrl: "http://openai.test", fetchImpl: async () => new Response("wrong backend") },
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body));
            const headers = init?.headers as Record<string, string>;
            outbound.push({
              url: String(url),
              model: parsed.model,
              auth: headers?.authorization ?? headers?.Authorization,
              input: parsed.input,
            });
            return new Response(
              JSON.stringify({
                id: "resp_ok",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
              }),
              { status: 200 }
            );
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/chat/completions",
        {
          model: "openai/gpt-5.6-luna",
          messages: [
            { role: "system", content: "Follow the repository rules." },
            { role: "user", content: "Implement the feature." },
            { role: "assistant", content: "I inspected the code." },
            { role: "user", content: [{ type: "text", text: "Continue with the fix." }] },
          ],
          stream: true,
        },
        { authorization: "Bearer zen-test-key" }
      ),
      res as never
    );

    expect(outbound).toHaveLength(1);
    expect(outbound[0].url).toBe("https://opencode.ai/zen/v1/responses");
    expect(outbound[0].model).toBe("muse-spark-1.2-contributor-free");
    expect(outbound[0].auth).toBe("Bearer zen-test-key");
    expect(outbound[0].input).toEqual([
      { role: "system", content: "Follow the repository rules." },
      { role: "user", content: "Implement the feature." },
      { role: "assistant", content: "I inspected the code." },
      { role: "user", content: "Continue with the fix." },
    ]);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain('"content":"OK"');
    expect(res.body).toContain('"finish_reason":"length"');
    expect(res.body).toContain("data: [DONE]");
  });

  it("preserves Zen refusals as content-filtered Chat Completions", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                id: "resp_refusal",
                status: "completed",
                output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot help with that request." }] }],
              })
            ),
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });
    const body = { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "Make a restricted request." }] };

    const jsonRes = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", body), jsonRes as never);
    expect(JSON.parse(jsonRes.body)).toMatchObject({
      choices: [
        {
          message: { role: "assistant", content: null, refusal: "I cannot help with that request." },
          finish_reason: "content_filter",
        },
      ],
    });

    const streamRes = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", { ...body, stream: true }), streamRes as never);
    const chunks = streamRes.body
      .split("\n\n")
      .filter((line) => line.startsWith("data: {") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    expect(chunks[0].choices[0].delta).toEqual({
      role: "assistant",
      content: null,
      refusal: "I cannot help with that request.",
    });
    expect(chunks[1].choices[0].finish_reason).toBe("content_filter");
  });

  it("sends unprefixed gpt-5 planning targets to Zen /v1/responses", async () => {
    const outbound: Array<{ url: string; model: string }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: { baseUrl: "http://openai.test", fetchImpl: async () => new Response("wrong backend") },
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body));
            outbound.push({ url: String(url), model: parsed.model });
            return new Response(JSON.stringify({ id: "resp_ok" }), { status: 200 });
          },
        },
      },
      select: () =>
        ({
          modelId: "gpt-5.4",
          tier: "simple",
          taskType: "planning",
          confidence: 1,
          reason: "quality",
          via: "quality",
          catalogSource: "fallback",
          score: 0.8,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    await server.handle(
      fakeReq("/v1/chat/completions", { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "plan the architecture" }] }, { authorization: "Bearer zen-test-key" }),
      collectRes() as never
    );

    expect(outbound).toHaveLength(1);
    expect(outbound[0].url).toBe("https://opencode.ai/zen/v1/responses");
    expect(outbound[0].model).toBe("gpt-5.4");
  });

  it("routes every OpenCode target through Zen Responses", async () => {
    const outbound: Array<{ url: string; body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: "resp_ok", status: "completed", output: [] }));
          },
        },
      },
      select: () =>
        ({
          modelId: "opencode/claude-sonnet-4-5",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    await server.handle(
      fakeReq("/v1/chat/completions", { model: "opencode/claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] }),
      collectRes() as never
    );

    expect(outbound[0]).toMatchObject({ url: "https://opencode.ai/zen/v1/responses", body: { model: "claude-sonnet-4-5" } });
  });

  it("sends Gemini targets to Google generateContent with the backend key", async () => {
    const outbound: Array<{ url: string; body: any; key?: string }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: { baseUrl: "http://openai.test", fetchImpl: async () => new Response("wrong backend") },
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-backend-key",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body ?? "{}"));
            const target = new URL(String(url));
            outbound.push({
              url: `${target.origin}${target.pathname}`,
              key: target.searchParams.get("key") ?? undefined,
              body: parsed,
            });
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "MAX_TOKENS" }] }), { status: 200 });
          },
        },
      },
      select: () =>
        ({
          modelId: "google/gemini-3-flash",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0.2,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/chat/completions",
        {
          model: "google/gemini-3-flash",
          messages: [
            { role: "system", content: "Be concise." },
            { role: "developer", content: "Use plain text." },
            { role: "user", content: "Say hi." },
            { role: "assistant", content: "Hi." },
            { role: "user", content: [{ type: "text", text: "Now say bye." }] },
          ],
        },
        { authorization: "Bearer AIza-test" }
      ),
      res as never
    );

    expect(outbound).toHaveLength(1);
    expect(outbound[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent");
    expect(outbound[0].key).toBe("gemini-backend-key");
    expect(outbound[0].body).toEqual({
      systemInstruction: { parts: [{ text: "Be concise." }, { text: "Use plain text." }] },
      contents: [
        { role: "user", parts: [{ text: "Say hi." }] },
        { role: "model", parts: [{ text: "Hi." }] },
        { role: "user", parts: [{ text: "Now say bye." }] },
      ],
    });
    expect(JSON.parse(res.body)).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "length" }],
    });
  });

  it("wires Avengers-Pro fixture ranking into the executable bootstrap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-avengers-"));
    const configPath = join(directory, "enabled.json");
    writeFileSync(configPath, JSON.stringify({
      tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
      avengersPro: { enabled: true },
      providerFreeSet: ["muse-spark-1.2-contributor-free"],
      windowRegistry: { "muse-spark-1.2-contributor-free": 272000 },
      modelMap: {
        "qwen/qwen3": [{ runtimeId: "opencode/muse-spark-1.2-contributor-free", source: "hand" }],
      },
    }));
    vi.stubEnv("AUTO_ROUTER_CONFIG", configPath);
    try {
      const { bootstrapProxyOptions } = await import("../src/server.js");
      const opts = bootstrapProxyOptions();
      expect(opts.rankAvengers).toBeTypeOf("function");
      expect(opts.rankAvengers?.("implement the feature").paperIds[0]).toBe("qwen/qwen3");

      const res = collectRes();
      const server = createProxyServer({
        ...opts,
        sessions: memorySessions(),
        backends: {
          opencode: {
            baseUrl: "http://backend.test",
            fetchImpl: async () => new Response(JSON.stringify({ id: "ok", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] })),
          },
        },
      });
      await server.handle(
        fakeReq("/v1/route", { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "implement the feature" }] }),
        res as never
      );
      expect(JSON.parse(res.body)).toMatchObject({ via: "avengers-pro" });
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enables proxy recording only through explicit environment configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-proxy-recording-"));
    vi.stubEnv("AUTO_ROUTER_EVAL_RECORD_MODE", "metadata");
    vi.stubEnv("AUTO_ROUTER_EVAL_RECORD_DIR", directory);
    vi.stubEnv("AUTO_ROUTER_EVAL_RETENTION_DAYS", "7");
    try {
      const { bootstrapProxyOptions } = await import("../src/server.js");
      const opts = bootstrapProxyOptions();

      expect(opts.recorder?.mode).toBe("metadata");
      await opts.recorder?.flush();
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("translates Chat Completions tools to Zen Responses and back", async () => {
    const outbound: Array<{ body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (_url, init) => {
            outbound.push({ body: JSON.parse(String(init?.body)) });
            return new Response(
              JSON.stringify({
                id: "resp_tool",
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    call_id: "call_read",
                    name: "read_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                ],
              })
            );
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/chat/completions",
        {
          model: "openai/gpt-5.6-luna",
          stream: true,
          messages: [
            { role: "user", content: "implement the feature" },
            {
              role: "assistant",
              content: "I will read it.",
              tool_calls: [{ id: "call_read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
            },
            { role: "tool", tool_call_id: "call_read", content: "auto-router" },
          ],
          tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
        }
      ),
      res as never
    );

    expect(outbound[0].body.tools).toEqual([{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }]);
    expect(outbound[0].body.input).toEqual(expect.arrayContaining([
      { role: "assistant", content: "I will read it." },
      { type: "function_call", call_id: "call_read", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      { type: "function_call_output", call_id: "call_read", output: "auto-router" },
    ]));
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain('"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]');
    expect(res.body).toContain('"finish_reason":"tool_calls"');
  });

  it("translates Chat Completions tools to Gemini and removes unsupported schema fields", async () => {
    const outbound: Array<{ body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-backend-key",
          fetchImpl: async (_url, init) => {
            outbound.push({ body: JSON.parse(String(init?.body)) });
            return new Response(
              JSON.stringify({
                candidates: [{
                  content: {
                    parts: [{ functionCall: { name: "read_file", args: { path: "README.md" } } }],
                  },
                  finishReason: "STOP",
                }],
              })
            );
          },
        },
      },
      select: () =>
        ({
          modelId: "google/gemini-3.6-flash",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0.2,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/chat/completions",
        {
          model: "google/gemini-3.6-flash",
          messages: [
            { role: "user", content: "read the file" },
            {
              role: "assistant",
              content: "I will read it.",
              tool_calls: [{ id: "call_read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
            },
            { role: "tool", tool_call_id: "call_read", content: "auto-router" },
          ],
          tools: [{
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  options: { type: "object", additionalProperties: false, properties: { encoding: { type: "string" } } },
                },
              },
            },
          }],
        }
      ),
      res as never
    );

    expect(outbound[0].body.tools).toEqual([{ functionDeclarations: [{
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          options: { type: "object", properties: { encoding: { type: "string" } } },
        },
      },
    }] }]);
    expect(outbound[0].body.contents).toEqual(expect.arrayContaining([
      { role: "model", parts: [{ text: "I will read it." }, { functionCall: expect.objectContaining({ name: "read_file", args: { path: "README.md" } }) }] },
      { role: "user", parts: [{ functionResponse: { name: "read_file", response: { result: "auto-router" } } }] },
    ]));
    expect(JSON.parse(res.body)).toMatchObject({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [{ type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
        },
      }],
    });
  });

  it("maps Gemini MAX_TOKENS to an incomplete Responses result", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-backend-key",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
              })
            ),
        },
      },
      select: () =>
        ({
          modelId: "google/gemini-3.6-flash",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const res = collectRes();
    await server.handle(fakeReq("/v1/responses", { model: "auto", input: "continue" }), res as never);
    expect(JSON.parse(res.body)).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ status: "incomplete" }],
    });
  });

  it("accepts Anthropic /v1/messages and returns a Messages response", async () => {
    const outbound: Array<{ url: string; input: unknown; maxOutputTokens?: number; authorization?: string }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body));
            const headers = init?.headers as Record<string, string>;
            outbound.push({ url: String(url), input: parsed.input, maxOutputTokens: parsed.max_output_tokens, authorization: headers.authorization });
            return new Response(
              JSON.stringify({
                id: "resp_ok",
                status: "completed",
                output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
              })
            );
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/messages?beta=true",
        {
          model: "claude-sonnet-4-5",
          max_tokens: 32,
          system: "Be brief.",
          messages: [{ role: "user", content: "implement the feature" }],
        },
        { authorization: "Bearer claude-oauth-token" }
      ),
      res as never
    );

    expect(outbound[0].url).toBe("https://opencode.ai/zen/v1/responses");
    expect(outbound[0].input).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "implement the feature" },
    ]);
    expect(outbound[0].maxOutputTokens).toBe(32);
    expect(outbound[0].authorization).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
    });
  });

  it("accepts OpenAI /v1/responses and returns a Responses payload", async () => {
    const outbound: Array<{ url: string; input: unknown }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), input: JSON.parse(String(init?.body)).input });
            return new Response(
              JSON.stringify({
                id: "resp_ok",
                status: "completed",
                output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
              })
            );
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq("/v1/responses", { model: "openai/gpt-5.6-luna", instructions: "Be brief.", input: "implement the feature" }),
      res as never
    );

    expect(outbound[0].url).toBe("https://opencode.ai/zen/v1/responses");
    expect(outbound[0].input).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "implement the feature" },
    ]);
    expect(JSON.parse(res.body)).toMatchObject({
      object: "response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    });
  });

  it("streams Anthropic tool-use events", async () => {
    const outbound: any[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (_url, init) => {
            outbound.push(JSON.parse(String(init?.body)));
            return new Response(
              JSON.stringify({
                id: "resp_tool",
                status: "completed",
                output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
              })
            );
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq("/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "implement the feature" }],
        tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
      }),
      res as never
    );

    expect(outbound[0].tools).toEqual([{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" } }]);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain("event: content_block_start");
    expect(res.body).toContain('"type":"tool_use","id":"call_1","name":"read_file"');
    expect(res.body).toContain('"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"');
    expect(res.body).toContain('"stop_reason":"tool_use"');
    expect(res.body).toContain("event: message_stop");
  });

  it("streams OpenAI Responses text events", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () => new Response(
            JSON.stringify({
              id: "resp_stream",
              status: "completed",
              output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
            })
          ),
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq("/v1/responses", { model: "openai/gpt-5.6-luna", input: "implement the feature", stream: true }),
      res as never
    );

    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain("event: response.created");
    expect(res.body).toContain('"type":"response.output_text.delta"');
    expect(res.body).toContain('"delta":"OK"');
    expect(res.body).toContain("event: response.completed");
  });

  it("streams Responses refusals as refusal events", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                id: "resp_refusal",
                status: "completed",
                output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot help with that request." }] }],
              })
            ),
        },
      },
      select: () =>
        ({
          modelId: "opencode/muse-spark-1.2-contributor-free",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const res = collectRes();
    await server.handle(
      fakeReq("/v1/responses", { model: "auto", input: "Make a restricted request.", stream: true }),
      res as never
    );

    expect(res.body).toContain('"type":"response.refusal.delta"');
    expect(res.body).toContain('"type":"response.refusal.done"');
    expect(res.body).toContain('"part":{"type":"refusal","refusal":""}');
    expect(res.body).not.toContain("event: response.output_text.delta");
  });

  it("preserves incomplete status for translated Responses", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                id: "resp_incomplete",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
              })
            ),
        },
      },
      select: () =>
        ({
          modelId: "opencode/muse-spark-1.2-contributor-free",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const jsonRes = collectRes();
    await server.handle(fakeReq("/v1/responses", { model: "auto", input: "continue" }), jsonRes as never);
    expect(JSON.parse(jsonRes.body)).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ status: "incomplete" }],
    });

    const streamRes = collectRes();
    await server.handle(fakeReq("/v1/responses", { model: "auto", input: "continue", stream: true }), streamRes as never);
    expect(streamRes.body).toContain("event: response.incomplete");
    expect(streamRes.body).not.toContain("event: response.completed");
  });

  it("translates an OpenAI Chat Completions target back to Anthropic Messages", async () => {
    const outbound: Array<{ url: string; body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({
              id: "chatcmpl_ok",
              choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
            }));
          },
        },
      },
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/messages",
        { model: "claude-sonnet-4-5", max_tokens: 32, stream: true, messages: [{ role: "user", content: "implement the feature" }] },
        { "x-force-model": "openai/gpt-5.6-sol" }
      ),
      res as never
    );

    expect(outbound[0]).toMatchObject({
      url: "https://api.openai.com/v1/chat/completions",
      body: { model: "gpt-5.6-sol", stream: false, messages: [{ role: "user", content: "implement the feature" }] },
    });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain('"type":"text_delta","text":"OK"');
    expect(res.body).toContain("event: message_stop");
  });

  it("uses Anthropic Messages for explicit Anthropic targets", async () => {
    const outbound: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          apiKey: "anthropic-backend-key",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
            return new Response(
              JSON.stringify({
                id: "msg_ok",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "OK" }],
                stop_reason: "end_turn",
              })
            );
          },
        },
      },
      select: () =>
        ({
          modelId: "anthropic/claude-sonnet-4-5",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const res = collectRes();
    await server.handle(
      fakeReq("/v1/chat/completions", {
        model: "auto",
        max_tokens: 32,
        messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hello" }],
      }),
      res as never
    );

    expect(outbound[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": "anthropic-backend-key", "anthropic-version": "2023-06-01" },
      body: { model: "claude-sonnet-4-5", system: "Be brief.", max_tokens: 32, messages: [{ role: "user", content: "hello" }] },
    });
    expect(outbound[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
  });

  it("preserves native OpenAI Responses requests for OpenAI targets", async () => {
    const outbound: Array<{ url: string; body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: "resp_ok", object: "response", status: "completed", output: [] }));
          },
        },
      },
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/responses",
        { model: "auto", input: "plan the architecture", reasoning: { effort: "high" } },
        { "x-force-model": "openai/gpt-5.6-sol" }
      ),
      res as never
    );

    expect(outbound[0]).toEqual({
      url: "https://api.openai.com/v1/responses",
      body: { model: "gpt-5.6-sol", input: "plan the architecture", reasoning: { effort: "high" } },
    });
    expect(JSON.parse(res.body)).toMatchObject({ id: "resp_ok", object: "response", status: "completed" });
  });

  it("forwards native Anthropic credentials and beta capabilities", async () => {
    const outbound: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
            return new Response(
              JSON.stringify({
                id: "msg_ok",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "OK" }],
                stop_reason: "end_turn",
              })
            );
          },
        },
      },
      select: () =>
        ({
          modelId: "anthropic/claude-sonnet-4-5",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/messages?beta=true",
        {
          model: "claude-sonnet-4-5",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
          context_management: { edits: [] },
        },
        { "x-api-key": "inbound-claude-key", "anthropic-beta": "context-management-2025-06-27" }
      ),
      res as never
    );

    expect(outbound).toHaveLength(1);
    expect(outbound[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(outbound[0].headers["x-api-key"]).toBe("inbound-claude-key");
    expect(outbound[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(outbound[0].headers["anthropic-beta"]).toBe("context-management-2025-06-27");
    expect(outbound[0].headers.authorization).toBeUndefined();
    expect(outbound[0].body.context_management).toEqual({ edits: [] });
    expect(JSON.parse(res.body)).toMatchObject({ type: "message", role: "assistant" });
  });

  it("handles query strings on /health and /v1/route and /v1/responses", async () => {
    const outbound: Array<{ url: string; body: any }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ id: "resp_1", status: "completed", output: [] }));
          },
        },
      },
      select: selectModel,
    });

    const healthRes = collectRes();
    await server.handle(fakeReq("/health?verbose=1", {}), healthRes as never);
    expect(healthRes.statusCode).toBe(200);
    expect(JSON.parse(healthRes.body)).toEqual({ ok: true });

    const routeRes = collectRes();
    await server.handle(
      fakeReq("/v1/route?format=json", { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "implement the feature" }] }),
      routeRes as never
    );
    expect(routeRes.statusCode).toBe(200);
    expect(JSON.parse(routeRes.body).modelId).toBe("opencode/muse-spark-1.2-contributor-free");

    const responsesRes = collectRes();
    await server.handle(
      fakeReq("/v1/responses?stream=false", { model: "openai/gpt-5.6-luna", input: "implement the feature" }),
      responsesRes as never
    );
    expect(responsesRes.statusCode).toBe(200);
    expect(outbound[0].url).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("prevents cross-protocol credential leakage when Anthropic client routes to Zen or Google", async () => {
    const outboundZen: Array<{ url: string; headers: Record<string, string> }> = [];
    const outboundGoogle: Array<{ url: string; headers: Record<string, string> }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            outboundZen.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
            return new Response(JSON.stringify({ id: "resp_zen", status: "completed", output: [] }));
          },
        },
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          fetchImpl: async (url, init) => {
            outboundGoogle.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }));
          },
        },
      },
      select: () =>
        ({
          modelId: "opencode/muse-spark-1.2-contributor-free",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/messages?beta=true",
        { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] },
        { "x-api-key": "anthropic-secret-key", authorization: "Bearer anthropic-oauth-token" }
      ),
      res as never
    );

    expect(outboundZen).toHaveLength(1);
    expect(outboundZen[0].headers.authorization).toBeUndefined();
    expect(outboundZen[0].headers["x-api-key"]).toBeUndefined();
  });

  it("requests buffered Zen output when chat stream translation is unavailable", async () => {
    let upstreamBody: any;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (_url, init) => {
            upstreamBody = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify({
                id: "resp_1",
                status: "completed",
                output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
              }),
              { headers: { "content-type": "application/json" } }
            );
          },
        },
      },
      select: () =>
        ({
          modelId: "opencode/muse-spark-1.2-contributor-free",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "fixture",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });
    const res = collectRes();

    await server.handle(
      fakeReq("/v1/chat/completions", {
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      res as never
    );

    expect(upstreamBody.stream).toBe(false);
    expect(res.body).toContain("data:");
    expect(res.body).toContain("Hello");
    expect(res.body).toContain("data: [DONE]");
  });

  it("records a completed proxy turn without exposing request headers", async () => {
    const records: EvalRecordInput[] = [];
    const server = recordingServer({
      mode: "content",
      async record(input) {
        records.push(input);
      },
      async flush() {},
    });
    const res = collectRes();

    await server.handle(
      fakeReq(
        "/v1/chat/completions",
        { model: "auto", messages: [{ role: "user", content: "hello" }] },
        { authorization: "Bearer inbound-secret", "x-turn-id": "turn-recorded" }
      ),
      res as never
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "completed", usageSource: "estimated", requiredCapabilities: ["text"] });
    expect(records[0].sessionId).toMatch(/^session-[0-9a-f]{64}$/);
    expect(records[0].turnId).toMatch(/^turn-[0-9a-f]{64}$/);
    expect(records[0].sessionId).not.toBe("ses_test");
    expect(records[0].turnId).not.toBe("turn-recorded");
    expect(records[0].messages).toEqual([{ role: "user", content: "hello" }]);
    expect(records[0].output).toContain("Hello");
    expect(JSON.stringify(records[0])).not.toContain("inbound-secret");
    expect(records[0]).not.toHaveProperty("headers");
  });

  it("records a 200 Anthropic max-token response as incomplete", async () => {
    const records: EvalRecordInput[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      recorder: {
        mode: "metadata",
        record: async (input) => {
          records.push(input);
        },
        flush: async () => {},
      },
      backends: {
        anthropic: {
          baseUrl: "https://anthropic.test",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                id: "msg_partial",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "partial" }],
                stop_reason: "max_tokens",
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            ),
        },
      },
      select: () =>
        ({
          modelId: "anthropic/claude",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    await server.handle(fakeReq("/v1/messages", { model: "auto", messages: [{ role: "user", content: "hello" }] }), collectRes() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("incomplete");
  });

  it("records a 200 Responses failed status as failed", async () => {
    const records: EvalRecordInput[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      recorder: {
        mode: "metadata",
        record: async (input) => {
          records.push(input);
        },
        flush: async () => {},
      },
      backends: {
        openai: {
          baseUrl: "https://openai.test",
          fetchImpl: async () => new Response(JSON.stringify({ id: "resp_failed", status: "failed", output: [] }), { status: 200 }),
        },
      },
      select: () =>
        ({
          modelId: "openai/model",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    await server.handle(fakeReq("/v1/responses", { model: "auto", input: "hello" }), collectRes() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("failed");
  });

  it("records opaque IDs and hard capabilities without session headers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-proxy-recording-"));
    const recorder = createJsonlRecorder({ mode: "metadata", directory, retentionDays: 30 });
    const server = recordingServer(recorder);
    const res = collectRes();
    const prompt = "reset password using sk-ant-super-secret-value";

    try {
      await server.handle(
        fakeReq(
          "/v1/chat/completions",
          {
            model: "auto",
            messages: [{ role: "user", content: prompt }],
            tools: [{ type: "function", function: { name: "reset_password", parameters: { type: "object" } } }],
          },
          { "x-session-id": undefined, "x-turn-id": undefined }
        ),
        res as never
      );
      await recorder.flush();
      const line = readFileSync(join(directory, readdirSync(directory)[0]), "utf8");
      const record = JSON.parse(line);

      expect(record.sessionId).toMatch(/^session-[0-9a-f]{64}$/);
      expect(record.turnId).toMatch(/^turn-[0-9a-f]{64}$/);
      expect(record.requiredCapabilities).toEqual(["text", "tools"]);
      expect(line).not.toContain(prompt);
      expect(line).not.toContain("super-secret-value");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails open when eval recording fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = recordingServer({
      mode: "content",
      async record() {
        throw new Error("sensitive recorder failure");
      },
      async flush() {},
    });
    const res = collectRes();

    await server.handle(
      fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hello" }] }),
      res as never
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Hello");
    expect(warn).toHaveBeenCalledWith("[auto-router] eval recording failed");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("sensitive recorder failure"));
    warn.mockRestore();
  });

  it("bounds recorded response content and marks truncation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-proxy-recording-"));
    const recorder = createJsonlRecorder({ mode: "content", directory, retentionDays: 30 });
    const server = recordingServer(recorder, "x".repeat(1024 * 1024 + 1));
    const res = collectRes();

    try {
      await server.handle(
        fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hello" }] }),
        res as never
      );
      await recorder.flush();
      const line = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), "utf8"));

      expect(line.contentTruncated).toBe(true);
      expect(Buffer.byteLength(String(line.output))).toBeLessThanOrEqual(512 * 1024);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requests buffered Gemini output when Anthropic stream translation is unavailable", async () => {
    let upstreamUrl = "";
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-key",
          fetchImpl: async (url) => {
            upstreamUrl = String(url);
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] }), {
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      select: () =>
        ({
          modelId: "google/gemini-3.6-flash",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "fixture",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });
    const res = collectRes();

    await server.handle(
      fakeReq("/v1/messages", {
        model: "auto",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      res as never
    );

    expect(upstreamUrl).toContain(":generateContent");
    expect(upstreamUrl).not.toContain(":streamGenerateContent");
    expect(res.body).toContain("event: content_block_delta");
    expect(res.body).toContain("Hello");
    expect(res.body).toContain("event: message_stop");
  });

  it("requests buffered Anthropic output when chat stream translation is unavailable", async () => {
    let upstreamBody: any;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          apiKey: "anthropic-key",
          fetchImpl: async (_url, init) => {
            upstreamBody = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify({
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Hello" }],
                stop_reason: "end_turn",
              }),
              { headers: { "content-type": "application/json" } }
            );
          },
        },
      },
      select: () =>
        ({
          modelId: "anthropic/claude-sonnet-4-5",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "fixture",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });
    const res = collectRes();

    await server.handle(
      fakeReq("/v1/chat/completions", {
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      res as never
    );

    expect(upstreamBody.stream).toBe(false);
    expect(res.body).toContain("data:");
    expect(res.body).toContain("Hello");
    expect(res.body).toContain("data: [DONE]");
  });

  it("streams translated Gemini chat completions incrementally from upstream SSE", async () => {
    const outbound: Array<{ url: string; body: any }> = [];
    let resolveSecondChunk: () => void;
    const secondChunkReady = new Promise<void>((r) => (resolveSecondChunk = r));
    // Gemini streamGenerateContent SSE chunks: each data: {...} with candidates delta
    const sseChunks = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello " }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "World" }] } }] })}\n\n`,
    ];
    function streamingGeminiResponse() {
      let idx = 0;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (idx < sseChunks.length) {
            controller.enqueue(enc.encode(sseChunks[idx++]));
            if (idx === 1) {
              // wait a tick before second chunk to allow downstream to flush first
              await new Promise((r) => setTimeout(r, 15));
              resolveSecondChunk();
            } else {
              await new Promise((r) => setTimeout(r, 5));
            }
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream as any, { headers: { "content-type": "text/event-stream" } });
    }

    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-key",
          fetchImpl: async (url, init) => {
            outbound.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
            return streamingGeminiResponse();
          },
        },
      },
      select: () =>
        ({
          modelId: "google/gemini-3.6-flash",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const writes: string[] = [];
    let writeHeadCalled = false;
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      writeHead(status: number, headers?: Record<string, string>) {
        writeHeadCalled = true;
        this.statusCode = status;
        if (headers) Object.assign(this.headers, headers);
      },
      write(chunk: string) {
        writes.push(String(chunk));
      },
      end(chunk?: string) {
        if (chunk) writes.push(String(chunk));
        this._ended = true;
      },
      _ended: false,
    };

    const handlePromise = server.handle(
      fakeReq("/v1/chat/completions", { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
      res
    );

    // Wait for first chunk to be available downstream before upstream completes
    await secondChunkReady;
    // Give proxy a tick to flush first downstream delta
    await new Promise((r) => setTimeout(r, 10));
    // At this point, with incremental fix, at least one downstream chunk should have been written
    // With buffered impl, no writes happen until upstream fully completes (after second chunk)
    const writesBeforeUpstreamDone = writes.join("").includes("Hello");

    await handlePromise;

    expect(outbound[0].url).toContain(":streamGenerateContent");
    expect(outbound[0].url).toContain("alt=sse");
    expect(writeHeadCalled).toBe(true);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(writesBeforeUpstreamDone).toBe(true);
    const all = writes.join("");
    expect(all).toContain("Hello");
    expect(all).toContain("World");
    expect(all).toContain("data: [DONE]");
  });

  it("pipes native OpenAI Responses stream incrementally without buffering", async () => {
    const sseChunks = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello " })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "World" })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } })}\n\n`,
    ];
    function streamingResponsesResponse() {
      let idx = 0;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (idx < sseChunks.length) {
            controller.enqueue(enc.encode(sseChunks[idx++]));
            await new Promise((r) => setTimeout(r, 5));
          } else controller.close();
        },
      });
      return new Response(stream as any, { headers: { "content-type": "text/event-stream" } });
    }

    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async () => streamingResponsesResponse(),
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "forced",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });

    const writes: string[] = [];
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      writeHead(s: number, h?: Record<string, string>) {
        this.statusCode = s;
        if (h) Object.assign(this.headers, h);
      },
      write(c: string) {
        writes.push(String(c));
      },
      end(c?: string) {
        if (c) writes.push(String(c));
      },
    };

    await server.handle(
      fakeReq("/v1/responses", { model: "auto", stream: true, input: "hi" }),
      res
    );

    const all = writes.join("");
    // Should have piped upstream events, not fabricated from buffered JSON
    expect(all).toContain("Hello ");
    expect(all).toContain("World");
    expect(writes.length).toBeGreaterThan(1);
  });
});
