import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { judgeOutputs, requestCompletion, type LiveClientConfig } from "../src/live.js";
import type { LiveOutput } from "../src/types.js";

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>) {
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    await handler(req, res, text ? JSON.parse(text) : {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function config(baseUrl: string): LiveClientConfig {
  return { baseUrl, apiKey: "test-secret-key", timeoutMs: 1000, maxOutputTokens: 64 };
}

function chatResponse(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
  });
}

describe("requestCompletion", () => {
  it("calls a bounded OpenAI-compatible endpoint and validates output", async () => {
    let captured: { authorization?: string; body?: any } = {};
    const mock = await listen((req, res, body) => {
      captured = { authorization: req.headers.authorization, body };
      res.setHeader("content-type", "application/json");
      res.end(chatResponse("Hello"));
    });
    try {
      const result = await requestCompletion(
        { model: "provider/model", messages: [{ role: "user", content: "hi" }] },
        config(mock.baseUrl)
      );

      expect(result.text).toBe("Hello");
      expect(result.terminalState).toBe("completed");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 2, cacheWriteInputTokens: 0 });
      expect(captured.authorization).toBe("Bearer test-secret-key");
      expect(captured.body).toMatchObject({ model: "provider/model", max_tokens: 64, stream: false });
    } finally {
      await mock.close();
    }
  });

  it("rejects endpoint credentials, queries, and fragments and rejects redirects", async () => {
    for (const baseUrl of ["https://example.com/v1?token=secret", "https://user:pass@example.com/v1", "https://example.com/v1#secret"]) {
      await expect(
        requestCompletion({ model: "provider/model", messages: [{ role: "user", content: "hi" }] }, config(baseUrl), async () => new Response("{}"))
      ).rejects.toThrow("live baseUrl must not include credentials, query, or fragment");
    }

    let requestedUrl = "";
    let requestInit: RequestInit | undefined;
    await requestCompletion(
      { model: "provider/model", messages: [{ role: "user", content: "hi" }] },
      config("https://example.com/v1/"),
      async (url, init) => {
        requestedUrl = String(url);
        requestInit = init;
        return new Response(chatResponse("Hello"));
      }
    );

    expect(requestedUrl).toBe("https://example.com/v1/chat/completions");
    expect(requestInit?.redirect).toBe("error");
  });

  it("preserves non-completed provider terminal states", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }] }));

    const result = await requestCompletion(
      { model: "provider/model", messages: [{ role: "user", content: "hi" }] },
      config("https://example.com/v1"),
      fetchImpl
    );

    expect(result.terminalState).toBe("incomplete");
  });

  it("marks responses without terminal metadata incomplete", async () => {
    const missingTerminalState: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "unconfirmed" } }] }));

    const result = await requestCompletion(
      { model: "provider/model", messages: [{ role: "user", content: "hi" }] },
      config("https://example.com/v1"),
      missingTerminalState
    );

    expect(result.terminalState).toBe("incomplete");
  });

  it("rejects provider usage envelopes missing completion tokens", async () => {
    const partialUsage: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "partial" } }], usage: { prompt_tokens: 100 } }));

    await expect(
      requestCompletion({ model: "provider/model", messages: [{ role: "user", content: "hi" }] }, config("https://example.com/v1"), partialUsage)
    ).rejects.toThrow("provider usage completion_tokens is required");
  });

  it("does not retry provider failures or expose credentials", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    };

    await expect(
      requestCompletion({ model: "provider/model", messages: [{ role: "user", content: "hi" }] }, config("https://example.com/v1"), fetchImpl)
    ).rejects.toThrow("provider returned HTTP 429");
    expect(calls).toBe(1);
    try {
      await requestCompletion({ model: "provider/model", messages: [] }, config("https://example.com/v1"), fetchImpl);
    } catch (error) {
      expect(String(error)).not.toContain("test-secret-key");
    }
  });

  it("rejects insecure remote URLs, oversized bodies, and malformed responses", async () => {
    await expect(requestCompletion({ model: "m", messages: [] }, config("http://example.com/v1"))).rejects.toThrow("live baseUrl must use HTTPS");
    const oversized: typeof fetch = async () => new Response("x".repeat(4 * 1024 * 1024 + 1));
    await expect(requestCompletion({ model: "m", messages: [] }, config("https://example.com/v1"), oversized)).rejects.toThrow("response exceeds 4 MiB");
    const malformed: typeof fetch = async () => new Response("{");
    await expect(requestCompletion({ model: "m", messages: [] }, config("https://example.com/v1"), malformed)).rejects.toThrow("provider returned invalid JSON");
    const missing: typeof fetch = async () => new Response(JSON.stringify({ choices: [] }));
    await expect(requestCompletion({ model: "m", messages: [] }, config("https://example.com/v1"), missing)).rejects.toThrow("provider response is missing assistant content");
    const invalidUsage: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: -1, completion_tokens: 1 } }));
    await expect(requestCompletion({ model: "m", messages: [] }, config("https://example.com/v1"), invalidUsage)).rejects.toThrow(
      "provider usage prompt_tokens must be non-negative"
    );
  });

  it("times out without retrying", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };

    await expect(
      requestCompletion({ model: "m", messages: [] }, { ...config("https://example.com/v1"), timeoutMs: 5 }, fetchImpl)
    ).rejects.toThrow("provider request timed out");
    expect(calls).toBe(1);
  });
});

describe("judgeOutputs", () => {
  it("blindly batches outputs and maps validated scores to strategies", async () => {
    let capturedBody: any;
    const mock = await listen((_req, res, body) => {
      capturedBody = body;
      const request = JSON.parse(body.messages[1].content);
      const scores = Object.fromEntries(
        request.responses.map((item: any) => [item.label, item.response.text.endsWith("-r") ? 80 : item.response.text.endsWith("-f") ? 95 : 60])
      );
      res.end(chatResponse(JSON.stringify({ scores })));
    });
    const outputs: Record<string, LiveOutput> = {
      router: { text: "response-r", toolCalls: [], terminalState: "completed" },
      "always-frontier": { text: "response-f", toolCalls: [], terminalState: "completed" },
      "always-cheap": { text: "response-c", toolCalls: [], terminalState: "completed" },
    };
    try {
      const scores = await judgeOutputs(
        { id: "case-1", rubric: "Score correctness." },
        outputs as never,
        { ...config(mock.baseUrl), judgeModel: "provider/judge" }
      );

      expect(scores).toEqual({ router: 0.8, "always-frontier": 0.95, "always-cheap": 0.6 });
      expect(capturedBody.model).toBe("provider/judge");
      expect(capturedBody.temperature).toBe(0);
      expect(capturedBody.tools).toBeUndefined();
      expect(capturedBody.response_format).toEqual({ type: "json_object" });
      expect(capturedBody.messages[0].content).toContain("untrusted quoted data");
      expect(capturedBody.messages[1].content).not.toContain("always-frontier");
    } finally {
      await mock.close();
    }
  });

  it("rejects malformed and out-of-range judge scores", async () => {
    const malformed: typeof fetch = async () => new Response(chatResponse(JSON.stringify({ scores: { A: 101, B: 50, C: 50 } })));
    const outputs: Record<"router" | "always-frontier" | "always-cheap", LiveOutput> = {
      router: { text: "r", toolCalls: [], terminalState: "completed" },
      "always-frontier": { text: "f", toolCalls: [], terminalState: "completed" },
      "always-cheap": { text: "c", toolCalls: [], terminalState: "completed" },
    };
    await expect(
      judgeOutputs(
        { id: "case-1", rubric: "Score correctness." },
        outputs,
        { ...config("https://example.com/v1"), judgeModel: "judge" },
        malformed
      )
    ).rejects.toThrow("judge score for A must be between 0 and 100");
  });
});
