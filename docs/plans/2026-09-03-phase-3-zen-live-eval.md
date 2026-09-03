# Phase 3 Zen Live Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Zen Responses transport to `packages/eval` live mode, author a local 30-turn Muse/Sol dataset, and enable one confirmed Zen live run.

**Architecture:** Keep chat-completions as the default live client. Add a thin Responses POST to `{baseUrl}/responses` selected by `liveTransportDefault` and per-runtime `liveTransports`. Do not import `packages/proxy`. Judge uses the dataset default transport.

**Tech Stack:** TypeScript, Vitest, native `fetch`, OpenCode Zen (`https://opencode.ai/zen/v1`)

**Spec:** `docs/plans/2026-09-03-phase-3-zen-live-eval-design.md`

## Global Constraints

- `schemaVersion` stays 1.
- Missing transport keys default to `chat`.
- Timed-out billable calls are never retried.
- Unit tests and CI never call Zen.
- Dataset prompts and live reports stay local `0600` and gitignored (`*.eval-dataset.local.json`, `*.eval-report.local.json`).
- Phase 4 corpus/train/activate is out of scope.
- Do not import `@auto-router/proxy` from eval.

---

### Task 1: Dataset transport fields

**Files:**
- Modify: `packages/eval/src/types.ts`
- Modify: `packages/eval/src/schema.ts`
- Test: `packages/eval/tests/schema.test.ts`

**Interfaces:**
- Consumes: existing `EvalDatasetV1`
- Produces: `LiveTransport = "chat" | "responses"`; `EvalDatasetV1.liveTransportDefault?: LiveTransport`; `EvalDatasetV1.liveTransports?: Record<string, LiveTransport>`

- [ ] **Step 1: Write the failing tests**

Add to `packages/eval/tests/schema.test.ts`:

```ts
it("accepts liveTransportDefault and liveTransports", () => {
  const dataset = {
    ...validDataset(),
    liveTransportDefault: "responses",
    liveTransports: { "provider/cheap": "chat" },
  };
  expect(parseDataset(dataset).liveTransportDefault).toBe("responses");
  expect(parseDataset(dataset).liveTransports).toEqual({ "provider/cheap": "chat" });
});

it("rejects invalid live transports", () => {
  expect(() => parseDataset({ ...validDataset(), liveTransportDefault: "sse" })).toThrow("liveTransportDefault");
  expect(() => parseDataset({ ...validDataset(), liveTransports: { "provider/cheap": "sse" } })).toThrow("liveTransports.provider/cheap");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@auto-router/eval -- tests/schema.test.ts`

Expected: FAIL — unknown fields ignored or types missing; invalid `sse` not rejected.

- [ ] **Step 3: Write minimal implementation**

In `types.ts` add:

```ts
export type LiveTransport = "chat" | "responses";
```

On `EvalDatasetV1`:

```ts
liveTransportDefault?: LiveTransport;
liveTransports?: Record<string, LiveTransport>;
```

In `schema.ts` `parseDataset`, after `liveModelAliases` validation:

```ts
function liveTransport(value: unknown, label: string): "chat" | "responses" {
  if (value !== "chat" && value !== "responses") throw new Error(`${label} must be chat or responses`);
  return value;
}

if (dataset.liveTransportDefault !== undefined) {
  liveTransport(dataset.liveTransportDefault, "liveTransportDefault");
}
if (dataset.liveTransports !== undefined) {
  for (const [key, value] of Object.entries(record(dataset.liveTransports, "liveTransports"))) {
    string(key, "liveTransports key");
    liveTransport(value, `liveTransports.${key}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@auto-router/eval -- tests/schema.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/types.ts packages/eval/src/schema.ts packages/eval/tests/schema.test.ts
git commit -m "feat(eval): accept live transport fields"
```

---

### Task 2: Responses request and parse

**Files:**
- Modify: `packages/eval/src/live.ts`
- Test: `packages/eval/tests/live.test.ts`

**Interfaces:**
- Consumes: `CompletionRequest`, `LiveClientConfig`, `LiveOutput`
- Produces: `liveTransportFor(dataset, runtimeId?: string): LiveTransport`; `requestCompletion(..., transport?: LiveTransport)` posts to `/chat/completions` or `/responses`

- [ ] **Step 1: Write the failing tests**

In `packages/eval/tests/live.test.ts` (create if the existing file only covers other helpers; otherwise append):

```ts
it("posts chat completions by default", async () => {
  let url = "";
  let body: any;
  await requestCompletion(
    { model: "live/cheap", messages: [{ role: "user", content: "hi" }] },
    { baseUrl: "https://example.com/v1", apiKey: "secret", timeoutMs: 1000, maxOutputTokens: 64 },
    async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  );
  expect(url).toBe("https://example.com/v1/chat/completions");
  expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
});

it("posts responses and maps output_text plus usage", async () => {
  let url = "";
  let body: any;
  const output = await requestCompletion(
    { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], temperature: 0, responseFormat: { type: "json_object" } },
    { baseUrl: "https://opencode.ai/zen/v1", apiKey: "secret", timeoutMs: 1000, maxOutputTokens: 64 },
    async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        status: "completed",
        output_text: "{\"ok\":true}",
        usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    "responses"
  );
  expect(url).toBe("https://opencode.ai/zen/v1/responses");
  expect(body.model).toBe("gpt-5.6-sol");
  expect(body.input).toEqual([{ role: "user", content: "hi" }]);
  expect(body.max_output_tokens).toBe(64);
  expect(body.text).toEqual({ format: { type: "json_object" } });
  expect(output).toMatchObject({
    text: "{\"ok\":true}",
    terminalState: "completed",
    usage: { inputTokens: 8, outputTokens: 2, cacheReadInputTokens: 1, cacheWriteInputTokens: 0 },
  });
});

it("does not retry a responses timeout", async () => {
  let calls = 0;
  await expect(requestCompletion(
    { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] },
    { baseUrl: "https://opencode.ai/zen/v1", apiKey: "secret", timeoutMs: 5, maxOutputTokens: 16 },
    async () => {
      calls += 1;
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    },
    "responses"
  )).rejects.toThrow("provider request timed out");
  expect(calls).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@auto-router/eval -- tests/live.test.ts`

Expected: FAIL — `requestCompletion` has no transport argument and always hits `/chat/completions`.

- [ ] **Step 3: Write minimal implementation**

Add:

```ts
export type LiveTransport = "chat" | "responses"; // or import from types.ts — use the types.ts export only

export function liveTransportFor(dataset: EvalDatasetV1, runtimeId?: string): LiveTransport {
  if (runtimeId && dataset.liveTransports?.[runtimeId]) return dataset.liveTransports[runtimeId];
  return dataset.liveTransportDefault ?? "chat";
}
```

Import `LiveTransport` from `./types.js`. Do not duplicate the type.

Extend `endpoint(baseUrl, transport: LiveTransport = "chat")` so chat keeps `/chat/completions` and responses uses `/responses`. Reuse the existing HTTPS / no-credential URL checks.

Parse Responses JSON:

- Prefer `payload.output_text` when it is a string.
- Else concatenate `payload.output[]` message `content[]` items with `type === "output_text"` and string `text`.
- Terminal state from `payload.status` (`completed` / `failed` / `cancelled` / `incomplete`) via existing `outputTerminalState`.
- Usage from `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`. If usage is absent, omit it.

`requestCompletion` signature:

```ts
export async function requestCompletion(
  request: CompletionRequest,
  config: LiveClientConfig,
  fetchImpl: typeof fetch = fetch,
  transport: LiveTransport = "chat"
): Promise<LiveOutput>
```

When `transport === "responses"`, POST:

```ts
{
  model: request.model,
  input: request.messages,
  max_output_tokens: config.maxOutputTokens,
  stream: false,
  ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  ...(request.responseFormat?.type === "json_object" ? { text: { format: { type: "json_object" } } } : {}),
}
```

Keep chat body unchanged. Timeout / HTTP / bounded-read behavior stays the same. No retries.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@auto-router/eval -- tests/live.test.ts`

Expected: PASS. Also run `npm test --workspace=@auto-router/eval -- tests/live-eval.test.ts` and expect existing chat tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/live.ts packages/eval/tests/live.test.ts
git commit -m "feat(eval): request OpenAI Responses for live transport"
```

---

### Task 3: Use transport in generation and judging

**Files:**
- Modify: `packages/eval/src/live.ts`
- Test: `packages/eval/tests/live-eval.test.ts`

**Interfaces:**
- Consumes: `liveTransportFor`, `requestCompletion(..., transport)`
- Produces: generation uses per-runtime transport; judge uses `liveTransportFor(dataset)` with no runtime id

- [ ] **Step 1: Write the failing test**

In `packages/eval/tests/live-eval.test.ts`:

```ts
it("uses responses for default transport and chat for an override", async () => {
  const dataset = liveFixture();
  dataset.liveTransportDefault = "responses";
  dataset.liveTransports = { "provider/cheap": "chat" };
  const replay = replayDataset(dataset);
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    urls.push(String(input));
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("/responses")) {
      if (body.model === "live/judge") {
        const request = JSON.parse(body.input[1].content);
        const scores = Object.fromEntries(request.responses.map((item: any) => [item.label, 80]));
        return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ scores }) }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output_text: `${body.model}-answer`,
        usage: { input_tokens: 100, output_tokens: 20 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `${body.model}-answer` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }), { status: 200 });
  };
  const result = await runLiveEvaluation(dataset, replay, config, fetchImpl);
  expect(result.cases[0]?.complete).toBe(true);
  expect(urls.filter((url) => url.endsWith("/chat/completions")).length).toBeGreaterThan(0);
  expect(urls.filter((url) => url.endsWith("/responses")).length).toBeGreaterThan(0);
});
```

`liveFixture()` currently aliases cheap and frontier only. Cheap override must match the catalog runtime id actually selected as always-cheap (`provider/cheap`). Judge and frontier should hit `/responses`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@auto-router/eval -- tests/live-eval.test.ts`

Expected: FAIL — `generateCase` / `judgeLabeledOutputs` still always chat.

- [ ] **Step 3: Write minimal implementation**

`generateCase` request:

```ts
requestCompletion(
  { model: dataset.liveModelAliases![selections[strategy].modelId], messages: turn.messages! },
  config,
  fetchImpl,
  liveTransportFor(dataset, selections[strategy].modelId)
)
```

Thread transport into `judgeLabeledOutputs` / `judgeOutputs`:

```ts
export async function judgeOutputs(
  input: JudgeCaseInput,
  outputs: Record<StrategyName, LiveOutput>,
  config: JudgeClientConfig,
  fetchImpl: typeof fetch = fetch,
  transport: LiveTransport = "chat"
)
```

`judgeLabeledOutputs` passes `transport` to `requestCompletion`.

`generateCase` calls `judgeOutputs(..., liveTransportFor(dataset))`.

Do not change planned call counts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@auto-router/eval`

Expected: all eval tests PASS, including the new mixed-transport case.

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/live.ts packages/eval/tests/live-eval.test.ts
git commit -m "feat(eval): honor live transports in generation and judging"
```

---

### Task 4: Local 30-turn dataset, docs, and live runbook

**Files:**
- Create locally (do not `git add`): `phase-3-zen-live.eval-dataset.local.json` at repo root (already gitignored)
- Modify: `PLAN.md` (pointer + deferred Phase 4)
- Modify: `docs/plans/2026-09-03-phase-3-zen-live-eval-design.md` implementation status after the run

**Interfaces:**
- Consumes: Task 1 fields, existing dataset schema, router task policies
- Produces: ignored local dataset with 30 complete turns; docs for how to run live eval

- [ ] **Step 1: Author the local dataset**

Create `phase-3-zen-live.eval-dataset.local.json` with:

- `schemaVersion: 1`
- `id: "phase-3-zen-live"`
- Catalog models:
  - `id`/`runtimeId` `opencode/muse-spark-1.3-contributor-free`, `codingIndex` 65, `blendedPrice` 0, `isFree` true, `windowTokens` 1048576
  - `id`/`runtimeId` `opencode/gpt-5.6-sol`, `codingIndex` 95, `blendedPrice` 6, `isFree` false, `windowTokens` 272000
- `prices`: Muse all zeros; Sol `inputPerMillion: 2`, `outputPerMillion: 10`, `cacheReadPerMillion: 0.2`, `cacheWritePerMillion: 2.5`
- Config: existing planning `minQuality` 85 and verification `lowest-cost`
- `liveModelAliases`:
  - `opencode/muse-spark-1.3-contributor-free` → `muse-spark-1.3-contributor-free`
  - `opencode/gpt-5.6-sol` → `gpt-5.6-sol`
- `liveTransportDefault`: `"responses"`
- 10 sessions of 1 verification turn, 10 sessions of 1 planning turn, 10 sessions whose second turn is a sticky follow-up (30 turns total). Each turn has `messages`, `judgeRubric`, `terminalState: "completed"`, and non-secret coding prompts only.
- Sticky follow-ups: `prevMessage` is the first-turn user text; no `[task:]` tag; wording like "report the failures" / "keep going on that plan".

Then:

```bash
npm run eval -- replay --dataset phase-3-zen-live.eval-dataset.local.json
```

Expected: complete offline replay for router, always-frontier, and always-cheap. Planning turns select Sol; verification turns select Muse.

- [ ] **Step 2: Document the live run**

In `PLAN.md` verification record add that Zen live eval is implemented and requires `--confirm-live`; Phase 4 corpus remains deferred. Do not paste prompts or API keys.

- [ ] **Step 3: Run unit tests and build**

Run:

```bash
npm test --workspace=@auto-router/eval
npm run build --workspace=@auto-router/eval
```

Expected: PASS

- [ ] **Step 4: Confirmed live run (needs Zen key)**

```bash
AUTO_ROUTER_EVAL_BASE_URL=https://opencode.ai/zen/v1 \
AUTO_ROUTER_EVAL_API_KEY="$ZEN_KEY" \
AUTO_ROUTER_EVAL_JUDGE_MODEL=gpt-5.6-luna \
npm run eval -- live --dataset phase-3-zen-live.eval-dataset.local.json --confirm-live
```

Expected: stdout includes `planned calls: 90 generation, 30 judge`; writes gitignored `phase-3-zen-live.eval-dataset.local.json.live.eval-report.local.json`. If the 0.95/0.50 gates fail, record the actual numbers in `PLAN.md` without claiming they passed.

If no Zen key is available, stop after Step 3 and leave the live evidence unchecked.

- [ ] **Step 5: Commit docs only**

```bash
git add PLAN.md docs/plans/2026-09-03-phase-3-zen-live-eval-design.md
git commit -m "docs(eval): record Zen live eval runbook"
```

Do not add the local dataset or live report.

---

## Spec coverage

| Spec requirement | Task |
|------------------|------|
| `liveTransportDefault` / `liveTransports`, schema v1 | 1 |
| Responses client, no proxy import, no retry | 2 |
| Generation per-runtime transport; judge uses default | 3 |
| Mixed chat+responses test | 3 |
| 30-turn local dataset, Muse/Sol/Luna, planned 90+30 | 4 |
| Local 0600/gitignored reports; gates measured not required | 4 |
| Phase 4 deferred | 4 |

## Risks

| Risk | Mitigation |
|------|------------|
| Zen Responses JSON shape differs | Mock both `output_text` and `output[].content[]`; fix parser against one real error body without logging it |
| Always-cheap does not pick Muse | Dataset catalog has only Muse as free/lowest blended price |
| Always-frontier does not pick Sol | Sol has the only codingIndex ≥ 85 |
| Contributor-free training on prompts | Non-confidential tasks only |
