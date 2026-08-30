import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { selectModel } from "../../router-core/src/selector.js";
import type { Catalog, RouterConfig } from "../../router-core/src/types.js";
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

function fakeReq(url: string, body: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = url;
  req.headers = { "content-type": "application/json", "x-session-id": "ses_test" };
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

    expect(outbound[0].model).toBe("opencode/muse-spark-1.2-contributor-free");
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
});
