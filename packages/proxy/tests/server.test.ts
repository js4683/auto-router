import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { selectModel, type Catalog, type RouterConfig } from "@auto-router/router-core";
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

function fakeReq(url: string, body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = url;
  req.headers = { "content-type": "application/json", "x-session-id": "ses_test", ...headers };
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
    end(chunk?: string | Buffer) {
      if (chunk) body += String(chunk);
    },
  };
}

describe("proxy", () => {
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
              content: null,
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
      { type: "function_call", call_id: "call_read", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      { type: "function_call_output", call_id: "call_read", output: "auto-router" },
    ]));
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain('"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]');
    expect(res.body).toContain('"finish_reason":"tool_calls"');
  });

  it("translates Chat Completions tools to Gemini generateContent and back", async () => {
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
              content: null,
              tool_calls: [{ id: "call_read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
            },
            { role: "tool", tool_call_id: "call_read", content: "auto-router" },
          ],
          tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
        }
      ),
      res as never
    );

    expect(outbound[0].body.tools).toEqual([{ functionDeclarations: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }] }]);
    expect(outbound[0].body.contents).toEqual(expect.arrayContaining([
      { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "README.md" } } }] },
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

  it("accepts Anthropic /v1/messages and returns a Messages response", async () => {
    const outbound: Array<{ url: string; input: unknown; maxOutputTokens?: number }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body));
            outbound.push({ url: String(url), input: parsed.input, maxOutputTokens: parsed.max_output_tokens });
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
      fakeReq("/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 32,
        system: "Be brief.",
        messages: [{ role: "user", content: "implement the feature" }],
      }),
      res as never
    );

    expect(outbound[0].url).toBe("https://opencode.ai/zen/v1/responses");
    expect(outbound[0].input).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "implement the feature" },
    ]);
    expect(outbound[0].maxOutputTokens).toBe(32);
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
});
