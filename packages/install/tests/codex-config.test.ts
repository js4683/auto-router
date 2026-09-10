import { describe, expect, it } from "vitest";
import { removeCodexProvider, upsertCodexProvider } from "../src/managed-block.js";

describe("Codex config", () => {
  it("inserts root activation before existing tables", () => {
    const existing = 'theme = "dark"\n[profiles.work]\nmodel_provider = "user"\n';
    const next = upsertCodexProvider(existing, "http://127.0.0.1:8787");

    expect(next.indexOf('model_provider = "auto-router"')).toBeLessThan(next.indexOf("[profiles.work]"));
    expect(next.match(/\[model_providers\.auto-router\]/g)).toHaveLength(1);
    expect(next).toContain('model_provider = "user"');
    expect(upsertCodexProvider(next, "http://127.0.0.1:8787")).toBe(next);
  });

  it("keeps trailing tables and replaces an existing root assignment", () => {
    const existing = 'model_provider = "user"\n[profiles.work]\nmodel_provider = "profile"\n[other]\nvalue = true\n';
    const next = upsertCodexProvider(existing, "https://router.example///");

    expect(next.match(/model_provider = "auto-router"/g)).toHaveLength(1);
    expect(next).toContain("[other]\nvalue = true");
    expect(next.indexOf("[model_providers.auto-router]")).toBeLessThan(next.indexOf("[profiles.work]"));
  });

  it("refuses to overwrite an unmarked provider table", () => {
    const existing = '[model_providers.auto-router]\nname = "user-owned"\nbase_url = "https://user.example/v1"\n';

    expect(() => upsertCodexProvider(existing, "http://127.0.0.1:8787")).toThrow(/user-owned|collision/i);
  });

  it("preserves an edited managed block during uninstall", () => {
    const installed = upsertCodexProvider("theme = \"dark\"\n", "http://127.0.0.1:8787");
    const edited = installed.replace('wire_api = "responses"', 'wire_api = "chat"');
    const state = { ownedKeys: ["model_provider", "model_providers.auto-router"], ownedValues: { baseUrl: "http://127.0.0.1:8787/v1" } };

    expect(removeCodexProvider(edited, state, "http://127.0.0.1:8787")).toBe(edited);
  });

  it("removes an unchanged managed block without touching surrounding TOML", () => {
    const before = 'theme = "dark"\n';
    const installed = upsertCodexProvider(before, "http://127.0.0.1:8787");
    const state = { ownedKeys: ["model_provider", "model_providers.auto-router"], ownedValues: { baseUrl: "http://127.0.0.1:8787/v1" } };

    expect(removeCodexProvider(installed, state, "http://127.0.0.1:8787")).toBe(before);
  });
});
