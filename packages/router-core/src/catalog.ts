import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Catalog, ModelEntry, RouterConfig } from "./types.js";

export interface RawAAModel {
  id: string;
  model?: string;
  name?: string;
  providerID?: string;
  evaluations?: { artificial_analysis_coding_index?: number };
  pricing?: {
    price_1m_blended_3_to_1?: number;
    price_1m_input_tokens?: number;
    price_1m_output_tokens?: number;
  };
  median_output_tokens_per_second?: number;
  median_time_to_first_token_seconds?: number;
  limit?: { context?: number; output?: number };
  // sometimes AA uses different casing
  [k: string]: unknown;
}

export interface OpenCodeProviderModel {
  id?: string;
  name?: string;
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  limit?: { context?: number; output?: number };
  status?: string;
}

export interface OpenCodeProvider {
  id: string;
  models: Record<string, OpenCodeProviderModel>;
}

export interface OpenCodeProviderList {
  all?: OpenCodeProvider[];
  connected?: string[];
}

function valueScore(codingIndex: number, blendedPrice: number): number {
  if (!blendedPrice || blendedPrice <= 0) return codingIndex * 10; // free-ish -> high value; treat as strong
  return codingIndex / blendedPrice;
}

function blendedPriceOf(raw: RawAAModel): number {
  const p = raw.pricing ?? {};
  if (typeof p.price_1m_blended_3_to_1 === "number") return p.price_1m_blended_3_to_1;
  // fallback: compute 3:1 blended from input/output
  const input = p.price_1m_input_tokens ?? 0;
  const output = p.price_1m_output_tokens ?? 0;
  if (input || output) return (input * 1 + output * 3) / 4;
  return 0;
}

export function buildCatalog(
  rawModels: RawAAModel[],
  config: RouterConfig,
  source: Catalog["source"] = "aa"
): Catalog {
  const freeSet = new Set((config.providerFreeSet ?? []).map((s) => s.toLowerCase()));
  const windowReg = config.windowRegistry ?? {};

  function stripProvider(s: string): string {
    const idx = s.lastIndexOf("/");
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  const models: ModelEntry[] = rawModels.map((raw) => {
    const rawId = (raw.id ?? raw.model ?? raw.name ?? "unknown") as string;
    const providerID = typeof raw.providerID === "string" ? raw.providerID : undefined;
    const id = providerID ? rawId : stripProvider(rawId);
    const codingIndex = raw.evaluations?.artificial_analysis_coding_index ?? 0;
    const blended = blendedPriceOf(raw);
    const lower = id.toLowerCase();
    const rawLower = rawId.toLowerCase();
    const strippedLower = stripProvider(rawLower);
    const runtimeId = providerID ? `${providerID}/${rawId}` : rawId.includes("/") ? rawId : undefined;
    const isFree =
      freeSet.has(lower) ||
      freeSet.has(rawLower) ||
      freeSet.has(strippedLower) ||
      freeSet.has((raw.name as string)?.toLowerCase() ?? "") ||
      [...freeSet].some((f) => lower.endsWith("/" + f) || strippedLower === f.toLowerCase()) ||
      providerID?.toLowerCase() === "opencode";

    // window from registry; fallback to 128k if unknown (fail-open moderate) — try stripped
    const windowTokens =
      raw.limit?.context ??
      windowReg[rawId] ??
      windowReg[id] ??
      windowReg[lower] ??
      windowReg[strippedLower] ??
      windowReg[rawLower] ??
      128000;

    return {
      id,
      runtimeId,
      codingIndex,
      blendedPrice: blended,
      value: valueScore(codingIndex, blended),
      windowTokens,
      isFree,
      medianOutputTokensPerSec: raw.median_output_tokens_per_second,
      medianTimeToFirstTokenSec: raw.median_time_to_first_token_seconds,
    };
  });

  // Sort by value desc for deterministic selection tie-break
  models.sort((a, b) => b.value - a.value || b.codingIndex - a.codingIndex);

  return {
    models,
    fetchedAt: new Date().toISOString(),
    source,
  };
}

// Minimal fallback when AA offline and no cache
// Infer quality/pricing from model name so tier routing actually differentiates without AA key
function inferQualityAndPrice(id: string): { codingIndex: number; blendedPrice: number } {
  const lower = id.toLowerCase();
  if (lower.includes("5.6-terra") || lower.includes("5.6-sol") || (lower.includes("5.4") && !lower.includes("mini"))) return { codingIndex: 92, blendedPrice: 12 };
  if (lower.includes("opus")) return { codingIndex: 92, blendedPrice: 15 };
  if (lower.includes("fable")) return { codingIndex: 90, blendedPrice: 8 };
  if (lower.includes("5.5")) return { codingIndex: 90, blendedPrice: 10 };
  if (lower.includes("5.4-mini")) return { codingIndex: 70, blendedPrice: 2 };
  if (lower.includes("5.3-codex-spark") || lower.includes("codex-spark")) return { codingIndex: 72, blendedPrice: 1.5 };
  if (lower.includes("5.2-codex")) return { codingIndex: 75, blendedPrice: 3 };
  if (lower.includes("5.2")) return { codingIndex: 68, blendedPrice: 2 };
  if (lower.includes("muse-spark")) return { codingIndex: 78, blendedPrice: 0.4 };
  if (lower.includes("nemotron-3-ultra")) return { codingIndex: 74, blendedPrice: 0.5 };
  if (lower.includes("nemotron-3.5")) return { codingIndex: 68, blendedPrice: 0.4 };
  if (lower.includes("hy3")) return { codingIndex: 66, blendedPrice: 0.3 };
  if (lower.includes("ling-3.0")) return { codingIndex: 64, blendedPrice: 0.3 };
  if (lower.includes("mimo")) return { codingIndex: 62, blendedPrice: 0.3 };
  if (lower.includes("big-pickle")) return { codingIndex: 58, blendedPrice: 0.2 };
  if (lower.includes("mini")) return { codingIndex: 60, blendedPrice: 0.8 };
  if (lower.includes("contributor-free")) return { codingIndex: 65, blendedPrice: 0.4 };
  return { codingIndex: 70, blendedPrice: 2 };
}

export function buildCatalogFromProviders(providerList: OpenCodeProviderList, config: RouterConfig): Catalog {
  const connected = new Set(providerList.connected ?? []);
  const rawModels: RawAAModel[] = [];

  for (const provider of providerList.all ?? []) {
    if (!connected.has(provider.id)) continue;

    for (const [key, model] of Object.entries(provider.models ?? {})) {
      if (model.status === "deprecated") continue;
      const id = model.id ?? key;
      const inferred = inferQualityAndPrice(`${provider.id}/${id}`);
      const hasCost = model.cost && (typeof model.cost.input === "number" || typeof model.cost.output === "number");
      const pricing = hasCost
        ? { price_1m_input_tokens: model.cost?.input ?? 0, price_1m_output_tokens: model.cost?.output ?? 0 }
        : { price_1m_blended_3_to_1: inferred.blendedPrice };
      const context = model.limit?.context;

      rawModels.push({
        id,
        providerID: provider.id,
        name: model.name,
        evaluations: { artificial_analysis_coding_index: inferred.codingIndex },
        pricing,
        limit: context && context > 0 ? { context, output: model.limit?.output } : undefined,
      });
    }
  }

  return buildCatalog(rawModels, config, "live");
}

function fallbackCatalog(config: RouterConfig): Catalog {
  const windowReg = config.windowRegistry ?? {};
  const freeSet = new Set((config.providerFreeSet ?? []).map((s) => s.toLowerCase()));
  const ids = Object.keys(windowReg);
  const stub: RawAAModel[] = ids.length
    ? ids.map((id) => {
        const { codingIndex, blendedPrice } = inferQualityAndPrice(id);
        return {
          id,
          evaluations: { artificial_analysis_coding_index: codingIndex },
          pricing: { price_1m_blended_3_to_1: blendedPrice },
          median_output_tokens_per_second: 40,
          median_time_to_first_token_seconds: 0.5,
        };
      })
    : [
        { id: "fallback-cheap", evaluations: { artificial_analysis_coding_index: 55 }, pricing: { price_1m_blended_3_to_1: 0.5 } },
        { id: "fallback-mid", evaluations: { artificial_analysis_coding_index: 72 }, pricing: { price_1m_blended_3_to_1: 2 } },
        { id: "fallback-frontier", evaluations: { artificial_analysis_coding_index: 90 }, pricing: { price_1m_blended_3_to_1: 8 } },
      ];

  const cat = buildCatalog(stub, config, "fallback");
  // Mark free for fallback based on freeSet
  cat.models.forEach((m) => (m.isFree = freeSet.has(m.id.toLowerCase())));
  return cat;
}

export async function fetchAACatalog(config: RouterConfig, cachePathOverride?: string): Promise<Catalog> {
  const cachePath = resolve(cachePathOverride ?? config.catalog.cachePath ?? "./.cache/auto-router-catalog.json");
  const intervalMs = (config.catalog.refreshIntervalHours ?? 24) * 3600 * 1000;
  const apiUrl = config.catalog.artificialAnalysis.apiUrl;
  const apiKeyEnv = config.catalog.artificialAnalysis.apiKeyEnv;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

  // 1. Try cache freshness
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as Catalog & { fetchedAt: string };
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < intervalMs && cached.models?.length) {
        return { ...cached, source: "cache" };
      }
    } catch {
      // ignore corrupt cache
    }
  }

  // 2. Try fetch AA (requires key)
  if (!apiKey) {
    // No key -> try stale cache or fallback
    if (existsSync(cachePath)) {
      try {
        const stale = JSON.parse(readFileSync(cachePath, "utf8")) as Catalog;
        if (stale.models?.length) return { ...stale, source: "cache" };
      } catch {}
    }
    return fallbackCatalog(config);
  }

  try {
    const res = await fetch(apiUrl, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`AA fetch ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { data?: RawAAModel[] } | RawAAModel[];
    const rawList: RawAAModel[] = Array.isArray(data) ? data : (data as { data: RawAAModel[] }).data ?? [];

    const catalog = buildCatalog(rawList, config, "aa");
    // Persist cache
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(catalog, null, 2), "utf8");
    } catch {}
    return catalog;
  } catch (err) {
    // network/error -> stale cache or fallback
    if (existsSync(cachePath)) {
      try {
        const stale = JSON.parse(readFileSync(cachePath, "utf8")) as Catalog;
        if (stale.models?.length) return { ...stale, source: "cache" };
      } catch {}
    }
    return fallbackCatalog(config);
  }
}

export function loadCatalogSync(config: RouterConfig, cachePathOverride?: string): Catalog {
  const cachePath = resolve(cachePathOverride ?? config.catalog.cachePath ?? "./.cache/auto-router-catalog.json");
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as Catalog;
      if (c.models?.length) return { ...c, source: "cache" };
    } catch {}
  }
  return fallbackCatalog(config);
}
