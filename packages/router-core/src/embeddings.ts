import { createHash } from "node:crypto";

export interface EmbeddingClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const MAX_BATCH_SIZE = 128;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

class ResponseLimitError extends Error {}

export function normalizeEmbeddingText(text: string, maxInputChars: number): string {
  if (!Number.isInteger(maxInputChars) || maxInputChars < 1) throw new Error("maxInputChars must be a positive integer");
  return text.replace(/\r\n?/g, "\n").trim().slice(0, maxInputChars);
}

function normalizedBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("embedding endpoint URL is invalid");
  }

  if (url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("embedding endpoint must not include credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("embedding endpoint must use HTTPS");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function embeddingEndpointDigest(baseUrl: string): string {
  return createHash("sha256").update(normalizedBaseUrl(baseUrl)).digest("hex");
}

function validateInputs(inputs: string[]): void {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_BATCH_SIZE) {
    throw new Error("embedding inputs must contain between 1 and 128 items");
  }

  let totalBytes = 0;
  for (const input of inputs) {
    if (typeof input !== "string") throw new Error("embedding inputs must be strings");
    totalBytes += Buffer.byteLength(input, "utf8");
    if (totalBytes > MAX_INPUT_BYTES) throw new Error("embedding inputs exceed 1 MiB");
  }
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("embedding timeout must be a positive integer");
  return AbortSignal.timeout(timeoutMs);
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "TimeoutError");
}

async function sendRequest(
  endpoint: string,
  inputs: string[],
  config: EmbeddingClientConfig,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<Response> {
  try {
    return await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, input: inputs }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isTimeout(error, signal)) throw new Error("embedding request timed out");
    throw new Error("embedding request failed");
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytesRead += value.byteLength;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseLimitError();
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function responseBody(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return await readBoundedBody(response);
  } catch (error) {
    if (error instanceof ResponseLimitError) throw new Error("embedding response exceeds 16 MiB");
    if (isTimeout(error, signal)) throw new Error("embedding request timed out");
    throw new Error("embedding request failed");
  }
}

function embeddingItem(value: unknown, inputCount: number): { index: number; embedding: unknown[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("embedding response is invalid");
  const item = value as Record<string, unknown>;
  if (!Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= inputCount) {
    throw new Error("embedding response indices are invalid");
  }
  if (!Array.isArray(item.embedding)) throw new Error("embedding response dimensions are invalid");
  return { index: item.index as number, embedding: item.embedding };
}

function orderedEmbeddings(data: unknown[], inputCount: number): unknown[][] {
  if (data.length !== inputCount) throw new Error("embedding response indices are invalid");
  const ordered: Array<unknown[] | undefined> = new Array(inputCount);
  for (const value of data) {
    const item = embeddingItem(value, inputCount);
    if (ordered[item.index] !== undefined) throw new Error("embedding response indices are invalid");
    ordered[item.index] = item.embedding;
  }
  if (ordered.some((embedding) => embedding === undefined)) throw new Error("embedding response indices are invalid");
  return ordered as unknown[][];
}

function validateDimensions(embeddings: unknown[][]): number[][] {
  const dimensions = embeddings[0].length;
  if (dimensions < 1) throw new Error("embedding response dimensions are invalid");
  for (const embedding of embeddings) {
    if (embedding.length !== dimensions) throw new Error("embedding response dimensions are invalid");
    if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("embedding response contains non-finite values");
    }
  }
  return embeddings as number[][];
}

function parseEmbeddings(text: string, inputCount: number): number[][] {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("embedding response is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("embedding response is invalid");
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error("embedding response is invalid");
  return validateDimensions(orderedEmbeddings(data, inputCount));
}

function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    return;
  }
}

export async function requestEmbeddings(
  inputs: string[],
  config: EmbeddingClientConfig,
  fetchImpl: typeof fetch = fetch
): Promise<number[][]> {
  validateInputs(inputs);
  const endpoint = `${normalizedBaseUrl(config.baseUrl)}/embeddings`;
  const signal = timeoutSignal(config.timeoutMs);
  const response = await sendRequest(endpoint, inputs, config, signal, fetchImpl);
  if (!response.ok) {
    discardResponse(response);
    throw new Error(`embedding endpoint returned HTTP ${response.status}`);
  }
  return parseEmbeddings(await responseBody(response, signal), inputs.length);
}
