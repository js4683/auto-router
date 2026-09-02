import { describe, expect, it } from "vitest";
import {
  embeddingEndpointDigest,
  normalizeEmbeddingText,
  requestEmbeddings,
  type EmbeddingClientConfig,
} from "../src/embeddings.js";

const config: EmbeddingClientConfig = {
  baseUrl: "https://embed.test/v1/",
  apiKey: "test-key",
  model: "embed/test",
  timeoutMs: 500,
};

function embeddingResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }));
}

function validItem(index = 0, embedding = [1, 0]): { index: number; embedding: number[] } {
  return { index, embedding };
}

describe("embedding client boundary", () => {
  it("normalizes text identically for training and runtime", () => {
    expect(normalizeEmbeddingText("  first\r\nsecond  ", 8)).toBe("first\nse");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid maximum input characters: %s", (maxInputChars) => {
    expect(() => normalizeEmbeddingText("text", maxInputChars)).toThrow("maxInputChars must be a positive integer");
  });

  it("posts bounded inputs to the configured versioned endpoint", async () => {
    let captured: { url?: string; body?: unknown; authorization?: string } = {};
    const vectors = await requestEmbeddings(["one", "two"], config, async (url, init) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init?.body)) as unknown,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      };
      return embeddingResponse([
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ]);
    });

    expect(captured).toEqual({
      url: "https://embed.test/v1/embeddings",
      body: { model: "embed/test", input: ["one", "two"] },
      authorization: "Bearer test-key",
    });
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("rejects redirects before forwarding to another endpoint", async () => {
    let reachedRedirectTarget = false;
    const redirectingFetch: typeof fetch = async (_url, init) => {
      if (init?.redirect !== "error") {
        reachedRedirectTarget = true;
        return embeddingResponse([validItem()]);
      }
      throw new TypeError("redirect rejected");
    };

    await expect(requestEmbeddings(["one"], config, redirectingFetch)).rejects.toThrow("embedding request failed");
    expect(reachedRedirectTarget).toBe(false);
  });

  it("hashes the normalized pre-append endpoint", () => {
    expect(embeddingEndpointDigest("https://embed.test/v1///")).toBe("39beffdc40eefb62aa8bb8524984f3c7e79010892caf55555207caf39bbe7363");
  });

  it("rejects remote HTTP endpoints before network I/O", async () => {
    let calls = 0;
    await expect(
      requestEmbeddings(["one"], { ...config, baseUrl: "http://embed.test/v1" }, async () => {
        calls += 1;
        return embeddingResponse([validItem()]);
      })
    ).rejects.toThrow("embedding endpoint must use HTTPS");
    expect(calls).toBe(0);
  });

  it.each([
    ["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/v1/embeddings"],
    ["http://localhost/v1/", "http://localhost/v1/embeddings"],
    ["http://[::1]/v1/", "http://[::1]/v1/embeddings"],
  ])("accepts loopback HTTP endpoint %s", async (baseUrl, expectedUrl) => {
    let capturedUrl = "";
    await requestEmbeddings(["one"], { ...config, baseUrl }, async (url) => {
      capturedUrl = String(url);
      return embeddingResponse([validItem()]);
    });
    expect(capturedUrl).toBe(expectedUrl);
  });

  it.each([
    "https://user:password@embed.test/v1",
    "https://embed.test/v1?provider=openai",
    "https://embed.test/v1#fragment",
  ])("rejects endpoint metadata in %s", async (baseUrl) => {
    await expect(requestEmbeddings(["one"], { ...config, baseUrl }, async () => embeddingResponse([validItem()]))).rejects.toThrow(
      "embedding endpoint must not include credentials, query, or fragment"
    );
  });

  it.each([
    [[], "embedding inputs must contain between 1 and 128 items"],
    [Array.from({ length: 129 }, () => "text"), "embedding inputs must contain between 1 and 128 items"],
    [["x".repeat(1024 * 1024 + 1)], "embedding inputs exceed 1 MiB"],
  ])("rejects an invalid batch before network I/O", async (inputs, message) => {
    let calls = 0;
    await expect(
      requestEmbeddings(inputs, config, async () => {
        calls += 1;
        return embeddingResponse([]);
      })
    ).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("bounds total input by UTF-8 bytes", async () => {
    const inputs = ["a".repeat(1024 * 1024 - 3), "😀"];
    await expect(requestEmbeddings(inputs, config, async () => embeddingResponse([]))).rejects.toThrow("embedding inputs exceed 1 MiB");
  });

  it("times out without retrying", async () => {
    let calls = 0;
    const timedConfig = { ...config, timeoutMs: 5 };
    const neverCompletes: typeof fetch = async (_url, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };

    await expect(requestEmbeddings(["one"], timedConfig, neverCompletes)).rejects.toThrow("embedding request timed out");
    expect(calls).toBe(1);
  });

  it("sanitizes transport errors", async () => {
    const secretConfig = { ...config, apiKey: "secret-api-key" };
    let error: Error | undefined;
    try {
      await requestEmbeddings(["one"], secretConfig, async () => {
        throw new Error("secret-api-key raw provider failure");
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toBe("embedding request failed");
    expect(error?.message).not.toContain(secretConfig.apiKey);
    expect(error?.message).not.toContain("raw provider failure");
  });

  it("reports HTTP status without exposing credentials or the provider body", async () => {
    const secretConfig = { ...config, apiKey: "secret-api-key" };
    let error: Error | undefined;
    try {
      await requestEmbeddings(["one"], secretConfig, async () => new Response("raw provider body", { status: 429 }));
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toBe("embedding endpoint returned HTTP 429");
    expect(error?.message).not.toContain(secretConfig.apiKey);
    expect(error?.message).not.toContain("raw provider body");
  });

  it("cancels non-success bodies without reading them", async () => {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reads += 1;
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(requestEmbeddings(["one"], config, async () => new Response(body, { status: 429 }))).rejects.toThrow(
      "embedding endpoint returned HTTP 429"
    );
    expect(cancelled).toBe(true);
    expect(reads).toBe(0);
  });

  it("reads at most 16 MiB from the provider response", async () => {
    const rawBody = `provider-marker${"x".repeat(16 * 1024 * 1024)}`;
    let error: Error | undefined;
    try {
      await requestEmbeddings(["one"], config, async () => new Response(rawBody));
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toBe("embedding response exceeds 16 MiB");
    expect(error?.message).not.toContain("provider-marker");
    expect(error?.message).not.toContain(config.apiKey);
  });

  it.each([
    ["missing", [validItem(0), validItem(2)]],
    ["duplicate", [validItem(0), validItem(0)]],
    ["non-integer", [validItem(0), { index: 1.5, embedding: [0, 1] }]],
  ])("rejects %s response indices", async (_case, data) => {
    await expect(requestEmbeddings(["one", "two"], config, async () => embeddingResponse(data))).rejects.toThrow(
      "embedding response indices are invalid"
    );
  });

  it("rejects inconsistent embedding dimensions", async () => {
    const data = [validItem(0), validItem(1, [0, 1, 0])];
    await expect(requestEmbeddings(["one", "two"], config, async () => embeddingResponse(data))).rejects.toThrow(
      "embedding response dimensions are invalid"
    );
  });

  it("rejects zero-dimensional embeddings", async () => {
    await expect(requestEmbeddings(["one"], config, async () => embeddingResponse([validItem(0, [])]))).rejects.toThrow(
      "embedding response dimensions are invalid"
    );
  });

  it("rejects non-finite embedding values", async () => {
    const response = new Response('{"data":[{"index":0,"embedding":[1e400]}]}');
    await expect(requestEmbeddings(["one"], config, async () => response)).rejects.toThrow("embedding response contains non-finite values");
  });
});
