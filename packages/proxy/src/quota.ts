export interface QuotaMeter {
  label: string;
  used: number;
  limit: number;
  remaining: number;
  percent: number;
  resetLabel?: string;
}

export interface ProviderQuota {
  limited: boolean;
  status: number;
  at: number;
  meters: QuotaMeter[];
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function meter(label: string, remaining: number | undefined, limit: number | undefined): QuotaMeter | undefined {
  if (remaining === undefined || limit === undefined || limit <= 0) return undefined;
  const used = Math.max(0, limit - remaining);
  return { label, used, limit, remaining, percent: Math.min(100, Math.round((used / limit) * 100)) };
}

export function parseQuota(headers: Headers, status: number): ProviderQuota {
  const meters = [
    meter("Requests", headerNumber(headers, "anthropic-ratelimit-requests-remaining") ?? headerNumber(headers, "x-ratelimit-remaining-requests"), headerNumber(headers, "anthropic-ratelimit-requests-limit") ?? headerNumber(headers, "x-ratelimit-limit-requests")),
    meter("Tokens", headerNumber(headers, "anthropic-ratelimit-tokens-remaining") ?? headerNumber(headers, "x-ratelimit-remaining-tokens"), headerNumber(headers, "anthropic-ratelimit-tokens-limit") ?? headerNumber(headers, "x-ratelimit-limit-tokens")),
    meter("Input tokens", headerNumber(headers, "anthropic-ratelimit-input-tokens-remaining"), headerNumber(headers, "anthropic-ratelimit-input-tokens-limit")),
    meter("Output tokens", headerNumber(headers, "anthropic-ratelimit-output-tokens-remaining"), headerNumber(headers, "anthropic-ratelimit-output-tokens-limit")),
  ].filter((item): item is QuotaMeter => Boolean(item));
  return { limited: status === 429, status, at: Date.now(), meters };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function utilizationPercent(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const percent = parsed <= 1 ? parsed * 100 : parsed;
  return clampPercent(percent);
}

function usedPercent(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return clampPercent(parsed);
}

function resetFromIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const hours = Math.max(0, Math.round((at - Date.now()) / 3_600_000));
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function resetFromSeconds(value: unknown): string | undefined {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function windowMeter(label: string, percent: number | undefined, reset?: string): QuotaMeter | undefined {
  if (percent === undefined) return undefined;
  return { label, used: percent, limit: 100, remaining: Math.max(0, 100 - percent), percent, resetLabel: reset };
}

export function parseClaudeUsage(payload: unknown): QuotaMeter[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const windows: Array<[string, string]> = [
    ["five_hour", "5-hour limit"],
    ["seven_day", "Weekly limit"],
    ["seven_day_opus", "Weekly Opus"],
    ["seven_day_sonnet", "Weekly Sonnet"],
  ];
  return windows.flatMap(([key, label]) => {
    const window = record[key];
    if (!window || typeof window !== "object") return [];
    const typed = window as { utilization?: unknown; resets_at?: unknown };
    const meter = windowMeter(label, utilizationPercent(typed.utilization), resetFromIso(typed.resets_at));
    return meter ? [meter] : [];
  });
}

export function parseCodexUsage(payload: unknown): QuotaMeter[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const rate = (record.rate_limit ?? record.rateLimit) as Record<string, unknown> | undefined;
  if (!rate) return [];
  const primary = (rate.primary_window ?? rate.primaryWindow) as Record<string, unknown> | undefined;
  const secondary = (rate.secondary_window ?? rate.secondaryWindow) as Record<string, unknown> | undefined;
  return [
    windowMeter(
      "5-hour limit",
      usedPercent(primary?.used_percent ?? primary?.usedPercent),
      resetFromIso(primary?.reset_at ?? primary?.resetAt) ?? resetFromSeconds(primary?.reset_after_seconds ?? primary?.resetAfterSeconds),
    ),
    windowMeter(
      "Weekly limit",
      usedPercent(secondary?.used_percent ?? secondary?.usedPercent),
      resetFromIso(secondary?.reset_at ?? secondary?.resetAt) ?? resetFromSeconds(secondary?.reset_after_seconds ?? secondary?.resetAfterSeconds),
    ),
  ].filter((item): item is QuotaMeter => Boolean(item));
}

export function parseXaiBilling(payload: unknown): QuotaMeter[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const config = (root.config && typeof root.config === "object" ? root.config : root) as Record<string, unknown>;
  const period = (config.currentPeriod ?? config.current_period) as Record<string, unknown> | undefined;
  const periodEnd = period?.end ?? config.billingPeriodEnd ?? config.billing_period_end;
  const credit = utilizationPercent(config.creditUsagePercent ?? config.credit_usage_percent);
  const monthlyLimitRaw = config.monthlyLimit ?? config.monthly_limit;
  const monthlyLimit =
    typeof monthlyLimitRaw === "object" && monthlyLimitRaw
      ? Number((monthlyLimitRaw as { val?: unknown }).val)
      : Number(monthlyLimitRaw);
  const usedCents = Number(config.used);
  const monthlyPercent =
    Number.isFinite(monthlyLimit) && monthlyLimit > 0 && Number.isFinite(usedCents)
      ? utilizationPercent((usedCents / monthlyLimit) * 100)
      : undefined;
  const products = Array.isArray(config.productUsage ?? config.product_usage)
    ? ((config.productUsage ?? config.product_usage) as Array<Record<string, unknown>>)
    : [];
  return [
    windowMeter("Weekly limit", credit, resetFromIso(periodEnd)),
    windowMeter("Monthly limit", monthlyPercent, resetFromIso(config.billingPeriodEnd ?? config.billing_period_end)),
    ...products.flatMap((item, index) => {
      const label = typeof item.product === "string" ? item.product : `Product ${index + 1}`;
      const meter = windowMeter(label, utilizationPercent(item.usagePercent ?? item.usage_percent));
      return meter ? [meter] : [];
    }),
  ].filter((item): item is QuotaMeter => Boolean(item));
}

function jwtClaim(token: string, name: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
    const value = claims[name];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

function chatgptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      chatgpt_account_id?: string;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    };
    return claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

export async function reconcileUsageQuota(
  provider: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderQuota | undefined> {
  if (provider === "anthropic") {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!response.ok) return { limited: response.status === 429, status: response.status, at: Date.now(), meters: [] };
    const meters = parseClaudeUsage(await response.json());
    return { limited: meters.some((meter) => meter.percent >= 100), status: response.status, at: Date.now(), meters };
  }
  if (provider === "openai") {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
    };
    const account = chatgptAccountId(token);
    if (account) headers["chatgpt-account-id"] = account;
    const response = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", { headers });
    if (!response.ok) return { limited: response.status === 429, status: response.status, at: Date.now(), meters: [] };
    const meters = parseCodexUsage(await response.json());
    return { limited: meters.some((meter) => meter.percent >= 100), status: response.status, at: Date.now(), meters };
  }
  if (provider === "xai") {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.91",
      accept: "*/*",
      "user-agent": "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)",
    };
    const userId = jwtClaim(token, "sub");
    if (userId) headers["x-userid"] = userId;
    const urls = ["https://cli-chat-proxy.grok.com/v1/billing?format=credits", "https://cli-chat-proxy.grok.com/v1/billing"];
    const meters: QuotaMeter[] = [];
    let status = 0;
    for (const url of urls) {
      const response = await fetchImpl(url, { headers });
      status = response.status;
      if (!response.ok) continue;
      meters.push(...parseXaiBilling(await response.json()));
    }
    if (meters.length) return { limited: meters.some((item) => item.percent >= 100), status: 200, at: Date.now(), meters };
    const me = await fetchImpl("https://api.x.ai/v1/me", { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (me.ok) {
      return { limited: false, status: me.status, at: Date.now(), meters: [] };
    }
    return { limited: status === 429, status, at: Date.now(), meters: [] };
  }
  return undefined;
}
