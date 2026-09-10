export type NormalizedTerminalState = "completed" | "incomplete" | "failed";

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export interface NormalizedCompletion {
  text: string;
  toolCalls: NormalizedToolCall[];
  terminalState: NormalizedTerminalState;
  refusal?: string;
  usage?: NormalizedUsage;
  providerId?: string;
  runtimeId?: string;
}

export function terminalStateFromStatus(status: unknown, finishReason: unknown): NormalizedTerminalState {
  const normalizedStatus = String(status ?? "").toLowerCase();
  const normalizedReason = String(finishReason ?? "").toLowerCase();
  if (["failed", "cancelled", "content_filter", "refusal"].includes(normalizedStatus) || ["content_filter", "refusal"].includes(normalizedReason)) {
    return "failed";
  }
  if (["incomplete", "in_progress", "queued"].includes(normalizedStatus) || ["length", "max_tokens", "max_output_tokens"].includes(normalizedReason)) {
    return "incomplete";
  }
  if (["completed", "stop", "tool_calls", "function_call", "function_calls", "end_turn", "stop_sequence", "tool_use"].includes(normalizedStatus) ||
      ["completed", "stop", "tool_calls", "function_call", "function_calls", "end_turn", "stop_sequence", "tool_use", "stop"].includes(normalizedReason)) {
    return "completed";
  }
  return "incomplete";
}
