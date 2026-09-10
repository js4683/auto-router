import { terminalStateFromStatus, type NormalizedCompletion, type NormalizedToolCall, type NormalizedUsage } from "@auto-router/router-core";

export type SupportedProvider = "openai" | "xai" | "google" | "anthropic" | "opencode";

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part: any) => ["text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

export function providerText(payload: any, provider: string): { text: string; refusal?: string } {
  if ((provider === "openai" || provider === "opencode") && Array.isArray(payload?.output)) {
    const parts = payload.output
      .filter((item: any) => item?.type === "message" && Array.isArray(item.content))
      .flatMap((item: any) => item.content);
    const text = parts.filter((part: any) => part?.type === "output_text").map((part: any) => part.text ?? "").join("");
    const refusal = parts.filter((part: any) => part?.type === "refusal").map((part: any) => part.refusal ?? "").join("");
    return { text, ...(refusal ? { refusal } : {}) };
  }

  const message = payload?.choices?.[0]?.message;
  if (message || provider === "openai" || provider === "xai") {
    return { text: textValue(message?.content), ...(message?.refusal ? { refusal: message.refusal } : {}) };
  }
  if (provider === "google") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    return { text: Array.isArray(parts) ? parts.map((part: any) => part?.text ?? "").join("") : "" };
  }
  if (provider === "anthropic") {
    const parts = Array.isArray(payload?.content) ? payload.content : [];
    const text = parts.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
    const refusal = parts.filter((part: any) => part?.type === "refusal").map((part: any) => part.refusal ?? "").join("");
    return { text, ...(refusal ? { refusal } : {}) };
  }
  return { text: "" };
}

function token(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeProviderUsage(payload: any, provider: string): NormalizedUsage | undefined {
  const usage = provider === "google" ? payload?.usageMetadata : payload?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  if (provider === "google") {
    const inputTokens = token(usage.promptTokenCount);
    const outputTokens = token(usage.candidatesTokenCount) + token(usage.thoughtsTokenCount);
    return {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: token(usage.cachedContentTokenCount),
      cacheWriteInputTokens: 0,
    };
  }
  if (provider === "anthropic") {
    const cacheReadInputTokens = token(usage.cache_read_input_tokens);
    const cacheWriteInputTokens = token(usage.cache_creation_input_tokens);
    return {
      inputTokens: token(usage.input_tokens) + cacheReadInputTokens + cacheWriteInputTokens,
      outputTokens: token(usage.output_tokens),
      cacheReadInputTokens,
      cacheWriteInputTokens,
    };
  }
  if (Array.isArray(payload?.output)) {
    return {
      inputTokens: token(usage.input_tokens),
      outputTokens: token(usage.output_tokens),
      cacheReadInputTokens: token(usage.input_tokens_details?.cached_tokens),
      cacheWriteInputTokens: token(usage.input_tokens_details?.cache_creation_tokens),
    };
  }
  return {
    inputTokens: token(usage.prompt_tokens),
    outputTokens: token(usage.completion_tokens),
    cacheReadInputTokens: token(usage.prompt_tokens_details?.cached_tokens),
    cacheWriteInputTokens: token(usage.prompt_tokens_details?.cache_creation_tokens),
  };
}

function providerFinishReason(payload: any, provider: string): unknown {
  if (provider === "google") return payload?.candidates?.[0]?.finishReason;
  if (provider === "anthropic") return payload?.stop_reason;
  if (Array.isArray(payload?.output)) return payload?.incomplete_details?.reason ?? payload?.status;
  return payload?.choices?.[0]?.finish_reason ?? payload?.status;
}

export function normalizeProviderToolCall(id: unknown, name: unknown, argumentsValue: unknown): NormalizedToolCall | undefined {
  if (typeof name !== "string" || !name) return undefined;
  let argumentsObject: unknown = argumentsValue;
  if (typeof argumentsObject === "string") {
    try {
      argumentsObject = JSON.parse(argumentsObject);
    } catch {
      argumentsObject = { result: argumentsObject };
    }
  }
  if (!argumentsObject || typeof argumentsObject !== "object" || Array.isArray(argumentsObject)) {
    argumentsObject = {};
  }
  return { id: typeof id === "string" && id ? id : `call_${name}`, name, arguments: argumentsObject as Record<string, unknown> };
}

export function normalizeProviderCompletion(
  payload: any,
  provider: string,
  toolCalls: NormalizedToolCall[] = [],
): NormalizedCompletion {
  const { text, refusal } = providerText(payload, provider);
  const finishReason = providerFinishReason(payload, provider);
  const completion: NormalizedCompletion = {
    text,
    toolCalls,
    terminalState: terminalStateFromStatus(payload?.status, finishReason),
    ...(refusal ? { refusal } : {}),
  };
  const usage = normalizeProviderUsage(payload, provider);
  return usage ? { ...completion, usage } : completion;
}
