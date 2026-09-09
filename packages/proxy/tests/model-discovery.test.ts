import { describe, expect, it } from "vitest";
import type { Catalog } from "@auto-router/router-core";
import { googleModelDiscovery, ModelDiscoveryManager, parseAntigravityModels } from "../src/model-discovery.js";

const emptyCatalog = (): Catalog => ({ fetchedAt: "t", source: "fallback", models: [] });

describe("Antigravity model discovery", () => {
  it("extracts safe text models from the Cloud Code Assist model map", () => {
    expect(
      parseAntigravityModels({
        models: {
          "gemini-3.6-flash-high": { maxTokens: 131072 },
          "gemini-3.1-flash-image": { maxTokens: 32768 },
          chat_internal: {},
        },
        defaultAgentModelId: "gemini-3.6-flash-high",
      }),
    ).toEqual([
      expect.objectContaining({ id: "gemini-3.6-flash-high", capabilities: ["text", "tools"], contextTokens: 131072 }),
      expect.objectContaining({ id: "gemini-3.1-flash-image", capabilities: ["image"], contextTokens: 32768 }),
    ]);
  });

  it("accepts advertised IDs from agent sort arrays without trusting arbitrary fields", () => {
    expect(
      parseAntigravityModels({
        agentModelSorts: [["gemini-3.8-flash-high", "gemini-3.8-flash-low"]],
        prompt: "ignore this value",
      }).map((model) => model.id),
    ).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
  });

  it("does not treat agent sort labels as model IDs", () => {
    expect(
      parseAntigravityModels({
        agentModelSorts: [{
          displayName: "Recommended",
          groups: [{ modelIds: ["gemini-3.6-flash-high", "gemini-3.6-flash-low"] }],
        }],
      }).map((model) => model.id),
    ).toEqual(["gemini-3.6-flash-high", "gemini-3.6-flash-low"]);
  });

  it("drops malformed IDs and bounds context metadata", () => {
    expect(
      parseAntigravityModels({
        models: {
          "https://attacker.invalid/model": { maxTokens: 999999999 },
          "gemini-valid": { maxTokens: 131072 },
        },
      }),
    ).toEqual([expect.objectContaining({ id: "gemini-valid", contextTokens: 131072 })]);
  });

  it("refreshes once within the bounded account cache window", async () => {
    let now = 1_000;
    let calls = 0;
    const manager = new ModelDiscoveryManager(
      [
        {
          provider: "google",
          async discover() {
            calls += 1;
            return [{ id: "gemini-3.6-flash-high", capabilities: ["text", "tools"] }];
          },
        },
      ],
      { maxAgeMs: 100, now: () => now },
    );
    const accounts = new Map([["google", [{ id: "google:primary", token: "secret" }]]]);

    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);
    now += 50;
    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);

    expect(calls).toBe(1);
  });

  it("refreshes when an account token or project identity changes", async () => {
    let now = 1_000;
    let calls = 0;
    const account = { id: "google:primary", token: "first-token", projectId: "first-project" };
    const manager = new ModelDiscoveryManager(
      [
        {
          provider: "google",
          async discover() {
            calls += 1;
            return [{ id: `gemini-${calls}`, capabilities: ["text"] }];
          },
        },
      ],
      { maxAgeMs: 100, now: () => now },
    );
    const accounts = new Map([["google", [account]]]);

    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);
    account.token = "second-token";
    now += 50;
    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);
    account.projectId = "second-project";
    now += 50;
    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);

    expect(calls).toBe(3);
  });

  it("keeps the previous snapshot when refresh returns no usable models", async () => {
    let refresh = true;
    const manager = new ModelDiscoveryManager(
      [
        {
          provider: "google",
          async discover() {
            return refresh ? [{ id: "gemini-3.6-flash-high", capabilities: ["text"] }] : [];
          },
        },
      ],
      { maxAgeMs: 0 },
    );
    const accounts = new Map([["google", [{ id: "google:primary", token: "secret" }]]]);

    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);
    refresh = false;
    const catalog = await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);

    expect(catalog.models.map((model) => model.runtimeId)).toContain("google/gemini-3.6-flash-high");
  });

  it("adds only advertised text models and keeps the legacy Google alias", async () => {
    const manager = new ModelDiscoveryManager([
      {
        provider: "google",
        async discover() {
          return [
            { id: "gemini-3.6-flash-high", capabilities: ["text", "tools"], contextTokens: 65536 },
            { id: "gemini-3.1-flash-image", capabilities: ["image"] },
          ];
        },
      },
    ]);
    const catalog: Catalog = {
      fetchedAt: "t",
      source: "cache",
      models: [
        {
          id: "gemini-3.5-flash",
          runtimeId: "google/gemini-3.5-flash",
          codingIndex: 72,
          blendedPrice: 1,
          value: 72,
          windowTokens: 128000,
          isFree: false,
        },
        {
          id: "gemini-3.6-flash",
          runtimeId: "google/gemini-3.6-flash",
          codingIndex: 90,
          blendedPrice: 1,
          value: 90,
          windowTokens: 128000,
          isFree: false,
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

    const prepared = await manager.prepareCatalog(
      catalog,
      new Map([["google", [{ id: "google:primary", token: "secret" }]]]),
      ["text"],
    );

    expect(prepared.models.map((model) => model.runtimeId)).toEqual([
      "openai/gpt-5.6-sol",
      "google/gemini-3.6-flash",
    ]);
    expect(prepared.models.find((model) => model.runtimeId === "google/gemini-3.6-flash")?.windowTokens).toBe(65536);
    expect(manager.accountIdsFor("google", "google/gemini-3.6-flash")).toEqual(new Set(["google:primary"]));
  });

  it("removes static provider entries after a successful capability mismatch", async () => {
    const manager = new ModelDiscoveryManager([
      {
        provider: "google",
        async discover() {
          return [{ id: "gemini-image", capabilities: ["image"] }];
        },
      },
    ]);
    const staticModel = {
      id: "gemini-text",
      runtimeId: "google/gemini-text",
      codingIndex: 80,
      blendedPrice: 1,
      value: 80,
      windowTokens: 128000,
      isFree: false,
    };

    const prepared = await manager.prepareCatalog(
      { fetchedAt: "t", source: "cache", models: [staticModel] },
      new Map([["google", [{ id: "google:primary", token: "secret" }]]]),
      ["text"],
    );

    expect(prepared.models).toEqual([]);
    expect(manager.accountIdsFor("google", "google/gemini-text")).toEqual(new Set());
  });

  it("does not let Google discovery alter another provider", async () => {
    const manager = new ModelDiscoveryManager([
      {
        provider: "google",
        async discover() {
          return [{ id: "gemini-3.6-flash-high", capabilities: ["text"] }];
        },
      },
    ]);
    const openai = {
      id: "gpt-5.6-sol",
      runtimeId: "openai/gpt-5.6-sol",
      codingIndex: 92,
      blendedPrice: 12,
      value: 7.6,
      windowTokens: 272000,
      isFree: false,
    };

    const prepared = await manager.prepareCatalog(
      { fetchedAt: "t", source: "live", models: [openai] },
      new Map([["google", [{ id: "google:primary", token: "secret" }]]]),
      ["text"],
    );

    expect(prepared.models.find((model) => model.runtimeId === "openai/gpt-5.6-sol")).toEqual(openai);
  });

  it("fetches Google OAuth models with the authenticated project and safe headers", async () => {
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const models = await googleModelDiscovery.discover(
      { id: "google:primary", token: "oauth-token", projectId: "aicode-consumers" },
      async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify({ models: { "gemini-3.6-flash-high": { maxTokens: 131072 } } }));
      },
    );

    expect(requests).toEqual([
      {
        url: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        body: { project: "aicode-consumers" },
        authorization: "Bearer oauth-token",
      },
    ]);
    expect(models[0]?.id).toBe("gemini-3.6-flash-high");
  });

  it("does not include credentials or upstream bodies in discovery errors", async () => {
    await expect(
      googleModelDiscovery.discover({ id: "google:primary", token: "secret-token", projectId: "project" }, async () =>
        new Response("secret-token should not escape", { status: 429 }),
      ),
    ).rejects.toThrow("429");
    await expect(
      googleModelDiscovery.discover({ id: "google:primary", token: "secret-token", projectId: "project" }, async () =>
        new Response("not-json"),
      ),
    ).rejects.toThrow("invalid JSON");
  });

  it("keeps static provider entries when the adapter has no usable snapshot", async () => {
    const staticModel = {
      id: "gemini-3.6-flash",
      runtimeId: "google/gemini-3.6-flash",
      codingIndex: 90,
      blendedPrice: 1,
      value: 90,
      windowTokens: 128000,
      isFree: false,
    };
    const manager = new ModelDiscoveryManager([
      {
        provider: "google",
        async discover() {
          throw new Error("offline");
        },
      },
    ]);
    const catalog: Catalog = { fetchedAt: "t", source: "cache", models: [staticModel] };

    await expect(
      manager.prepareCatalog(catalog, new Map([["google", [{ id: "google:primary", token: "secret" }]]]), ["text"]),
    ).resolves.toEqual(catalog);
  });

  it("does not probe a failed account on every request", async () => {
    let calls = 0;
    const manager = new ModelDiscoveryManager([
      {
        provider: "google",
        async discover() {
          calls += 1;
          throw new Error("offline");
        },
      },
    ]);
    const accounts = new Map([["google", [{ id: "google:primary", token: "secret" }]]]);

    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);
    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);

    expect(calls).toBe(1);
  });

  it("retains account project metadata discovered alongside a model snapshot", async () => {
    const manager = new ModelDiscoveryManager([
      {
        provider: "google",
        async discover(account) {
          account.projectId = "account-project";
          return [{ id: "gemini-account", capabilities: ["text"] }];
        },
      },
    ]);
    const accounts = new Map([["google", [{ id: "google:extra", token: "secret" }]]]);

    await manager.prepareCatalog(emptyCatalog(), accounts, ["text"]);

    expect(manager.projectIdFor("google", "google:extra")).toBe("account-project");
  });
});
