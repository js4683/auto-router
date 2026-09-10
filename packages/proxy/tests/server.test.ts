import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJsonlRecorder, type EvalRecordInput, type EvalRecorder } from "@auto-router/eval";
import {
  selectModel,
  type AvengersProPrediction,
  type Catalog,
  type RouterConfig,
  type SelectionRequirements,
  type SessionState,
} from "@auto-router/router-core";
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
      capabilities: ["text", "tools", "vision", "structured-output"],
      transports: ["chat", "responses", "anthropic"],
    },
    {
      id: "gpt-5.6-sol",
      runtimeId: "openai/gpt-5.6-sol",
      codingIndex: 92,
      blendedPrice: 12,
      value: 7.6,
      windowTokens: 272000,
      isFree: false,
      capabilities: ["text", "tools", "vision", "structured-output"],
      transports: ["chat", "responses", "anthropic"],
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

const avengersPrediction: AvengersProPrediction = {
  paperIds: ["qwen/qwen3"],
  predictedQuality: { "qwen/qwen3": 0.9 },
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

function fakeRawReq(url: string, body: string, headers: Record<string, string | undefined> = {}): IncomingMessage {
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
    req.emit("data", Buffer.from(body));
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
  it("uses an advertised Google OAuth model during normal no-force routing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-discovery-route-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({ google: { type: "oauth", access: "google-token", projectId: "google-project", expires: Date.now() + 3_600_000 } }),
    );
    let discoveryCalls = 0;
    const server = createProxyServer({
      catalog: { ...catalog, models: [catalog.models[1]] },
      config,
      sessions: memorySessions(),
      authPath,
      backends: { google: { baseUrl: "https://daily-cloudcode-pa.googleapis.com" } },
      modelDiscovery: [
        {
          provider: "google",
          async discover(account) {
            discoveryCalls += 1;
            expect(account.token).toBe("google-token");
            return [{ id: "gemini-3.6-flash-high", capabilities: ["text", "tools"] }];
          },
        },
      ],
      select: selectModel,
    });

    for (const sessionId of ["discovery-one", "discovery-two"]) {
      const req = fakeReq("/v1/route", { messages: [{ role: "user", content: "hello" }] }, { "x-session-id": sessionId });
      const res = collectRes();
      await server.handle(req, res as never);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).modelId).toBe("google/gemini-3.6-flash-high");
    }

    expect(discoveryCalls).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the Google account that advertised the selected model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-discovery-account-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(
      authPath,
      JSON.stringify({ google: { type: "oauth", access: "primary-token", projectId: "google-project", expires: Date.now() + 3_600_000 } }),
    );
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [{ id: "google-extra", provider: "google", type: "oauth", access: "extra-token", expires: Date.now() + 3_600_000 }],
      }),
    );
    const requests: Array<{ url: string; authorization: string | null; body: any }> = [];
    const server = createProxyServer({
      catalog: { ...catalog, models: [catalog.models[1]] },
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {
        google: {
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          fetchImpl: async (input, init) => {
            requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      modelDiscovery: [
        {
          provider: "google",
          async discover(account) {
            if (account.id === "google-extra") {
              account.projectId = "extra-project";
              return [{ id: "gemini-extra", capabilities: ["text", "tools"] }];
            }
            return [{ id: "gemini-primary", capabilities: ["text", "tools"] }];
          },
        },
      ],
      select: () =>
        ({
          modelId: "google/gemini-extra",
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

    const req = fakeReq("/v1/chat/completions", { messages: [{ role: "user", content: "hello" }] }, { "x-session-id": "account-match" });
    const res = collectRes();
    await server.handle(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(requests).toEqual([
      {
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
        authorization: "Bearer extra-token",
        body: expect.objectContaining({ model: "gemini-extra", project: "extra-project" }),
      },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not fall back to an unadvertised Google account after cooldown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-discovery-cooldown-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(
      authPath,
      JSON.stringify({ google: { type: "oauth", access: "primary-token", expires: Date.now() + 3_600_000 } }),
    );
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [{ id: "google-extra", provider: "google", type: "oauth", access: "extra-token", expires: Date.now() + 3_600_000 }],
      }),
    );
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const authorizations: string[] = [];
    try {
      const server = createProxyServer({
        catalog: { ...catalog, models: [catalog.models[1]] },
        config,
        sessions: memorySessions(),
        authPath,
        accountsPath,
        backends: {
          google: {
            baseUrl: "https://daily-cloudcode-pa.googleapis.com",
            fetchImpl: async (input, init) => {
              authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
              expect(String(input)).toContain("v1internal:generateContent");
              return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
            },
          },
        },
        modelDiscovery: [
          {
           provider: "google",
           async discover(account) {
             account.projectId = `${account.id}-project`;
             return [{ id: account.id === "google-extra" ? "gemini-extra" : "gemini-primary", capabilities: ["text", "tools"] }];
           },
          },
        ],
        select: () =>
          ({
            modelId: "google/gemini-extra",
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
      await server.handle(fakeReq("/v1/chat/completions", { messages: [{ role: "user", content: "hello" }] }), res as never);

      expect(res.statusCode).toBe(429);
      expect(authorizations).toEqual(["Bearer extra-token"]);
    } finally {
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previousGoogleKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not run OAuth discovery when Gemini API-key routing is active", async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "api-key";
    const dir = mkdtempSync(join(tmpdir(), "ar-discovery-api-key-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ google: { type: "oauth", access: "oauth-token" } }));
    let discoveryCalls = 0;
    try {
      const server = createProxyServer({
        catalog: { ...catalog, models: [catalog.models[1]] },
        config,
        sessions: memorySessions(),
        authPath,
        backends: { google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta" } },
        modelDiscovery: [
          {
            provider: "google",
            async discover() {
              discoveryCalls += 1;
              return [{ id: "gemini-discovered", capabilities: ["text"] }];
            },
          },
        ],
        select: selectModel,
      });
      const req = fakeReq("/v1/route", { messages: [{ role: "user", content: "hello" }] }, { "x-session-id": "api-key-route" });
      const res = collectRes();
      await server.handle(req, res as never);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).modelId).toBe("openai/gpt-5.6-sol");
      expect(discoveryCalls).toBe(0);
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps absolute-form request targets on the configured upstream route", async () => {
    const upstreamUrls: string[] = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        xai: {
          baseUrl: "https://api.x.ai",
          apiKey: "configured-xai-key",
          fetchImpl: async (url, init) => {
            upstreamUrls.push(String(url));
            redirects.push(init?.redirect);
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      select: () =>
        ({
          modelId: "xai/grok-4.6",
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
    await server.handle(fakeReq("http://attacker.example/v1/chat/completions", { messages: [{ role: "user", content: "hello" }] }), res as never);

    expect(res.statusCode).toBe(200);
    expect(upstreamUrls).toEqual(["https://api.x.ai/v1/chat/completions"]);
    expect(redirects).toEqual(["error"]);
  });

  it("rejects unknown request paths before routing or provider calls", async () => {
    let backendCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        xai: {
          baseUrl: "https://api.x.ai",
          apiKey: "configured-xai-key",
          fetchImpl: async () => {
            backendCalls += 1;
            return new Response("unexpected");
          },
        },
      },
      select: () => {
        throw new Error("unknown path was routed");
      },
    });

    const res = collectRes();
    await server.handle(fakeReq("http://attacker.example/credential-capture", { messages: [{ role: "user", content: "hello" }] }), res as never);

    expect(res.statusCode).toBe(404);
    expect(backendCalls).toBe(0);
  });

  it("does not forward a Chat bearer token to Google", async () => {
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    try {
      const server = createProxyServer({
        catalog,
        config,
        sessions: memorySessions(),
        backends: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            fetchImpl: async (url, init) => {
              requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
              return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
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
      await server.handle(fakeReq("/v1/chat/completions", { messages: [{ role: "user", content: "hello" }] }, { authorization: "Bearer inbound-openai-token" }), res as never);

      expect(res.statusCode).toBe(200);
      expect(requests).toEqual([
        {
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
          authorization: null,
        },
      ]);
    } finally {
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previousGoogleKey;
    }
  });

  it("does not forward a Chat bearer token as an Anthropic API key", async () => {
    const requests: Array<{ url: string; apiKey: string | null; authorization: string | null }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          fetchImpl: async (url, init) => {
            const headers = new Headers(init?.headers);
            requests.push({ url: String(url), apiKey: headers.get("x-api-key"), authorization: headers.get("authorization") });
            return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }), {
              headers: { "content-type": "application/json" },
            });
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
    await server.handle(fakeReq("/v1/chat/completions", { messages: [{ role: "user", content: "hello" }] }, { authorization: "Bearer inbound-openai-token" }), res as never);

    expect(res.statusCode).toBe(200);
    expect(requests).toEqual([{ url: "https://api.anthropic.com/v1/messages", apiKey: null, authorization: null }]);
  });

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
      rankAvengers: () => avengersPrediction,
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
      rankAvengers: () => avengersPrediction,
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
        return avengersPrediction;
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

  it("passes hard routing requirements derived from the normalized request", async () => {
    let requirements: SelectionRequirements | undefined;
    const server = createProxyServer({
      catalog: {
        ...catalog,
        models: catalog.models.map((model) => ({
          ...model,
          capabilities: ["text", "tools", "vision", "structured-output"],
          transports: ["responses"],
        })),
      },
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://backend.test",
          fetchImpl: async () => new Response(JSON.stringify({ id: "ok", output: [] }), { status: 200 }),
        },
      },
      select: ((...args: Parameters<typeof selectModel>) => {
        requirements = args[7];
        return selectModel(...args);
      }) as typeof selectModel,
    });

    await server.handle(
      fakeReq("/v1/responses", {
        model: "auto",
        input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] }],
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        text: { format: { type: "json_object" } },
      }),
      collectRes() as never,
    );

    expect(requirements).toEqual({
      lifetimeTokens: expect.any(Number),
      requiredCapabilities: ["text", "tools", "vision", "structured-output"],
      transport: "responses",
    });
  });

  it("reselects for a long run task but holds the target for a short follow-up", async () => {
    const selections: ReturnType<typeof selectModel>[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {},
      select: ((...args: Parameters<typeof selectModel>) => {
        const result = selectModel(...args);
        selections.push(result);
        return result;
      }) as typeof selectModel,
    });
    const toolCalls = Array.from({ length: 8 }, (_, index) => ({
      id: `read-${index}`,
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: `src/file-${index}.ts` }) },
    }));
    const history = [
      { role: "user", content: "plan the architecture" },
      { role: "assistant", content: null, tool_calls: toolCalls },
    ];
    const route = async (messages: unknown[]) => {
      const res = collectRes();
      await server.handle(
        fakeReq("/v1/route", { model: "auto", messages }, { "x-session-id": "run-boundary" }),
        res as never
      );
      return JSON.parse(res.body) as { modelId: string; via: string };
    };

    const initial = await route([{ role: "user", content: "plan the architecture" }]);
    const longRun = await route([
      ...history,
      {
        role: "user",
        content:
          "run the complete test suite, lint checks, type checks, build verification, and integration checks, then report every failure with the affected file and command",
      },
    ]);
    const shortRun = await route([...history, { role: "user", content: "run that again, please" }]);

    expect(initial.modelId).toBe("openai/gpt-5.6-sol");
    expect(longRun.modelId).toBe("opencode/muse-spark-1.2-contributor-free");
    expect(selections).toHaveLength(2);
    expect(selections.map((selection) => selection.boundary.isBoundary)).toEqual([true, true]);
    expect(shortRun).toEqual({ modelId: longRun.modelId, via: "stay-sticky" });
  });

  it("does not keep a sticky target that no longer fits the session", async () => {
    const overflowCatalog: Catalog = {
      fetchedAt: "t",
      source: "live",
      models: [
        {
          id: "tiny",
          runtimeId: "opencode/tiny",
          codingIndex: 70,
          blendedPrice: 0,
          value: 700,
          windowTokens: 12000,
          isFree: true,
          capabilities: ["text", "tools", "vision", "structured-output"],
          transports: ["chat", "responses", "anthropic"],
        },
        {
          id: "wide",
          runtimeId: "openai/wide",
          codingIndex: 92,
          blendedPrice: 12,
          value: 7.6,
          windowTokens: 272000,
          isFree: false,
          capabilities: ["text", "tools", "vision", "structured-output"],
          transports: ["chat", "responses", "anthropic"],
        },
      ],
    };
    const server = createProxyServer({
      catalog: overflowCatalog,
      config,
      sessions: memorySessions(),
      backends: {},
      select: selectModel,
    });
    const first = collectRes();
    await server.handle(fakeReq("/v1/route", { messages: [{ role: "user", content: "hi" }] }, { "x-session-id": "overflow-lock" }), first as never);
    expect(JSON.parse(first.body).modelId).toBe("opencode/tiny");

    await expect(
      server.handle(
        fakeReq(
          "/v1/route",
          {
            messages: [
              { role: "user", content: "hi" },
              { role: "assistant", content: "x".repeat(20000) },
              { role: "user", content: "continue" },
            ],
          },
          { "x-session-id": "overflow-lock" },
        ),
        collectRes() as never,
      ),
    ).rejects.toMatchObject({ name: "SelectionConstraintError", code: "context-overflow" });
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
      rankAvengers: () => avengersPrediction,
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

  it("forwards the complete Avengers-Pro prediction to the selector", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {},
      rankAvengers: () => avengersPrediction,
      select: ((...args: Parameters<typeof selectModel>) => {
        const prediction = args[6] as AvengersProPrediction | undefined;
        return {
          modelId:
            prediction?.predictedQuality?.["qwen/qwen3"] === 0.9
              ? "opencode/muse-spark-1.2-contributor-free"
              : "openai/gpt-5.6-sol",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "prediction plumbing",
          via: "avengers-pro",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        };
      }) as typeof selectModel,
    });
    const res = collectRes();

    await server.handle(
      fakeReq("/v1/route", { model: "auto", messages: [{ role: "user", content: "implement the feature" }] }),
      res as never
    );

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
      rankAvengers: () => avengersPrediction,
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
      rankAvengers: () => avengersPrediction,
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

  it("sends Google OAuth targets to Antigravity Cloud Code Assist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-gemini-oauth-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        google: {
          type: "oauth",
          access: "ya29.antigravity",
          refresh: "refresh-antigravity",
          expires: Date.now() + 3_600_000,
          projectId: "antigravity-project",
        },
      }),
    );
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    let url = "";
    let authorization = "";
    let userAgent = "";
    let requestBody: any;
    try {
      const server = createProxyServer({
        catalog,
        config,
        sessions: memorySessions(),
        authPath,
        backends: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            fetchImpl: async (target, init) => {
              url = String(target);
              authorization = new Headers(init?.headers).get("authorization") ?? "";
              userAgent = new Headers(init?.headers).get("user-agent") ?? "";
              requestBody = JSON.parse(String(init?.body));
              return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "OK" }] } }] } }), {
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
      await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);

      expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
      expect(authorization).toBe("Bearer ya29.antigravity");
      expect(userAgent).toBe(`antigravity/hub/2.9.1 ${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`);
      expect(requestBody).toMatchObject({
        model: "gemini-3.6-flash-high",
        project: "antigravity-project",
        userAgent: "antigravity",
        requestType: "agent",
        requestId: expect.stringMatching(/^agent-/),
        request: { sessionId: expect.stringMatching(/^-/) },
      });
      expect(JSON.parse(res.body)).toMatchObject({ choices: [{ message: { content: "OK" } }] });
    } finally {
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previousGoogleKey;
    }
  });

  it("refreshes a stale Google OAuth token after Cloud Code Assist rejects it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-gemini-oauth-refresh-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        google: {
          type: "oauth",
          access: "stale-google-access",
          refresh: "google-refresh-token",
          expires: Date.now() + 3_600_000,
          projectId: "antigravity-project",
        },
      }),
    );
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousGoogleKey = process.env.GOOGLE_API_KEY;
    const previousGoogleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const previousGoogleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id";
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const authorizationHeaders: string[] = [];
    try {
      const server = createProxyServer({
        catalog,
        config,
        sessions: memorySessions(),
        authPath,
        backends: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            fetchImpl: async (target, init) => {
              const url = String(target);
              if (url === "https://oauth2.googleapis.com/token") {
                return new Response(JSON.stringify({ access_token: "fresh-google-access", refresh_token: "fresh-google-refresh", expires_in: 3600 }));
              }
              if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent") {
                const authorization = new Headers(init?.headers).get("authorization") ?? "";
                authorizationHeaders.push(authorization);
                if (authorization === "Bearer stale-google-access") {
                  return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), { status: 401 });
                }
                return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }), {
                  headers: { "content-type": "application/json" },
                });
              }
              throw new Error(`unexpected request: ${url}`);
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
      await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);

      expect(res.statusCode).toBe(200);
      expect(authorizationHeaders).toEqual(["Bearer stale-google-access", "Bearer fresh-google-access"]);
      expect(JSON.parse(res.body)).toMatchObject({ choices: [{ message: { content: "OK" } }] });
      expect(JSON.parse(readFileSync(authPath, "utf8")).google).toMatchObject({
        access: "fresh-google-access",
        refresh: "fresh-google-refresh",
      });
    } finally {
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previousGoogleKey;
      if (previousGoogleClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      else process.env.GOOGLE_OAUTH_CLIENT_ID = previousGoogleClientId;
      if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previousGoogleClientSecret;
    }
  });

  it("rejects the synthetic fixture through production bootstrap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auto-router-avengers-"));
    const configPath = join(directory, "enabled.json");
    writeFileSync(configPath, JSON.stringify({
      tiers: { simple: { minQuality: 0 }, medium: { minQuality: 60 }, complex: { minQuality: 80 } },
      avengersPro: { enabled: true, artifactDir: "./packages/router-core/artifacts/avengers-pro/fixture", timeoutMs: 400, maxInputChars: 16000 },
    }));
    vi.stubEnv("AUTO_ROUTER_CONFIG", configPath);
    try {
      const { bootstrapProxyOptions } = await import("../src/server.js");
      const opts = bootstrapProxyOptions();
      expect(opts.rankAvengers).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the configured upstream timeout for provider requests", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const server = createProxyServer({
        catalog,
        config,
        sessions: memorySessions(),
        upstreamTimeoutMs: 25,
        backends: {
          openai: {
            baseUrl: "https://api.openai.com",
            fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })),
          },
        },
        select: () =>
          ({
            modelId: "openai/gpt-5.6-sol",
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

      await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hello" }] }), collectRes() as never);

      expect(timeout).toHaveBeenCalledWith(25);
    } finally {
      timeout.mockRestore();
    }
  });

  it("returns a single gateway timeout when the upstream never completes", async () => {
    let calls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      upstreamTimeoutMs: 10,
      backends: {
        openai: {
          baseUrl: "https://openai.test",
          fetchImpl: async (_url, init) => {
            calls += 1;
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            });
          },
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

    const res = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "wait" }] }), res as never);

    expect(calls).toBe(1);
    expect(res.statusCode).toBe(504);
    expect(res.body).toContain("upstream request timed out");
  });

  it("returns a client error for malformed inference JSON", async () => {
    const server = createProxyServer({ catalog, config, sessions: memorySessions(), backends: {}, select: selectModel });
    const res = collectRes();

    await expect(server.handle(fakeRawReq("/v1/chat/completions", "{"), res as never)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("invalid json");
  });

  it("reads the upstream timeout from the proxy environment", async () => {
    vi.stubEnv("AUTO_ROUTER_UPSTREAM_TIMEOUT_MS", "300000");
    try {
      const { bootstrapProxyOptions } = await import("../src/server.js");
      expect(bootstrapProxyOptions().upstreamTimeoutMs).toBe(300000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports the active Avengers artifact digest in route responses", async () => {
    const artifactDigest = "a".repeat(64);
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {},
      avengersArtifactDigest: artifactDigest,
      rankAvengers: () => avengersPrediction,
      select: () =>
        ({
          modelId: "opencode/muse-spark-1.2-contributor-free",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "fixture",
          via: "avengers-pro",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        }) as never,
    });
    const res = collectRes();

    await server.handle(fakeReq("/v1/route", { model: "auto", messages: [{ role: "user", content: "smoke" }] }), res as never);

    expect(JSON.parse(res.body)).toMatchObject({ via: "avengers-pro", artifactDigest });
  });

  it("lets an injected async prediction drive avengers-pro selection", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {},
      rankAvengers: async () => avengersPrediction,
      select: selectModel,
    });
    const res = collectRes();
    await server.handle(
      fakeReq("/v1/route", { model: "auto", messages: [{ role: "user", content: "implement the feature" }] }),
      res as never
    );
    expect(JSON.parse(res.body)).toMatchObject({ via: "avengers-pro" });
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
      rankAvengers: () => avengersPrediction,
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

  it("scopes Gemini thought signatures to the stable session and generates missing call IDs", async () => {
    const requests: any[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com",
          apiKey: "AIza-test-key",
          fetchImpl: async (_url, init) => {
            requests.push(JSON.parse(String((init as RequestInit).body)));
            return new Response(JSON.stringify({
              candidates: [{
                content: { parts: [{ functionCall: { name: "read_file", args: { path: "README.md" } }, thoughtSignature: "sig-a" }] },
                finishReason: "STOP",
              }],
            }), { headers: { "content-type": "application/json" } });
          },
        },
      },
      select: () => ({
        modelId: "google/gemini-3-flash",
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

    const first = collectRes();
    await server.handle(
      fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "read README" }] }, { "x-session-id": "gemini-one" }),
      first as never,
    );
    const generatedCallId = JSON.parse(first.body).choices[0].message.tool_calls[0].id;

    const continuation = {
      model: "auto",
      messages: [
        { role: "user", content: "read README" },
        { role: "assistant", content: null, tool_calls: [{ id: generatedCallId, type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
        { role: "tool", tool_call_id: generatedCallId, content: "contents" },
      ],
    };
    await server.handle(fakeReq("/v1/chat/completions", continuation, { "x-session-id": "gemini-one" }), collectRes() as never);
    await server.handle(fakeReq("/v1/chat/completions", continuation, { "x-session-id": "gemini-two" }), collectRes() as never);

    const signature = requests[1].contents.flatMap((item: any) => item.parts ?? []).find((part: any) => part.functionCall)?.thoughtSignature;
    const otherSessionSignature = requests[2].contents.flatMap((item: any) => item.parts ?? []).find((part: any) => part.functionCall)?.thoughtSignature;
    expect(generatedCallId).toMatch(/^call_/);
    expect(signature).toBe("sig-a");
    expect(otherSessionSignature).toBeUndefined();
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
      rankAvengers: () => avengersPrediction,
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq(
        "/v1/messages?beta=true",
        {
          model: "auto",
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
      rankAvengers: () => avengersPrediction,
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
      rankAvengers: () => avengersPrediction,
      select: selectModel,
    });

    const res = collectRes();
    await server.handle(
      fakeReq("/v1/messages", {
        model: "auto",
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
      rankAvengers: () => avengersPrediction,
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

  it("treats POST /messages like Anthropic Messages, not Chat Completions", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          apiKey: "sk-test",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                id: "chatcmpl_ok",
                choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
              }),
            ),
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
      fakeReq("/messages", {
        model: "auto",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      res as never,
    );
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain("event: message_start");
    expect(res.body).toContain('"type":"message_start"');
    expect(res.body).not.toContain("chat.completion.chunk");
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
                usage: {
                  input_tokens: 9,
                  output_tokens: 4,
                  cache_read_input_tokens: 2,
                  cache_creation_input_tokens: 1,
                },
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
    expect(JSON.parse(res.body)).toMatchObject({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        prompt_tokens_details: { cached_tokens: 2, cache_creation_tokens: 1 },
      },
    });
  });

  it("pins Claude Code subscription models to Anthropic", async () => {
    const outbound: string[] = [];
    let selectCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          apiKey: "anthropic-backend-key",
          fetchImpl: async (url) => {
            outbound.push(String(url));
            return new Response(
              JSON.stringify({
                id: "msg_ok",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "hi" }],
                stop_reason: "end_turn",
              }),
            );
          },
        },
        opencode: { baseUrl: "https://opencode.ai/zen", fetchImpl: async () => new Response("{}") },
      },
      select: () => {
        selectCalls += 1;
        return {
          modelId: "opencode/muse-spark-1.2-contributor-free",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "fixture",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        } as never;
      },
    });
    const res = collectRes();
    await server.handle(
      fakeReq("/v1/messages", {
        model: "claude-sonnet-4-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
      res as never,
    );
    expect(selectCalls).toBe(0);
    expect(outbound[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(res.statusCode).toBe(200);
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
      fakeReq("/v1/responses?stream=false", { model: "auto", input: "implement the feature" }),
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
        { model: "auto", messages: [{ role: "user", content: "hello" }] },
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
    expect(records[0]).toMatchObject({ status: "completed", usageSource: "estimated", requiredCapabilities: ["text"], sessionStable: true });
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
      expect(record.sessionStable).toBe(false);
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
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Hello " }] } }] } })}\r\n\r\n`,
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "World" }] } }] } })}\r\n\r\n`,
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

  it("serves a settings page without leaking env values", async () => {
    process.env.OPENAI_API_KEY = "sk-secret-test";
    const dir = mkdtempSync(join(tmpdir(), "ar-settings-"));
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-secret-test\n", { mode: 0o600 });
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      envPath: join(dir, ".env"),
      backends: { opencode: { baseUrl: "https://opencode.ai/zen", fetchImpl: async () => new Response("{}") } },
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
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/";
    req.headers = {};
    queueMicrotask(() => req.emit("end"));
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.body).toContain("auto-router");
    expect(res.body).toContain("Quota Management");
    expect(res.body).toContain("Recent routes");
    expect(res.body).toContain("No routes yet.");
    expect(res.body).not.toContain("sk-secret-test");
  });

  it("saves non-empty settings to the env file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-settings-"));
    const envPath = join(dir, ".env");
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      envPath,
      backends: { opencode: { baseUrl: "https://opencode.ai/zen", fetchImpl: async () => new Response("{}") } },
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
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/settings";
    req.headers = { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded" };
    queueMicrotask(() => {
      req.emit("data", Buffer.from("ANTHROPIC_API_KEY=sk-ant-1&GEMINI_API_KEY="));
      req.emit("end");
    });
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(303);
    expect(readFileSync(envPath, "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-1");
    expect(readFileSync(envPath, "utf8")).not.toContain("GEMINI_API_KEY=");
  });

  it("rejects oversized settings bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-body-"));
    const envPath = join(dir, ".env");
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      envPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/settings";
    req.headers = { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded" };
    queueMicrotask(() => {
      req.emit("data", Buffer.alloc(70_000, 97));
      req.emit("end");
    });
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(413);
  });

  it("rejects settings posts from a foreign origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-csrf-"));
    const envPath = join(dir, ".env");
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      envPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/settings";
    req.headers = { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" };
    queueMicrotask(() => {
      req.emit("data", Buffer.from("ANTHROPIC_API_KEY=sk-stolen"));
      req.emit("end");
    });
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(403);
    expect(() => readFileSync(envPath, "utf8")).toThrow();
  });

  it("requires matching loopback authority and peer for management mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-management-boundary-"));
    const envPath = join(dir, ".env");
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      envPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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

    const cases = [
      { host: "10.0.0.8:8787", origin: "http://127.0.0.1:8787" },
      { host: "127.0.0.1:8787", origin: "http://127.0.0.1:9999" },
      { origin: "http://127.0.0.1:8787" },
    ];
    for (const headers of cases) {
      const req = new IncomingMessage(new Socket());
      req.method = "POST";
      req.url = "/settings";
      req.headers = { "content-type": "application/x-www-form-urlencoded", ...headers };
      queueMicrotask(() => {
        req.emit("data", Buffer.from("ANTHROPIC_API_KEY=sk-rejected"));
        req.emit("end");
      });
      const res = collectRes();
      await server.handle(req, res as never);
      expect(res.statusCode).toBe(403);
    }

    const remoteReq = new IncomingMessage(new Socket());
    Object.defineProperty(remoteReq.socket, "remoteAddress", { value: "10.0.0.8" });
    remoteReq.method = "POST";
    remoteReq.url = "/settings";
    remoteReq.headers = { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded" };
    queueMicrotask(() => {
      remoteReq.emit("data", Buffer.from("ANTHROPIC_API_KEY=sk-rejected"));
      remoteReq.emit("end");
    });
    const remoteRes = collectRes();
    await server.handle(remoteReq, remoteRes as never);
    expect(remoteRes.statusCode).toBe(403);
    expect(() => readFileSync(envPath, "utf8")).toThrow();
  });

  it("accepts an IPv6 loopback Host for management mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-management-ipv6-"));
    const envPath = join(dir, ".env");
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      envPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/settings";
    req.headers = { host: "[::1]:8787", "content-type": "application/x-www-form-urlencoded" };
    queueMicrotask(() => {
      req.emit("data", Buffer.from("ANTHROPIC_API_KEY=sk-ipv6"));
      req.emit("end");
    });
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(303);
  });

  it("does not assign unexpected env keys from settings", async () => {
    const previous = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), "ar-env-allow-"));
    const envPath = join(dir, ".env");
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      envPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/settings";
    req.headers = { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded" };
    queueMicrotask(() => {
      req.emit("data", Buffer.from("PATH=/tmp/evil&ANTHROPIC_API_KEY=sk-ant-2"));
      req.emit("end");
    });
    const res = collectRes();
    await server.handle(req, res as never);
    try {
    expect(res.statusCode).toBe(303);
    expect(process.env.PATH).toBe(previous);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-2");
    } finally {
      if (previous !== undefined) process.env.PATH = previous;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("attaches OpenCode auth token when backend apiKey is missing", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const dir = mkdtempSync(join(tmpdir(), "ar-auth-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth", access: "tok-from-auth" } }));
    let authorization = "";
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async (_url, init) => {
            authorization = String(new Headers(init?.headers).get("authorization") ?? "");
            return new Response(JSON.stringify({
              choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            }), { headers: { "content-type": "application/json" } });
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);
    expect(authorization).toBe("Bearer tok-from-auth");
    if (previous) process.env.OPENAI_API_KEY = previous;
  });

  it("rejects unknown login providers", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/login/cursor";
    req.headers = {};
    queueMicrotask(() => req.emit("end"));
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(404);
  });

  it("serves a connect page and saves an API key to auth.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-connect-"));
    const authPath = join(dir, "auth.json");
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const pageReq = new IncomingMessage(new Socket());
    pageReq.method = "GET";
    pageReq.url = "/connect/openai";
    pageReq.headers = {};
    queueMicrotask(() => pageReq.emit("end"));
    const pageRes = collectRes();
    await server.handle(pageReq, pageRes as never);
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.body).toContain("Connect OpenAI");
    expect(pageRes.body).toContain("Subscription login");

    const claudeReq = new IncomingMessage(new Socket());
    claudeReq.method = "GET";
    claudeReq.url = "/connect/anthropic";
    claudeReq.headers = {};
    queueMicrotask(() => claudeReq.emit("end"));
    const claudeRes = collectRes();
    await server.handle(claudeReq, claudeRes as never);
    expect(claudeRes.statusCode).toBe(200);
    expect(claudeRes.body).toContain("Connect Claude");
    expect(claudeRes.body).toContain("Authorization code");

    const geminiReq = new IncomingMessage(new Socket());
    geminiReq.method = "GET";
    geminiReq.url = "/connect/google";
    geminiReq.headers = {};
    queueMicrotask(() => geminiReq.emit("end"));
    const geminiRes = collectRes();
    await server.handle(geminiReq, geminiRes as never);
    expect(geminiRes.statusCode).toBe(200);
    expect(geminiRes.body).toContain("Connect Gemini");
    expect(geminiRes.body).toContain("Subscription login");

    const keyReq = new IncomingMessage(new Socket());
    keyReq.method = "POST";
    keyReq.url = "/connect/openai/key";
    keyReq.headers = { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded" };
    queueMicrotask(() => {
      keyReq.emit("data", Buffer.from("key=sk-test-connect"));
      keyReq.emit("end");
    });
    const keyRes = collectRes();
    await server.handle(keyReq, keyRes as never);
    expect(keyRes.statusCode).toBe(303);
    expect(readFileSync(authPath, "utf8")).toContain("sk-test-connect");
  });

  it("rejects OAuth management requests from non-loopback hosts", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    for (const [method, url] of [
      ["POST", "/connect/google/oauth/start"],
      ["POST", "/connect/google/oauth/code"],
      ["GET", "/connect/google/oauth/callback?state=test&code=test"],
      ["GET", "/connect/google/oauth/poll?id=test"],
    ] as const) {
      const req = new IncomingMessage(new Socket());
      req.method = method;
      req.url = url;
      req.headers = { host: "10.0.0.8:8787" };
      const res = collectRes();
      await server.handle(req, res as never);
      expect(res.statusCode).toBe(403);
    }
  });

  it("does not crash on GET /favicon.ico", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/favicon.ico";
    req.headers = {};
    queueMicrotask(() => req.emit("end"));
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(404);
  });

  it("fails over from OpenCode Zen billing errors", async () => {
    let openaiCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () =>
            new Response(JSON.stringify({ error: { message: "Add a payment method to use this model." } }), { status: 400 }),
        },
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async () => {
            openaiCalls += 1;
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      select: (_state, cat) => {
        const zen = cat.models.find((model) => (model.runtimeId ?? model.id).startsWith("opencode/"));
        return {
          modelId: zen?.runtimeId ?? "openai/gpt-5.6-sol",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "fixture",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        } as never;
      },
    });
    const req = fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] });
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(openaiCalls).toBe(1);
    expect(res.body).toContain("ok");
  });

  it("fails over when Zen rejects a request outside the OpenCode client", async () => {
    const googleModel = {
      id: "gemini-3.6-flash-high",
      runtimeId: "google/gemini-3.6-flash-high",
      codingIndex: 80,
      blendedPrice: 1,
      value: 80,
      windowTokens: 128000,
      isFree: false,
    };
    const server = createProxyServer({
      catalog: { ...catalog, models: [...catalog.models, googleModel] },
      config,
      sessions: memorySessions(),
      backends: {
        opencode: {
          baseUrl: "https://opencode.ai/zen",
          fetchImpl: async () =>
            new Response(JSON.stringify({ type: "error", error: { type: "MissingSessionID", message: "OpenCode's free tier can only be used in OpenCode" } }), { status: 400 }),
        },
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          fetchImpl: async () =>
            new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "google fallback" }] } }] }), {
              headers: { "content-type": "application/json" },
            }),
        },
      },
      select: (_state, cat) => {
        const zen = cat.models.find((model) => (model.runtimeId ?? model.id).startsWith("opencode/"));
        const google = cat.models.find((model) => (model.runtimeId ?? model.id).startsWith("google/"));
        return {
          modelId: zen?.runtimeId ?? google?.runtimeId ?? "openai/gpt-5.6-sol",
          tier: "simple",
          taskType: null,
          confidence: 1,
          reason: "fixture",
          via: "force",
          catalogSource: "live",
          score: 0,
          boundary: { isBoundary: true, confidence: 1, signals: ["newSession"], reason: "new session" },
        } as never;
      },
    });
    const res = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("google fallback");
  });

  it("shows the last routed model on the dashboard", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), collectRes() as never);
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/";
    req.headers = {};
    queueMicrotask(() => req.emit("end"));
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.body).toContain("openai/gpt-5.6-sol");
    expect(res.body).toContain("force");
  });

  it("shows quota percent from upstream rate-limit headers", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          apiKey: "k",
          fetchImpl: async () =>
            new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "anthropic-ratelimit-requests-limit": "100",
                "anthropic-ratelimit-requests-remaining": "65",
              },
            }),
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
    await server.handle(
      fakeReq("/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      collectRes() as never,
    );
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/";
    req.headers = {};
    queueMicrotask(() => req.emit("end"));
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.body).toContain("35%");
    expect(res.body).toContain("65 / 100 remaining");
  });

  it("saves a second API key as an extra account without overwriting primary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-extra-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-primary" } }));
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const keyReq = new IncomingMessage(new Socket());
    keyReq.method = "POST";
    keyReq.url = "/connect/openai/key";
      keyReq.headers = { host: "127.0.0.1:8787", "content-type": "application/x-www-form-urlencoded" };
    queueMicrotask(() => {
      keyReq.emit("data", Buffer.from("key=sk-extra"));
      keyReq.emit("end");
    });
    const keyRes = collectRes();
    await server.handle(keyReq, keyRes as never);
    expect(keyRes.statusCode).toBe(303);
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("sk-primary");
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts[0].key).toBe("sk-extra");
  });

  it("rotates to the next same-provider account after HTTP 429", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-rotate-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-limited" } }));
    writeFileSync(accountsPath, JSON.stringify({ accounts: [{ id: "extra-1", provider: "openai", type: "api", key: "sk-open" }] }));
    const used: string[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async (_url, init) => {
            const token = String(new Headers(init?.headers).get("authorization") ?? "");
            used.push(token);
            if (token === "Bearer sk-limited") {
              return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } });
            }
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);
    expect(used).toEqual(["Bearer sk-limited", "Bearer sk-open"]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("ok");

    const second = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "again" }] }), second as never);
    expect(used).toEqual(["Bearer sk-limited", "Bearer sk-open", "Bearer sk-limited", "Bearer sk-open"]);
  });

  it("refreshes an extra oauth account before retrying after 429", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-rotate-refresh-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-limited" } }));
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [
          {
            id: "extra-1",
            provider: "openai",
            type: "oauth",
            access: "old-extra",
            refresh: "extra-refresh",
            expires: Date.now() - 1000,
          },
        ],
      }),
    );
    const used: string[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async (url, init) => {
            const target = String(url);
            if (target.includes("/oauth/token")) {
              expect(String(init?.body)).toContain("extra-refresh");
              return new Response(JSON.stringify({ access_token: "new-extra", refresh_token: "new-extra-refresh", expires_in: 3600 }));
            }
            const token = String(new Headers(init?.headers).get("authorization") ?? "");
            used.push(token);
            if (token === "Bearer sk-limited") {
              return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json" } });
            }
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);
    expect(used).toEqual(["Bearer sk-limited", "Bearer new-extra"]);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts[0].access).toBe("new-extra");
  });

  it("lists each extra account on the dashboard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-dash-acct-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth", access: "tok-one", email: "one@example.com" } }));
    writeFileSync(
      accountsPath,
      JSON.stringify({ accounts: [{ id: "extra-1", provider: "openai", type: "api", key: "sk-two", email: "two@example.com" }] }),
    );
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/";
    req.headers = {};
    queueMicrotask(() => req.emit("end"));
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.body).toContain("codex-one@example.com");
    expect(res.body).toContain("codex-two@example.com");
    expect(res.body).not.toContain("tok-one");
    expect(res.body).not.toContain("sk-two");
    expect(res.body).toContain('data-remove="extra-1"');
  });

  it("removes an extra account without touching primary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-rm-acct-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-primary" } }));
    writeFileSync(
      accountsPath,
      JSON.stringify({ accounts: [{ id: "extra-1", provider: "openai", type: "api", key: "sk-extra" }] }),
    );
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {},
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/accounts/remove";
    req.headers = { host: "127.0.0.1:8787", "content-type": "application/json" };
    queueMicrotask(() => {
      req.emit("data", Buffer.from(JSON.stringify({ id: "extra-1" })));
      req.emit("end");
    });
    const res = collectRes();
    await server.handle(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("sk-primary");
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts).toEqual([]);
  });

  it("returns 429 after every same-provider account is limited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-429-all-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-0" } }));
    writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: Array.from({ length: 6 }, (_, i) => ({ id: `extra-${i + 1}`, provider: "openai", type: "api", key: `sk-${i + 1}` })),
      }),
    );
    let calls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async () => {
            calls += 1;
            return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json" } });
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);
    expect(res.statusCode).toBe(429);
    expect(calls).toBe(7);
  });

  it("does not reuse the primary credential while every account is cooling down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-429-cooldown-reuse-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-0" } }));
    writeFileSync(
      accountsPath,
      JSON.stringify({ accounts: [{ id: "extra-1", provider: "openai", type: "api", key: "sk-1" }] }),
    );
    let calls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async () => {
            calls += 1;
            return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json" } });
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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

    const first = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", { messages: [{ role: "user", content: "one" }] }, { "x-session-id": "cooldown-one" }), first as never);
    expect(first.statusCode).toBe(429);
    expect(calls).toBe(2);

    const second = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", { messages: [{ role: "user", content: "two" }] }, { "x-session-id": "cooldown-two" }), second as never);
    expect(second.statusCode).toBe(429);
    expect(calls).toBe(2);
  });

  it("uses the Gemini API key instead of an extra Google OAuth token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-gemini-extra-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ google: { type: "oauth", access: "ya29.primary" } }));
    writeFileSync(accountsPath, JSON.stringify({ accounts: [{ id: "g-extra", provider: "google", type: "oauth", access: "ya29.extra" }] }));
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "AIza-test";
    let url = "";
    try {
      const server = createProxyServer({
        catalog,
        config,
        sessions: memorySessions(),
        authPath,
        accountsPath,
        backends: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: "AIza-test",
            fetchImpl: async (target) => {
              url = String(target);
              return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
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
      await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }), res as never);
      expect(url).toContain("AIza-test");
      expect(url).not.toContain("ya29.extra");
    } finally {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
    }
  });

  it("keeps task stickiness across headerless follow-ups in the same thread", async () => {
    const vias: string[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
              headers: { "content-type": "application/json" },
            }),
        },
      },
      select: (_state, _cat, _cfg, _sticky, _cap, _prev, _pred) =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    const first = fakeReq(
      "/v1/chat/completions",
      { model: "auto", conversation_id: "thread-1", messages: [{ role: "user", content: "plan the architecture" }] },
      { "x-session-id": undefined },
    );
    await server.handle(first, collectRes() as never);
    const second = fakeReq(
      "/v1/chat/completions",
      {
        model: "auto",
        conversation_id: "thread-1",
        messages: [
          { role: "user", content: "plan the architecture" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "now write the tests" },
        ],
      },
      { "x-session-id": undefined },
    );
    const originalLog = console.log;
    console.log = (msg?: unknown) => {
      const line = String(msg ?? "");
      const via = line.match(/\[auto-router-proxy\] (\S+)/);
      if (via?.[1]) vias.push(via[1]);
    };
    try {
      await server.handle(second, collectRes() as never);
    } finally {
      console.log = originalLog;
    }
    expect(vias.at(-1)).toBe("stay-sticky");
  });

  it("skips a rate-limited account on the next request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-cool-"));
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-limited" } }));
    writeFileSync(accountsPath, JSON.stringify({ accounts: [{ id: "extra-1", provider: "openai", type: "api", key: "sk-open" }] }));
    const used: string[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      authPath,
      accountsPath,
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async (_url, init) => {
            const token = String(new Headers(init?.headers).get("authorization") ?? "");
            used.push(token);
            if (token === "Bearer sk-limited") {
              return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json" } });
            }
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "one" }] }), collectRes() as never);
    used.length = 0;
    const res = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "two" }] }), res as never);
    expect(used).toEqual(["Bearer sk-open"]);
    expect(res.statusCode).toBe(200);
  });

  it("translates Responses clients when the target is xAI chat", async () => {
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        xai: {
          baseUrl: "https://api.x.ai",
          apiKey: "xai-k",
          fetchImpl: async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: "grok-ok" }, finish_reason: "stop" }] }), {
              headers: { "content-type": "application/json" },
            }),
        },
      },
      select: () =>
        ({
          modelId: "xai/grok-4.6",
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
    await server.handle(fakeReq("/v1/responses", { model: "auto", input: "hi" }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("grok-ok");
    expect(res.body).toContain("output_text");
  });

  it("lets x-force-model override an existing task lock", async () => {
    const models: string[] = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "https://api.openai.com",
          fetchImpl: async (_url, init) => {
            models.push("openai");
            return new Response(JSON.stringify({ choices: [{ message: { content: "o" } }] }), { headers: { "content-type": "application/json" } });
          },
        },
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          apiKey: "k",
          fetchImpl: async () => {
            models.push("anthropic");
            return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "a" }], stop_reason: "end_turn" }), {
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
      select: () =>
        ({
          modelId: "openai/gpt-5.6-sol",
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
    await server.handle(
      fakeReq("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "same thread" }] }, { "x-force-model": "openai/gpt-5.6-sol" }),
      collectRes() as never,
    );
    await server.handle(
      fakeReq(
        "/v1/chat/completions",
        { model: "auto", messages: [{ role: "user", content: "same thread" }, { role: "assistant", content: "o" }, { role: "user", content: "again" }] },
        { "x-force-model": "anthropic/claude-sonnet-4-5" },
      ),
      collectRes() as never,
    );
    expect(models).toEqual(["openai", "anthropic"]);
  });
});
