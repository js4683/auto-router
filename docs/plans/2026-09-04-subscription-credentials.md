# Subscription Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve per-provider credentials from env keys, then OpenCode auth, then Claude Code login, without logging tokens.

**Architecture:** Add `packages/proxy/src/credentials.ts`. At upstream send, if `backend.apiKey` is missing, fill from `resolveCredential(modelId, { env, authPath, claudePath })`. Bootstrap loads `~/.config/auto-router/.env` into `process.env`.

**Tech Stack:** TypeScript, Vitest, existing proxy

**Spec:** `docs/plans/2026-09-04-subscription-credentials-design.md`

## Global Constraints

- Multi-provider; not tied to one vendor.
- Env key wins over stored subscription tokens.
- Never log tokens or put them in error messages.
- Cursor Pro quota is unused.
- In-UI OAuth is out of scope.

---

### Task 1: resolveCredential

**Files:**
- Create: `packages/proxy/src/credentials.ts`
- Test: `packages/proxy/tests/credentials.test.ts`

**Interfaces:**
- Produces: `resolveCredential(runtimeId: string, opts: { env: NodeJS.ProcessEnv; authPath?: string; claudePath?: string }): string | undefined`
- Provider = `runtimeId.slice(0, runtimeId.indexOf("/"))`
- Env map: openai→OPENAI_API_KEY, opencode→OPENCODE_API_KEY, anthropic→ANTHROPIC_API_KEY, google→GEMINI_API_KEY then GOOGLE_API_KEY
- OpenCode auth.json: `auth[id].key` or `auth[id].token` or `auth[id].access` if string
- Claude: if provider is anthropic and `claudePath` file exists, read JSON `token` or `key` or `oauth.accessToken` if string; if missing/unknown shape, return undefined

- [ ] **Step 1: Write the failing test**

```ts
it("prefers env over OpenCode auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-cred-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth", access: "oauth-token" } }));
  expect(resolveCredential("openai/gpt-4o", { env: { OPENAI_API_KEY: "sk-env" }, authPath })).toBe("sk-env");
  expect(resolveCredential("openai/gpt-4o", { env: {}, authPath })).toBe("oauth-token");
});

it("does not put tokens in thrown errors", () => {
  expect(resolveCredential("unknown/x", { env: {} })).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

`npm test --workspace=@auto-router/proxy -- tests/credentials.test.ts`

Expected: FAIL module not found

- [ ] **Step 3: Minimal implementation** — try/catch file reads; never concatenate token into Error.message

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit** `feat(proxy): resolve env then OpenCode then Claude credentials`

---

### Task 2: Use resolver on upstream calls

**Files:**
- Modify: `packages/proxy/src/server.ts` around backend fetch (~1035)
- Modify: `bootstrapProxyOptions` to `Object.assign(process.env, readEnvFile(defaultEnvPath()))` before reading keys
- Test: `packages/proxy/tests/server.test.ts`

**Interfaces:**
- Consumes: `resolveCredential`
- When `backend.apiKey` is falsy, `apiKey = resolveCredential(result.modelId, { env: process.env })`

- [ ] **Step 1: Failing test** — createProxyServer with `openai: { baseUrl, apiKey: undefined, fetchImpl }` that records `authorization` header; auth.json via env `OPENCODE_AUTH_PATH` or new opts `authPath`. Simplest: set `process.env.OPENAI_API_KEY` empty, pass `credentialAuthPath` on options.

Add optional `authPath?: string` on `CreateProxyServerOptions`.

Test: OpenCode auth has openai access `tok-from-auth`; backend apiKey undefined; fetchImpl sees `Bearer tok-from-auth`.

- [ ] **Step 2: Run fail** — no Authorization from auth

- [ ] **Step 3: Wire resolver**

- [ ] **Step 4: `npm test --workspace=@auto-router/proxy` PASS

- [ ] **Step 5: Commit** `feat(proxy): attach subscription credentials to upstream requests`

---

### Task 3: Docs

**Files:** README.md, PLAN.md, subscription-credentials-design.md status

- [ ] Document: keys in UI optional if OpenCode/Claude Code already logged in; eval can use `AUTO_ROUTER_EVAL_BASE_URL=http://127.0.0.1:8787/v1`
- [ ] Commit `docs: subscription credentials chain`

---

## Spec coverage

| Spec | Task |
|------|------|
| Env then OpenCode then Claude | 1 |
| No token in errors | 1 |
| Proxy uses resolver | 2 |
| Load .env on bootstrap | 2 |
| Eval through proxy | 3 |
| Cursor Pro unused | 3 |
