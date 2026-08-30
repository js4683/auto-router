# Avengers-Pro Scorer + Harness Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score the first message of a task with Avengers-Pro, map paper models onto the live catalog, and apply the chosen model through a local OpenAI/Anthropic proxy.

**Architecture:** Keep scoring and policy in harness-agnostic `router-core`. Add a TypeScript Avengers-Pro inference module that loads tiny committed fixtures, a `modelMap` that prefers LLMRouterBench joins over hand aliases, and a `packages/proxy` adapter that rewrites only `model` then forwards. The OpenCode plugin stays observational.

**Tech Stack:** TypeScript, Node 22, Vitest, npm workspaces, Node `fetch` / `node:http`. No Python, sklearn, or Workweave code in the runtime path.

**Spec:** `docs/superpowers/specs/2026-08-30-avengers-pro-proxy-design.md`

## Global Constraints

- Do not implement or compete for `anomalyco/opencode#45764`.
- Do not exec Avengers-Pro Python from the proxy.
- Avengers-Pro runs only on a confirmed task boundary; hold `taskTarget` afterward.
- Prefer `source: "bench"` mappings over `source: "hand"`.
- Explicit tags (`[task:planning]`, `[force:…]`) still win before the scorer.
- Planning still requires quality `>= 85`. Verification still prefers free, then lowest cost.
- Embedding or artifact failure must fall back to heuristic `selectModel`, never fail the user request.
- Do not log API keys. Do not commit secrets.
- Do not mutate `chat.params` model fields in the OpenCode plugin.
- First slice endpoints only: `/v1/chat/completions`, `/v1/messages`, `/v1/route`, `/health`, `/v1/models`.
- No live-network tests in CI.

## File Map

- Create: `packages/router-core/src/avengers-pro.ts` — load artifacts, embed (injected), score, rank paper IDs.
- Create: `packages/router-core/src/model-map.ts` — resolve paper IDs to connected runtime IDs.
- Create: `packages/router-core/artifacts/avengers-pro/fixture/` — tiny 2-cluster JSON used by tests and as the default offline artifact.
- Create: `packages/router-core/tests/avengers-pro.test.ts`
- Create: `packages/router-core/tests/model-map.test.ts`
- Modify: `packages/router-core/src/types.ts` — Avengers-Pro config, map entry, `via: "avengers-pro"`.
- Modify: `packages/router-core/src/config.ts` — default `avengersPro` + empty `modelMap`.
- Modify: `packages/router-core/src/selector.ts` — consume ranked list on a boundary, then overlays.
- Modify: `packages/router-core/src/index.ts` — export new modules.
- Modify: `packages/router-core/tests/selector.test.ts` — Avengers-Pro + overlay + fallback cases.
- Modify: `auto-router.json` — `avengersPro` and initial `modelMap`.
- Create: `packages/proxy/package.json`, `packages/proxy/tsconfig.json`, `packages/proxy/src/server.ts`, `packages/proxy/src/session.ts`, `packages/proxy/tests/server.test.ts`
- Modify: `PLAN.md`, `design.md`, `README.md` — proxy is the apply path.

---

### Task 1: Avengers-Pro inference types and fixture scorer

**Files:**
- Create: `packages/router-core/src/avengers-pro.ts`
- Create: `packages/router-core/artifacts/avengers-pro/fixture/metadata.json`
- Create: `packages/router-core/artifacts/avengers-pro/fixture/cluster_centers.json`
- Create: `packages/router-core/artifacts/avengers-pro/fixture/cluster_rankings.json`
- Create: `packages/router-core/tests/avengers-pro.test.ts`
- Modify: `packages/router-core/src/types.ts`
- Modify: `packages/router-core/src/index.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `export interface AvengersProArtifacts { nClusters: number; embeddingModel: string; availableModels: string[]; topK: number; beta: number; centers: number[][]; rankings: Record<number, { ranking: string[]; scores?: Record<string, number> }> }`
  - `export interface EmbedQuery { (text: string): Promise<number[]> }`
  - `export function loadAvengersProArtifacts(dir: string): AvengersProArtifacts`
  - `export function l2Normalize(vec: number[]): number[]`
  - `export function scoreAvengersPro(embedding: number[], artifacts: AvengersProArtifacts): { paperIds: string[]; scores: Record<string, number> }`
  - `export async function rankAvengersPro(text: string, artifacts: AvengersProArtifacts, embed: EmbedQuery): Promise<{ paperIds: string[]; scores: Record<string, number> }>`

- [ ] **Step 1: Write the failing test**

Create `packages/router-core/tests/avengers-pro.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { l2Normalize, loadAvengersProArtifacts, rankAvengersPro, scoreAvengersPro } from "../src/avengers-pro.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/avengers-pro/fixture");

describe("avengers-pro inference", () => {
  it("ranks the nearest cluster's top paper model first", async () => {
    const artifacts = loadAvengersProArtifacts(fixtureDir);
    const result = await rankAvengersPro("write a cheap unit test", artifacts, async () => [1, 0]);
    expect(result.paperIds[0]).toBe("qwen/qwen3");
  });

  it("aggregates topK clusters by softmax(-beta * distance)", () => {
    const artifacts = loadAvengersProArtifacts(fixtureDir);
    const scored = scoreAvengersPro(l2Normalize([0.7, 0.7]), { ...artifacts, topK: 2, beta: 9 });
    expect(scored.paperIds.length).toBeGreaterThan(1);
    expect(new Set(scored.paperIds)).toEqual(new Set(["qwen/qwen3", "openai/gpt-5-medium"]));
  });
});
```

Create the fixture files with two orthogonal centers so `[1,0]` is cluster 0 (Qwen) and `[0,1]` is cluster 1 (GPT-5):

`metadata.json`:
```json
{ "n_clusters": 2, "embedding_model": "fixture", "available_models": ["qwen/qwen3", "openai/gpt-5-medium"], "top_k": 1, "beta": 9 }
```

`cluster_centers.json`:
```json
[[1, 0], [0, 1]]
```

`cluster_rankings.json`:
```json
{
  "0": { "ranking": ["qwen/qwen3", "openai/gpt-5-medium"], "scores": { "qwen/qwen3": 0.9, "openai/gpt-5-medium": 0.4 } },
  "1": { "ranking": ["openai/gpt-5-medium", "qwen/qwen3"], "scores": { "openai/gpt-5-medium": 0.95, "qwen/qwen3": 0.3 } }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@auto-router/router-core -- tests/avengers-pro.test.ts`
Expected: FAIL because `../src/avengers-pro.js` cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

In `avengers-pro.ts`:
- `loadAvengersProArtifacts` reads the three JSON files from `dir`.
- `l2Normalize` divides by the L2 norm (return zeros unchanged).
- Cosine/inner-product distance after L2: `distance = 1 - dot(embedding, center)`.
- `scoreAvengersPro` takes `topK` nearest centers, softmax `-beta * distance`, and accumulates `prob * 1/(rank+1)` per paper ID.
- `rankAvengersPro` L2-normalizes the embedder output, then scores.

Do not call a network embedder in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@auto-router/router-core -- tests/avengers-pro.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/router-core/src/avengers-pro.ts packages/router-core/src/types.ts packages/router-core/src/index.ts packages/router-core/artifacts/avengers-pro/fixture packages/router-core/tests/avengers-pro.test.ts
git commit -m "Add Avengers-Pro inference over committed cluster fixtures."
```

---

### Task 2: Bench vs hand model map

**Files:**
- Create: `packages/router-core/src/model-map.ts`
- Create: `packages/router-core/tests/model-map.test.ts`
- Modify: `packages/router-core/src/types.ts`
- Modify: `packages/router-core/src/index.ts`

**Interfaces:**
- Consumes: `Catalog` from `types.ts`
- Produces:
  - `export type ModelMapSource = "bench" | "hand"`
  - `export interface ModelMapEntry { runtimeId: string; source: ModelMapSource }`
  - `export type ModelMap = Record<string, ModelMapEntry[]>`
  - `export function resolveMappedModels(paperIds: string[], modelMap: ModelMap, catalog: Catalog): { runtimeId: string; paperId: string; source: ModelMapSource }[]`

Add to `types.ts`:

```ts
export type ModelMapSource = "bench" | "hand";
export interface ModelMapEntry { runtimeId: string; source: ModelMapSource }
export type ModelMap = Record<string, ModelMapEntry[]>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveMappedModels } from "../src/model-map.js";
import type { Catalog } from "../src/types.js";

const catalog: Catalog = {
  fetchedAt: "t",
  source: "live",
  models: [
    { id: "gpt-5.6-sol", runtimeId: "openai/gpt-5.6-sol", codingIndex: 92, blendedPrice: 12, value: 7.6, windowTokens: 272000, isFree: false },
    { id: "muse-spark-1.2-contributor-free", runtimeId: "opencode/muse-spark-1.2-contributor-free", codingIndex: 78, blendedPrice: 0, value: 780, windowTokens: 272000, isFree: true },
  ],
};

const modelMap = {
  "openai/gpt-5-medium": [
    { runtimeId: "openai/gpt-5.6-sol", source: "bench" as const },
    { runtimeId: "opencode/muse-spark-1.2-contributor-free", source: "hand" as const },
  ],
  "qwen/qwen3": [{ runtimeId: "opencode/muse-spark-1.2-contributor-free", source: "hand" as const }],
};

describe("model map", () => {
  it("prefers bench joins over hand aliases for the same paper id", () => {
    const resolved = resolveMappedModels(["openai/gpt-5-medium"], modelMap, catalog);
    expect(resolved[0]).toEqual({ runtimeId: "openai/gpt-5.6-sol", paperId: "openai/gpt-5-medium", source: "bench" });
  });

  it("skips missing runtime ids and continues down the paper ranking", () => {
    const resolved = resolveMappedModels(["missing/model", "qwen/qwen3"], modelMap, catalog);
    expect(resolved.map((r) => r.runtimeId)).toEqual(["opencode/muse-spark-1.2-contributor-free"]);
    expect(resolved[0].source).toBe("hand");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@auto-router/router-core -- tests/model-map.test.ts`
Expected: FAIL because `model-map.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

`resolveMappedModels`:
- For each `paperId` in order, read `modelMap[paperId] ?? []`.
- Sort that paper's entries so `source === "bench"` comes before `source === "hand"`.
- Keep an entry if `catalog.models` has `m.runtimeId === entry.runtimeId || m.id === entry.runtimeId`.
- Deduplicate runtime IDs.
- Return the kept list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@auto-router/router-core -- tests/model-map.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/router-core/src/model-map.ts packages/router-core/src/types.ts packages/router-core/src/index.ts packages/router-core/tests/model-map.test.ts
git commit -m "Resolve Avengers-Pro paper ids through bench-first model maps."
```

---

### Task 3: Config defaults and selector overlay

**Files:**
- Modify: `packages/router-core/src/types.ts`
- Modify: `packages/router-core/src/config.ts`
- Modify: `packages/router-core/src/selector.ts`
- Modify: `packages/router-core/tests/selector.test.ts`
- Modify: `auto-router.json`

**Interfaces:**
- Consumes: `rankAvengersPro`, `loadAvengersProArtifacts`, `resolveMappedModels`
- Produces: `selectModel` may return `via: "avengers-pro"`. New optional `selectModel` argument:

```ts
export interface SelectModelOptions {
  avengersRanker?: (text: string) => Promise<{ paperIds: string[]; scores: Record<string, number> }> | { paperIds: string[]; scores: Record<string, number> };
}
```

Because current `selectModel` is sync, **keep it sync**. The ranker passed from tests/proxy must be precomputed or sync. Signature:

```ts
export function selectModel(
  session: SessionState,
  catalog: Catalog,
  config: RouterConfig,
  state: RouterState,
  prevAgent?: string,
  prevMessage?: string,
  avengers?: { paperIds: string[] }
): SelectionResult
```

Add to `SelectionResult["via"]`: `"avengers-pro"`.

Add to `RouterConfig`:

```ts
avengersPro?: {
  enabled: boolean;
  artifactDir: string;
  embedding?: { baseUrl: string; apiKeyEnv: string; model: string };
  topK?: number;
  beta?: number;
  timeoutMs?: number;
};
modelMap?: ModelMap;
```

Default in `DEFAULT_CONFIG`:

```ts
avengersPro: { enabled: false, artifactDir: "./packages/router-core/artifacts/avengers-pro/fixture", topK: 3, beta: 9, timeoutMs: 400 },
modelMap: {},
```

`auto-router.json` enables the fixture and ships the first map:

```json
"avengersPro": { "enabled": true, "artifactDir": "./packages/router-core/artifacts/avengers-pro/fixture", "topK": 3, "beta": 9, "timeoutMs": 400 },
"modelMap": {
  "openai/gpt-5-medium": [{ "runtimeId": "openai/gpt-5.6-sol", "source": "bench" }],
  "qwen/qwen3": [{ "runtimeId": "opencode/muse-spark-1.2-contributor-free", "source": "hand" }]
}
```

- [ ] **Step 1: Write the failing tests**

Add to `packages/router-core/tests/selector.test.ts`:

```ts
it("uses the first mapped Avengers-Pro paper id on a new task", () => {
  const r = selectModel(
    sess({ lastUserMessage: "implement the feature", isNewSession: true }),
    catalog,
    { ...cfg, modelMap: { "qwen/qwen3": [{ runtimeId: "free-medium", source: "hand" }] } },
    { currentModel: null, currentTier: null, downgradeCounter: 0 },
    undefined,
    undefined,
    { paperIds: ["qwen/qwen3"] }
  );
  expect(r.modelId).toBe("free-medium");
  expect(r.via).toBe("avengers-pro");
});

it("planning overlay still rejects mapped models below quality 85", () => {
  const r = selectModel(
    sess({ lastUserMessage: "plan the architecture", userTag: "planning", forceTier: "simple", isNewSession: true }),
    catalog,
    { ...cfg, modelMap: { "qwen/qwen3": [{ runtimeId: "free-medium", source: "hand" }] } },
    { currentModel: null, currentTier: null, downgradeCounter: 0 },
    undefined,
    undefined,
    { paperIds: ["qwen/qwen3"] }
  );
  expect(r.modelId).toBe("frontier");
  expect(r.via).toBe("quality");
});

it("falls back to heuristic select when no paper id maps", () => {
  const r = selectModel(
    sess({ lastUserMessage: "hello", isNewSession: true }),
    catalog,
    cfg,
    { currentModel: null, currentTier: null, downgradeCounter: 0 },
    undefined,
    undefined,
    { paperIds: ["missing/model"] }
  );
  expect(r.via).not.toBe("avengers-pro");
});
```

In the planning test, `free-medium` is codingIndex 72, `frontier` is 92. Planning `minQuality` is 85, so Avengers-Pro's mapped Muse-like model must be dropped.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@auto-router/router-core -- tests/selector.test.ts`
Expected: FAIL on `r.via === "avengers-pro"` because `selectModel` ignores `paperIds`.

- [ ] **Step 3: Write minimal implementation**

In `selectModel`, after explicit `taskType-prefer` and before `bestModelForTier`:

```ts
if (!candidate && avengers?.paperIds?.length && config.modelMap) {
  const mapped = resolveMappedModels(avengers.paperIds, config.modelMap, catalog)
    .map((entry) => catalog.models.find((m) => (m.runtimeId ?? m.id) === entry.runtimeId || m.id === entry.runtimeId))
    .filter((m): m is ModelEntry => !!m && m.codingIndex >= minQuality);
  if (strategy === "lowest-cost") {
    const free = mapped.filter((m) => m.isFree);
    candidate = (free[0] ?? [...mapped].sort((a, b) => a.blendedPrice - b.blendedPrice)[0]) ?? null;
  } else if (strategy === "quality") {
    candidate = [...mapped].sort((a, b) => b.codingIndex - a.codingIndex)[0] ?? null;
  } else {
    candidate = mapped[0] ?? null;
  }
  if (candidate) {
    via = strategy === "value" || !taskPolicy?.strategy ? "avengers-pro" : (candidate.isFree && strategy !== "quality" ? "free-first" : strategy);
    reason = `avengers-pro mapped ${candidate.id}`;
  }
}
```

If `mapped` is empty, leave `candidate` null so existing `bestModelForTier` runs.

Existing stickiness / context-fit / prefer-tag behavior stays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@auto-router/router-core -- tests/selector.test.ts`
Expected: all selector tests PASS, including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/router-core/src/types.ts packages/router-core/src/config.ts packages/router-core/src/selector.ts packages/router-core/tests/selector.test.ts auto-router.json
git commit -m "Select mapped Avengers-Pro candidates on task boundaries."
```

---

### Task 4: OpenAI/Anthropic proxy with task lock

**Files:**
- Create: `packages/proxy/package.json`
- Create: `packages/proxy/tsconfig.json`
- Create: `packages/proxy/src/server.ts`
- Create: `packages/proxy/src/session.ts`
- Create: `packages/proxy/tests/server.test.ts`

**Interfaces:**
- Consumes: `selectModel`, `detectBoundary`, `loadConfig`, `loadCatalogSync` / a catalog passed in
- Produces:
  - `export interface ProxySessionStore { get(id: string): { taskTarget: string | null; prevMessage?: string }; set(id: string, next: { taskTarget: string | null; prevMessage?: string }): void }`
  - `export function createProxyServer(opts: { select: typeof selectModel; catalog: Catalog; config: RouterConfig; sessions: ProxySessionStore; backends: Record<string, { baseUrl: string; fetchImpl?: typeof fetch }>; rankAvengers?: (text: string) => { paperIds: string[] } }): { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): void }`

`packages/proxy/package.json`:

```json
{
  "name": "@auto-router/proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/src/server.js"
  },
  "dependencies": {
    "@auto-router/router-core": "*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.3",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 1: Write the failing tests**

`packages/proxy/tests/server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createProxyServer } from "../src/server.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

function fakeReq(url: string, body: unknown): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = url;
  req.headers = { "content-type": "application/json", "x-session-id": "ses_test" };
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

describe("proxy", () => {
  it("rewrites chat completions model to the task target and holds it on the second call", async () => {
    const outbound: Array<{ url: string; model: string }> = [];
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: {
        openai: {
          baseUrl: "http://backend.test",
          fetchImpl: async (url, init) => {
            const parsed = JSON.parse(String(init?.body));
            outbound.push({ url: String(url), model: parsed.model });
            return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
          },
        },
      },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });

    const body = { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "implement the feature" }] };
    const res1 = collectRes();
    const res2 = collectRes();
    await server.handle(fakeReq("/v1/chat/completions", body), res1);
    await server.handle(fakeReq("/v1/chat/completions", { ...body, messages: [{ role: "user", content: "continue" }] }), res2);

    expect(outbound[0].model).toBe("opencode/muse-spark-1.2-contributor-free");
    expect(outbound[1].model).toBe(outbound[0].model);
    expect(rankCalls).toBe(1);
  });

  it("returns a route decision without calling a backend", async () => {
    let backendCalls = 0;
    const server = createProxyServer({
      catalog,
      config,
      sessions: memorySessions(),
      backends: { openai: { baseUrl: "http://backend.test", fetchImpl: async () => { backendCalls += 1; return new Response("{}"); } } },
      rankAvengers: () => ({ paperIds: ["qwen/qwen3"] }),
      select: selectModel,
    });
    const res = collectRes();
    await server.handle(fakeReq("/v1/route", { model: "openai/gpt-5.6-luna", messages: [{ role: "user", content: "implement the feature" }] }), res);
    expect(backendCalls).toBe(0);
    expect(JSON.parse(res.body).modelId).toBe("opencode/muse-spark-1.2-contributor-free");
  });
});
```

`collectRes()` is a `ServerResponse` double that records `statusCode` and `body`. Use the Task 2 catalog/config/`modelMap` so `qwen/qwen3` maps to Muse. `rankCalls` increments inside `rankAvengers`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@auto-router/proxy -- tests/server.test.ts`
Expected: FAIL because the package/module does not exist.

- [ ] **Step 3: Write minimal implementation**

`session.ts`: in-memory map keyed by `x-session-id` or `x-opencode-session` or a hash of the first user text.

`server.ts`:
- Parse JSON body.
- Extract last user text from OpenAI `messages` or Anthropic `messages`.
- If the session already has `taskTarget` and `detectBoundary` is false, reuse it.
- Else call `rankAvengers?.(text)` (sync in tests), then `selectModel(..., avengers)`.
- Store `taskTarget = result.modelId`.
- Split `provider/model` from the target. Look up `backends[provider]`. Default provider `openai` if the id has no slash.
- Forward method/path/body with `model` replaced by the target (or the bare model id if the backend wants it). Copy streaming headers through.
- `/health` returns `{"ok":true}`.
- On embed/select throw, use heuristic `selectModel` without `avengers`.
- Listen only when `import.meta.url === pathToFileURL(process.argv[1]).href`. Tests use `handle` directly.

Do not implement Gemini. Do not retry a different model on upstream error.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@auto-router/proxy -- tests/server.test.ts && npm test --workspace=@auto-router/router-core`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/proxy package.json
git commit -m "Add a local proxy that applies the task-locked Avengers-Pro target."
```

---

### Task 5: Docs and apply-path status

**Files:**
- Modify: `PLAN.md`
- Modify: `design.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: behavior from Tasks 1–4
- Produces: docs that say the proxy is the apply path and the plugin is observational

- [ ] **Step 1: Update the three docs**

`README.md`: add a "Apply path" section — run `npm start --workspace=@auto-router/proxy`, point OpenCode / Claude / Codex at `http://127.0.0.1:8787`. State that the plugin still cannot change OpenCode's model.

`design.md`: replace "upstream routing hook is required for automatic application" with "the local proxy applies the target; the OpenCode hook remains out of scope while assigned."

`PLAN.md`: mark proxy + Avengers-Pro inference as the next shipped apply path. Record the bench/hand map decision.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all workspaces PASS

- [ ] **Step 3: Commit**

```bash
git add PLAN.md design.md README.md
git commit -m "Document the proxy as the apply path for Avengers-Pro routing."
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Avengers-Pro inference in TS, no Python | Task 1 |
| Fixture artifacts | Task 1 |
| Bench-first / hand-second model map | Task 2 |
| `selectModel` consumes ranked paper IDs | Task 3 |
| Planning quality 85 overlay | Task 3 |
| Heuristic fallback when nothing maps | Task 3 |
| Local OpenAI + Anthropic proxy | Task 4 |
| Task lock / no re-score mid-task | Task 4 |
| `/v1/route`, `/health` | Task 4 |
| No OpenCode hook work | all tasks |
| Docs | Task 5 |

Not in this plan (spec says later): rebuilding clusters from full LLMRouterBench dumps; Gemini native; live embedding provider wiring beyond config fields; session-log replacement of hand maps.
