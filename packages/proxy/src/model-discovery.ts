import type { Catalog, ModelEntry, RoutingCapability, RoutingTransport } from "@auto-router/router-core";
import { createHash } from "node:crypto";
import { antigravityUserAgent, ensureGoogleProject } from "./oauth.js";

export type DiscoveryCapability = "text" | "tools" | "image";

export interface DiscoveryAccount {
  id: string;
  token: string;
  projectId?: string;
}

export interface DiscoveredModel {
  id: string;
  capabilities: readonly DiscoveryCapability[];
  contextTokens?: number;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONTEXT_TOKENS = 4_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value) && !/^(chat_|tab_)/i.test(value);
}

function contextTokens(value: unknown): number | undefined {
  const data = record(value);
  const raw = data?.maxTokens ?? data?.contextLength ?? data?.contextWindow;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.floor(raw), MAX_CONTEXT_TOKENS);
}

function discoveredModel(id: string, metadata?: unknown): DiscoveredModel {
  const capabilities: DiscoveryCapability[] = /image|imagen/i.test(id) ? ["image"] : ["text", "tools"];
  const tokens = contextTokens(metadata);
  return { id, capabilities, ...(tokens ? { contextTokens: tokens } : {}) };
}

export function parseAntigravityModels(payload: unknown): DiscoveredModel[] {
  const root = record(payload);
  if (!root) return [];
  const models = root.models;
  const out = new Map<string, DiscoveredModel>();
  const add = (id: unknown, metadata?: unknown) => {
    if (!validModelId(id) || out.has(id)) return;
    out.set(id, discoveredModel(id, metadata));
  };

  const modelMap = record(models);
  if (modelMap) {
    for (const [id, metadata] of Object.entries(modelMap)) add(id, metadata);
  }
  if (Array.isArray(models)) {
    for (const item of models) {
      const data = record(item);
      add(data?.id ?? data?.model ?? data?.name, data);
    }
  }
  add(root.defaultAgentModelId);
  const addNestedIds = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => (typeof item === "string" ? add(item) : addNestedIds(item)));
      return;
    }
    const nested = record(value);
    if (!nested) return;
    addNestedIds(nested.groups);
    addNestedIds(nested.modelIds);
  };
  addNestedIds(root.agentModelSorts);
  return [...out.values()];
}

export interface ModelDiscoveryAdapter {
  readonly provider: string;
  discover(account: DiscoveryAccount, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;
}

export interface DiscoverySnapshot {
  accountId: string;
  provider: string;
  models: readonly DiscoveredModel[];
  projectId?: string;
  fetchedAt: number;
  source: "fresh" | "cache";
}

interface CachedSnapshot {
  fingerprint: string;
  models: readonly DiscoveredModel[];
  projectId?: string;
  fetchedAt: number;
}

interface FailedDiscovery {
  fingerprint: string;
  failedAt: number;
}

const DEFAULT_MAX_AGE_MS = 15 * 60_000;
const ANTIGRAVITY_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const GOOGLE_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.6-flash": "gemini-3.6-flash-high",
};

function bareModelId(runtimeModelId: string): string {
  const slash = runtimeModelId.indexOf("/");
  return slash >= 0 ? runtimeModelId.slice(slash + 1) : runtimeModelId;
}

function providerOfModel(model: ModelEntry): string | undefined {
  const runtimeId = model.runtimeId ?? model.id;
  const slash = runtimeId.indexOf("/");
  if (slash > 0) return runtimeId.slice(0, slash);
  if (/^(gemini|gemma|imagen)/i.test(model.id)) return "google";
  return undefined;
}

function equivalentModelIds(provider: string, modelId: string): Set<string> {
  const bare = bareModelId(modelId);
  const ids = new Set([bare]);
  if (provider === "google") {
    const alias = GOOGLE_MODEL_ALIASES[bare];
    if (alias) ids.add(alias);
    for (const [legacy, target] of Object.entries(GOOGLE_MODEL_ALIASES)) {
      if (target === bare) ids.add(legacy);
    }
  }
  return ids;
}

function matchesDiscovered(provider: string, modelId: string, discoveredId: string): boolean {
  const expected = equivalentModelIds(provider, modelId);
  return expected.has(bareModelId(discoveredId));
}

function normalizedDiscoveredModel(model: DiscoveredModel): DiscoveredModel | undefined {
  if (!validModelId(model.id)) return undefined;
  const capabilities = [...new Set(model.capabilities)].filter(
    (capability): capability is DiscoveryCapability => capability === "text" || capability === "tools" || capability === "image",
  );
  if (!capabilities.length) return undefined;
  const context = model.contextTokens;
  const contextTokens = typeof context === "number" && Number.isFinite(context) && context > 0
    ? Math.min(Math.floor(context), MAX_CONTEXT_TOKENS)
    : undefined;
  return { id: model.id, capabilities, ...(contextTokens ? { contextTokens } : {}) };
}

function supportsCapabilities(model: DiscoveredModel, required: readonly DiscoveryCapability[]): boolean {
  return required.every((capability) => model.capabilities.includes(capability));
}

function providerModel(model: ModelEntry, provider: string): boolean {
  return providerOfModel(model) === provider;
}

function routingCapabilities(model: DiscoveredModel): readonly RoutingCapability[] {
  return [...new Set(model.capabilities.flatMap((capability) => capability === "image" ? ["vision" as const] : [capability]))];
}

function routingTransports(provider: string): readonly RoutingTransport[] {
  if (provider === "anthropic") return ["anthropic"];
  if (provider === "opencode") return ["responses"];
  return ["chat", "responses"];
}

export class ModelDiscoveryManager {
  private readonly adapters: ReadonlyMap<string, ModelDiscoveryAdapter>;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedSnapshot>();
  private readonly failures = new Map<string, FailedDiscovery>();
  private readonly pending = new Map<string, Promise<DiscoverySnapshot | undefined>>();
  private readonly states = new Map<string, DiscoverySnapshot[]>();

  constructor(adapters: readonly ModelDiscoveryAdapter[], options: { maxAgeMs?: number; now?: () => number } = {}) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    this.now = options.now ?? Date.now;
  }

  async prepareCatalog(
    catalog: Catalog,
    accounts: ReadonlyMap<string, readonly DiscoveryAccount[]>,
    requiredCapabilities: readonly DiscoveryCapability[],
    fetchImplByProvider: ReadonlyMap<string, typeof fetch> = new Map(),
    signal?: AbortSignal,
  ): Promise<Catalog> {
    let prepared = catalog;
    for (const [provider, adapter] of this.adapters) {
      const snapshots: DiscoverySnapshot[] = [];
      const accountList = accounts.get(provider) ?? [];
      for (const account of accountList) {
        const snapshot = await this.loadSnapshot(adapter, account, fetchImplByProvider.get(provider) ?? fetch, signal);
        if (snapshot) snapshots.push(snapshot);
      }
      this.states.set(provider, snapshots);
      prepared = this.mergeProvider(prepared, provider, snapshots, requiredCapabilities);
    }
    return prepared;
  }

  accountIdsFor(provider: string, runtimeModelId: string): ReadonlySet<string> | undefined {
    const states = this.states.get(provider);
    if (!states?.length) return undefined;
    const ids = new Set<string>();
    for (const state of states) {
      if (state.models.some((model) => matchesDiscovered(provider, runtimeModelId, model.id))) ids.add(state.accountId);
    }
    return ids;
  }

  projectIdFor(provider: string, accountId: string): string | undefined {
    return this.states.get(provider)?.find((state) => state.accountId === accountId)?.projectId;
  }

  private async loadSnapshot(
    adapter: ModelDiscoveryAdapter,
    account: DiscoveryAccount,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
  ): Promise<DiscoverySnapshot | undefined> {
    const key = `${adapter.provider}:${account.id}`;
    const currentTime = this.now();
    const cached = this.cache.get(key);
    if (cached?.projectId && !account.projectId) account.projectId = cached.projectId;
    const fingerprint = accountFingerprint(account);
    const cacheMatches = cached?.fingerprint === fingerprint;
    if (cached && cacheMatches && currentTime - cached.fetchedAt < this.maxAgeMs) {
      return {
        accountId: account.id,
        provider: adapter.provider,
        models: cached.models,
        ...(cached.projectId ? { projectId: cached.projectId } : {}),
        fetchedAt: cached.fetchedAt,
        source: "cache",
      };
    }
    const failure = this.failures.get(key);
    if (failure?.fingerprint === fingerprint && currentTime - failure.failedAt < this.maxAgeMs) {
      return cached && cacheMatches
        ? {
            accountId: account.id,
            provider: adapter.provider,
            models: cached.models,
            ...(cached.projectId ? { projectId: cached.projectId } : {}),
            fetchedAt: cached.fetchedAt,
            source: "cache",
          }
        : undefined;
    }
    const pendingKey = `${key}:${fingerprint}`;
    const running = this.pending.get(pendingKey);
    if (running) return running;
    const request = (async () => {
      try {
        const models = (await adapter.discover(account, fetchImpl, signal)).map(normalizedDiscoveredModel).filter((model): model is DiscoveredModel => Boolean(model));
        if (!models.length) throw new Error("provider discovery returned no usable models");
        const fetchedAt = this.now();
        this.cache.set(key, { fingerprint, models, projectId: account.projectId, fetchedAt });
        this.failures.delete(key);
        return {
          accountId: account.id,
          provider: adapter.provider,
          models,
          ...(account.projectId ? { projectId: account.projectId } : {}),
          fetchedAt,
          source: "fresh" as const,
        };
      } catch {
        this.failures.set(key, { fingerprint, failedAt: this.now() });
        if (!cached || !cacheMatches) return undefined;
        return {
          accountId: account.id,
          provider: adapter.provider,
          models: cached.models,
          ...(cached.projectId ? { projectId: cached.projectId } : {}),
          fetchedAt: cached.fetchedAt,
          source: "cache" as const,
        };
      } finally {
        this.pending.delete(pendingKey);
      }
    })();
    this.pending.set(pendingKey, request);
    return request;
  }

  private mergeProvider(
    catalog: Catalog,
    provider: string,
    snapshots: readonly DiscoverySnapshot[],
    requiredCapabilities: readonly DiscoveryCapability[],
  ): Catalog {
    const discovered = new Map<string, DiscoveredModel>();
    for (const snapshot of snapshots) {
      for (const model of snapshot.models) {
        if (supportsCapabilities(model, requiredCapabilities)) discovered.set(model.id, model);
      }
    }
    const existingProvider = catalog.models.filter((model) => providerModel(model, provider));
    if (!snapshots.length) return catalog;
    if (!discovered.size) return { ...catalog, models: catalog.models.filter((model) => !providerModel(model, provider)) };

    const retained = existingProvider.flatMap((model) => {
      const match = [...discovered.values()].find((discoveredModel) => matchesDiscovered(provider, model.id, discoveredModel.id));
      if (!match) return [];
      return [{
        ...model,
        capabilities: routingCapabilities(match),
        transports: routingTransports(provider),
        ...(match.contextTokens && match.contextTokens !== model.windowTokens ? { windowTokens: match.contextTokens } : {}),
      }];
    });
    const additions = [...discovered.values()]
      .filter((model) => !existingProvider.some((entry) => matchesDiscovered(provider, entry.id, model.id)))
      .map((model) => discoveredModelEntry(provider, model));
    const unchanged = retained.length === existingProvider.length
      && additions.length === 0
      && retained.every((model, index) => model === existingProvider[index]);
    if (unchanged) return catalog;
    const otherProviders = catalog.models.filter((model) => !providerModel(model, provider));
    return { ...catalog, models: [...otherProviders, ...retained, ...additions] };
  }
}

function accountFingerprint(account: DiscoveryAccount): string {
  return createHash("sha256")
    .update(`${account.token}\0${account.projectId ?? ""}`)
    .digest("hex");
}

export const googleModelDiscovery: ModelDiscoveryAdapter = {
  provider: "google",
  async discover(account, fetchImpl, signal) {
    let project = account.projectId;
    if (!project) {
      project = await ensureGoogleProject(account.token, fetchImpl, signal).catch(() => undefined);
      if (project) account.projectId = project;
    }
    const response = await fetchImpl(ANTIGRAVITY_MODELS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${account.token}`,
        accept: "*/*",
        "content-type": "application/json",
        "user-agent": antigravityUserAgent(),
      },
      body: JSON.stringify(project ? { project } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Google model discovery failed (${response.status})`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Google model discovery returned invalid JSON");
    }
    const models = parseAntigravityModels(payload);
    if (!models.length) throw new Error("Google model discovery returned no usable models");
    return models;
  },
};

export function discoveredModelEntry(provider: string, model: DiscoveredModel): ModelEntry {
  const codingIndex = /pro|opus|sonnet|high/i.test(model.id) ? 80 : 70;
  const blendedPrice = 1;
  return {
    id: model.id,
    runtimeId: `${provider}/${model.id}`,
    codingIndex,
    blendedPrice,
    value: codingIndex / blendedPrice,
    windowTokens: model.contextTokens ?? 128000,
    isFree: false,
    capabilities: routingCapabilities(model),
    transports: routingTransports(provider),
  };
}
