import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addExtraAccount, listProviderAccounts, removeExtraAccount, saveProviderCredential } from "../src/accounts.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ar-acct-"));
}

describe("addExtraAccount", () => {
  it("stores an extra login without writing auth.json", () => {
    const dir = tmpDir();
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api", key: "sk-primary" } }));
    const extra = addExtraAccount(accountsPath, { provider: "openai", type: "api", key: "sk-extra", email: "second@example.com" });
    expect(extra.id).toBeTruthy();
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("sk-primary");
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts).toEqual([
      expect.objectContaining({ provider: "openai", key: "sk-extra", email: "second@example.com" }),
    ]);
    expect(removeExtraAccount(accountsPath, extra.id)).toBe(true);
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts).toEqual([]);
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("sk-primary");
  });
});

describe("listProviderAccounts", () => {
  it("returns the primary auth login then extras", () => {
    const dir = tmpDir();
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth", access: "tok-primary", email: "one@example.com" } }));
    addExtraAccount(accountsPath, { provider: "openai", type: "api", key: "sk-extra", email: "two@example.com" });
    const listed = listProviderAccounts("openai", { env: {}, authPath, accountsPath });
    expect(listed.map((account) => account.email)).toEqual(["one@example.com", "two@example.com"]);
    expect(listed[0]?.primary).toBe(true);
    expect(listed[1]?.primary).toBe(false);
    expect(listed.map((account) => account.token)).toEqual(["tok-primary", "sk-extra"]);
  });

  it("does not overwrite a malformed accounts file", () => {
    const dir = tmpDir();
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(accountsPath, "{not-json");
    expect(() => addExtraAccount(accountsPath, { provider: "openai", type: "api", key: "sk-x" })).toThrow();
    expect(readFileSync(accountsPath, "utf8")).toBe("{not-json");
  });

  it("does not treat extra Google OAuth access tokens as Gemini keys", () => {
    const dir = tmpDir();
    const accountsPath = join(dir, "accounts.json");
    addExtraAccount(accountsPath, { provider: "google", type: "oauth", access: "ya29.extra" });
    expect(listProviderAccounts("google", { env: {}, accountsPath })).toEqual([]);
  });
});

describe("saveProviderCredential", () => {
  it("writes extra when a primary login already exists", () => {
    const dir = tmpDir();
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "tok-one" } }));
    const saved = saveProviderCredential({
      provider: "anthropic",
      entry: { type: "oauth", access: "tok-two", email: "two@example.com" },
      authPath,
      accountsPath,
    });
    expect(saved.extra).toBe(true);
    expect(JSON.parse(readFileSync(authPath, "utf8")).anthropic.access).toBe("tok-one");
    expect(JSON.parse(readFileSync(accountsPath, "utf8")).accounts[0].access).toBe("tok-two");
  });

  it("writes primary when no login exists yet", () => {
    const dir = tmpDir();
    const authPath = join(dir, "auth.json");
    const accountsPath = join(dir, "accounts.json");
    const saved = saveProviderCredential({
      provider: "openai",
      entry: { type: "api", key: "sk-first" },
      authPath,
      accountsPath,
    });
    expect(saved.extra).toBe(false);
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("sk-first");
    expect(() => readFileSync(accountsPath, "utf8")).toThrow();
  });
});
