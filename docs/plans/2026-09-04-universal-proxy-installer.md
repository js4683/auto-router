# Universal Proxy + Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local proxy settings UI and an installer that points Claude Code, Codex, Cursor, and OpenCode at `:8787`, without distributing the OpenCode plugin.

**Architecture:** Grow `packages/proxy`. Add env-file helpers and loopback HTML settings. Add `packages/install` that patches managed client-config blocks. `router-core` policy stays task-sticky and fail-open.

**Tech Stack:** TypeScript, Node `http`, Vitest, existing proxy server

**Spec:** `docs/plans/2026-09-04-universal-proxy-installer-design.md`

## Global Constraints

- Task-level stickiness; no per-turn switching.
- Fail-open when a backend key/target is missing.
- Env files mode `0600`; never log key values.
- Loopback UI only.
- OpenCode plugin is not installed or removed.
- No Postgres, no `rk_` keys, no hosted cloud.

---

### Task 1: Local env file helper

**Files:**
- Create: `packages/proxy/src/env-file.ts`
- Test: `packages/proxy/tests/env-file.test.ts`

**Interfaces:**
- Consumes: Node `fs`, `os`
- Produces: `ENV_KEYS = ["OPENAI_API_KEY","OPENCODE_API_KEY","ANTHROPIC_API_KEY","GEMINI_API_KEY","OPENAI_BASE_URL","OPENCODE_BASE_URL","ANTHROPIC_BASE_URL","GEMINI_BASE_URL"] as const`
- Produces: `defaultEnvPath(): string` → `join(homedir(), ".config/auto-router/.env")`
- Produces: `readEnvFile(path: string): Record<string, string>`
- Produces: `writeEnvFile(path: string, updates: Record<string, string>): void` — merge, skip empty values, mode `0600`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFile, writeEnvFile } from "../src/env-file.js";

describe("env-file", () => {
  it("merges updates, keeps existing keys, and writes mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-env-"));
    const path = join(dir, ".env");
    writeEnvFile(path, { OPENAI_API_KEY: "sk-old", ANTHROPIC_API_KEY: "sk-ant" });
    writeEnvFile(path, { OPENAI_API_KEY: "sk-new", GEMINI_API_KEY: "" });
    expect(readEnvFile(path)).toEqual({ OPENAI_API_KEY: "sk-new", ANTHROPIC_API_KEY: "sk-ant" });
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    expect(readFileSync(path, "utf8")).not.toMatch(/sk-old/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@auto-router/proxy -- tests/env-file.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Parse `KEY=value` lines. Ignore comments/blank. `writeEnvFile` reads existing, assigns only keys in `ENV_KEYS`, ignores `updates` whose value is `""`, `mkdirSync` parent `0700`, `writeFileSync` mode `0600`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@auto-router/proxy -- tests/env-file.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/env-file.ts packages/proxy/tests/env-file.test.ts
git commit -m "feat(proxy): add local env file helper"
```

---

### Task 2: Loopback settings UI

**Files:**
- Create: `packages/proxy/src/settings-ui.ts` — HTML string, no keys in markup
- Modify: `packages/proxy/src/server.ts` — `GET /` and `POST /settings` before body read
- Test: `packages/proxy/tests/server.test.ts`

**Interfaces:**
- Consumes: `readEnvFile`, `writeEnvFile`, `defaultEnvPath`
- Produces: `settingsPage(masked: Record<string, string>): string` — show `set` / `missing`, never raw secrets
- Produces: POST `/settings` application/x-www-form-urlencoded → `writeEnvFile`

- [ ] **Step 1: Write the failing tests**

In `packages/proxy/tests/server.test.ts`, using the existing `createProxyServer` harness:

```ts
it("serves a settings page without leaking env values", async () => {
  process.env.OPENAI_API_KEY = "sk-secret-test";
  const { handle } = createProxyServer(testOpts());
  const req = getReq("/"); // existing IncomingMessage helper if present; else new IncomingMessage
  // assert res body includes "auto-router" and does not include "sk-secret-test"
});

it("saves non-empty settings to the env file", async () => {
  // POST /settings with ANTHROPIC_API_KEY=sk-ant-1
  // readEnvFile(tempPath) equals { ANTHROPIC_API_KEY: "sk-ant-1" }
});
```

If `createProxyServer` does not take `envPath`, add an optional `envPath?: string` on the existing options object (default `defaultEnvPath()`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@auto-router/proxy -- tests/server.test.ts`

Expected: FAIL — GET `/` currently falls through to JSON body parse

- [ ] **Step 3: Write minimal implementation**

In `handle`, before `readBody`:

```ts
if (req.method === "GET" && (path === "/" || path === "/ui")) {
  const env = readEnvFile(opts.envPath ?? defaultEnvPath());
  const masked = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key] ? "set" : "missing"]));
  html(res, 200, settingsPage(masked));
  return;
}
if (req.method === "POST" && path === "/settings") {
  const raw = await readBody(req);
  const updates = Object.fromEntries(new URLSearchParams(raw));
  writeEnvFile(opts.envPath ?? defaultEnvPath(), updates);
  res.statusCode = 303;
  res.setHeader("location", "/");
  res.end();
  return;
}
```

Form fields named exactly `ENV_KEYS`. Bind the HTTP server to `127.0.0.1` only (already default).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@auto-router/proxy`

Expected: PASS including new UI tests

- [ ] **Step 5: Commit**

```bash
git add packages/proxy/src/settings-ui.ts packages/proxy/src/server.ts packages/proxy/tests/server.test.ts
git commit -m "feat(proxy): serve loopback settings UI"
```

---

### Task 3: Client installer

**Files:**
- Create: `packages/install/src/managed-block.ts`
- Create: `packages/install/src/clients.ts`
- Create: `packages/install/src/cli.ts`
- Create: `packages/install/tests/install.test.ts`
- Create: `packages/install/package.json` (workspace, `"type": "module"`, vitest)
- Modify: root `package.json` workspaces already `packages/*`; add `"install-clients": "npm run start --workspace=@auto-router/install"`

**Interfaces:**
- Consumes: none of the proxy runtime
- Produces: `MANAGED_BEGIN = "# auto-router managed begin"` / `MANAGED_END`
- Produces: `applyManagedBlock(existing: string, block: string): string`
- Produces: `removeManagedBlock(existing: string): string`
- Produces: `claudeBlock(baseUrl: string): string` — JSON snippet setting `ANTHROPIC_BASE_URL`
- Produces: `codexBlock(baseUrl: string): string` — TOML `[model_providers.auto-router]`
- Produces: `opencodeBlock(baseUrl: string): string` — JSON `provider["auto-router"]` Anthropic-compatible `baseURL` `${baseUrl}` (Messages)
- Produces: `cursorInstructions(baseUrl: string): string` — printed override `baseUrl + "/v1"` (Cursor has no stable file API)
- Produces: `runInstall(args: { home: string; baseUrl: string; clients: Array<"claude"|"codex"|"opencode"|"cursor">; uninstall?: boolean }): { written: string[]; notes: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
it("inserts and removes a managed block without touching surrounding config", () => {
  const before = "keep=1\n";
  const once = applyManagedBlock(before, "FOO=bar\n");
  const twice = applyManagedBlock(once, "FOO=baz\n");
  expect(twice.match(/FOO=/g)).toHaveLength(1);
  expect(twice).toContain("FOO=baz");
  expect(removeManagedBlock(twice)).toBe(before);
});

it("writes Claude, Codex, and OpenCode managed files under a fake home", () => {
  const home = mkdtempSync(join(tmpdir(), "ar-install-"));
  const result = runInstall({ home, baseUrl: "http://127.0.0.1:8787", clients: ["claude", "codex", "opencode", "cursor"] });
  expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toContain("http://127.0.0.1:8787");
  expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("auto-router");
  expect(readFileSync(join(home, ".config/opencode/opencode.json"), "utf8")).toContain("auto-router");
  expect(result.notes.join("\n")).toMatch(/Cursor/i);
});
```

Claude settings path: `join(home, ".claude/settings.json")` with `{ env: { ANTHROPIC_BASE_URL: baseUrl } }` merged, managed via a sibling `settings.auto-router.json` if merging JSON without comments is easier — prefer one JSON file with an `"autoRouterManaged": true` marker plus only the `env.ANTHROPIC_BASE_URL` key, and uninstall deletes that key only.

Codex: `join(home, ".codex/config.toml")` append managed TOML:

```toml
# auto-router managed begin
[model_providers.auto-router]
name = "auto-router"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "chat"
# auto-router managed end
```

OpenCode: merge `provider["auto-router"]` with `npm: "@ai-sdk/anthropic"`, `options.baseURL: "http://127.0.0.1:8787"`. Do not copy `.opencode/plugins/auto-router.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@auto-router/install -- tests/install.test.ts`

Expected: FAIL — workspace/module missing

- [ ] **Step 3: Write minimal implementation**

CLI: `node packages/install/dist/src/cli.js --claude --codex --opencode --cursor [--uninstall] [--base-url http://127.0.0.1:8787]`. Default home `os.homedir()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@auto-router/install` and `npm test --workspace=@auto-router/proxy`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/install package.json
git commit -m "feat(install): wire Claude, Codex, Cursor, OpenCode to the proxy"
```

---

### Task 4: Docs

**Files:**
- Modify: `README.md` — public path is proxy + installer; plugin is private
- Modify: `PLAN.md` — decision log 2026-09-04
- Modify: `docs/plans/2026-09-04-universal-proxy-installer-design.md` — implementation status

- [ ] **Step 1: Update README apply-path**

Public quickstart:

```bash
npm start --workspace=@auto-router/proxy
npm run install-clients -- --claude --codex --opencode --cursor
# open http://127.0.0.1:8787 and paste provider keys
```

State that the OpenCode plugin is not part of this distribution.

- [ ] **Step 2: Run docs-only check**

`git diff --check`

- [ ] **Step 3: Commit**

```bash
git add README.md PLAN.md docs/plans/2026-09-04-universal-proxy-installer-design.md
git commit -m "docs: public v1 is proxy plus installer"
```

---

## Spec coverage

| Spec | Task |
|------|------|
| Env `.env` 0600 + UI | 1–2 |
| GET `/` settings, no secret logs | 2 |
| Installer four clients, Anthropic for CC/OpenCode | 3 |
| Plugin not shipped | 3–4 |
| Fail-open / stickiness unchanged | existing proxy tests in 2/3 |
| No Postgres / rk_ / hosted | all |

## Risks

| Risk | Mitigation |
|------|------------|
| Cursor has no file API | Print instructions; do not invent a config path |
| Claude settings.json schemas vary | Only set `env.ANTHROPIC_BASE_URL`; uninstall removes that key |
| OpenCode Anthropic provider vs Chat Completions | Installer uses Anthropic; Codex/Cursor stay Chat Completions |
