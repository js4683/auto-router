# auto-router

A lightweight, agent-loop-aware model router for opencode (and any harness). Selects
one model per task/theme based on **task complexity and task type**, while treating
**context preservation** and **prompt-cache stickiness** as first-class concerns.

## Thesis

Prior art exists but none fits this goal:

| Tool | What it does | Why not this |
|------|--------------|--------------|
| RouteLLM (LMSYS) | OpenAI drop-in, strong/weak binary router | Single-prompt, not agent-loop aware, no context-preservation logic |
| OpenRouter auto | Market-spend model pick, cloud | Not local, not harness-integrated, opaque |
| Not-Diamond / RoRF | Random-forest router across model pairs | A library, not a harness integration |

**The gap:** an *agent-loop-aware, local, harness-integrated* router that classifies on
**whole-session state** (diff size, files touched, tool-call depth) — not just the
single prompt — and guards **context-window fit + prompt-cache stickiness**, which none
of the above do.

## Locked decisions

1. **Language:** TypeScript for `router-core` + the opencode plugin (native plugin
   language, richest session signals). Revisit Go later for the standalone proxy.
2. **Classifier:** Tier-0 heuristic `selectModel` remains the default. The fixture-backed
   Avengers-Pro scorer is an opt-in Tier-1 reranker that fails open to Tier 0. Overlap
   models join through LLMRouterBench; Muse/Grok/Luna use an explicit hand map until we
   have our own labels.
3. **Apply paths:** the OpenCode plugin applies connected-provider targets natively at
   task boundaries. The local OpenAI/Anthropic proxy remains available for other
   harnesses that cannot load the plugin.
4. **Model selection data:** Artificial Analysis free API for quality (coding index)
   + price -> a "bang-for-buck" score per model, refreshed daily and cached.
5. **Free-first:** within the tier a task needs, prefer models that are free *to the
   user* (local / provider free tier); verification work falls back to the lowest
   blended-cost eligible model.
6. **Two routing axes:** complexity tier (how hard, from AA data) *and* task type
   (what kind — review / verification / monitoring / planning / implement / debug).
7. **High-capability planning:** planning and architecture tasks require a quality floor
   and quality-first selection, favoring connected Sol, Fable, or Opus-class models.
8. **Routing trigger:** switch on *confident task boundaries*, not every turn and not
   every session. Model names are never hardcoded — catalog + free-set + task policy drive
   selection, so the router survives model churn.

## Apply path

For OpenCode 1.18.27, load `.opencode/plugins/auto-router.ts` and connect providers
with `/connect`. The plugin selects only from the live connected catalog, writes the
chosen provider/model to the pending user message before OpenCode resolves auth, and
holds that target until a confirmed task boundary. No router API key or proxy is
required.

The routed model is request-scoped: the TUI picker remains the user's default. A toast
announces boundary switches that change the model, and
`~/.cache/auto-router-decisions.log` records selection and confirmation without prompt
or credential content.

### Other harnesses

For harnesses that cannot load the plugin, run the local proxy and point the harness at
it:

```bash
export OPENCODE_API_KEY="..."
export GEMINI_API_KEY="..."
npm start --workspace=@auto-router/proxy
```

Set the matching API-key environment variable for every provider the router may
select (`OPENAI_API_KEY`, `OPENCODE_API_KEY`, `GEMINI_API_KEY`, or
`ANTHROPIC_API_KEY`).

Default listen address is `http://127.0.0.1:8787`.

- Other OpenAI Chat Completions clients can use `http://127.0.0.1:8787/v1`.
- Claude Code can use `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
- Codex can use `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`.

The proxy accepts OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses
requests. It translates text and function calls across Zen's Responses API and
Gemini's `generateContent` API, including client-compatible streaming envelopes.
Gemini chat completions and native OpenAI Responses streams are forwarded
incrementally as upstream chunks arrive. Cross-protocol paths without an incremental
translator request buffered upstream JSON, then synthesize a client-compatible event
stream instead of attempting to parse upstream SSE as JSON.

When enabled, the proxy scores the first message of a task with a validated Avengers-Pro
artifact, applies free-first / planning-quality overlays, then holds that target until a
confirmed boundary. The checked-in synthetic fixture is for scoring and tests only; production
activation requires a validated non-synthetic artifact. The checked-in configuration leaves
this Tier-1 path disabled by default; failures fall back to Tier 0. Routing state is
reconstructed conservatively from normalized messages, tool schemas, and tool-call history so
context size, tool depth, file/patch hints, and prior tool errors inform selection when the
request exposes them.

## Evaluation

Run the required deterministic replay without provider credentials:

```bash
npm run eval -- replay \
  --dataset packages/eval/fixtures/phase-3-smoke.v1.json \
  --output phase-3.eval-report.local
```

The report compares `router`, `always-frontier`, and `always-cheap` against the same
frozen catalog, prices, capabilities, and context constraints. JSON and Markdown output
exclude recorded prompts and model responses.

Live generation and blinded judging are optional and billable. Update the dataset's
`liveModelAliases`, then explicitly confirm the run:

```bash
export AUTO_ROUTER_EVAL_BASE_URL="https://openrouter.ai/api/v1"
export AUTO_ROUTER_EVAL_API_KEY="..."
export AUTO_ROUTER_EVAL_JUDGE_MODEL="provider/judge-model"
npm run eval -- live \
  --dataset path/to/live-dataset.json \
  --output phase-3-live.eval-report.local \
  --confirm-live
```

Optional live limits are `AUTO_ROUTER_EVAL_TIMEOUT_MS` and
`AUTO_ROUTER_EVAL_MAX_OUTPUT_TOKENS`. The CLI prints planned generation and judge call
counts before execution. Do not claim quality retention from offline catalog proxies.
The benchmark gate requires at least 30 complete live cases, 95% router quality
retention, 50% estimated cost savings, and a seeded bootstrap interval.
Replay reports expose recorded terminal state and truncation; incomplete records fail
the completeness gate and cannot support cost or quality comparisons.

### Recording and curation

Proxy recording is off by default. `metadata` excludes request and response content;
`content` adds bounded, automatically redacted content and therefore requires explicit
opt-in:

```bash
AUTO_ROUTER_EVAL_RECORD_MODE=metadata npm start --workspace=@auto-router/proxy
AUTO_ROUTER_EVAL_RECORD_MODE=content npm start --workspace=@auto-router/proxy
```

Records default to the ignored `.eval-recordings/` directory with `0600` file
permissions and 30-day retention. Override these with
`AUTO_ROUTER_EVAL_RECORD_DIR` and `AUTO_ROUTER_EVAL_RETENTION_DAYS`.
Persisted session and turn IDs are opaque process-local digests, including when callers
provide IDs or omit them. Metadata mode retains routing numbers and a fixed prompt
placeholder, never raw prompt text.
Proxy-derived token usage is labeled `estimated`; only usage explicitly labeled
`provider` contributes to the report's separate provider-observed cost.

Curate JSON Lines into a validated dataset using an existing dataset as the frozen
catalog, policy, price, and capability base:

```bash
npm run eval -- curate \
  --input .eval-recordings/auto-router-eval-<timestamp>.jsonl \
  --base-dataset packages/eval/fixtures/phase-3-smoke.v1.json \
  --output curated.eval-dataset.local.json
```

Automatic redaction cannot guarantee anonymity. Manually review every curated file for
credentials, personal data, and proprietary content before committing it.

## Phase 4 embedding classifier

Tier 1 stays disabled by default. Rollback is `avengersPro.enabled: false`.
Networked commands require `--confirm-live` and print planned billable calls first.
Collection uses `AUTO_ROUTER_EVAL_BASE_URL`, `AUTO_ROUTER_EVAL_API_KEY`, and
`AUTO_ROUTER_EVAL_JUDGE_MODEL`. Training and validation use
`AUTO_ROUTER_EMBEDDING_BASE_URL`, `AUTO_ROUTER_EMBEDDING_API_KEY`, and
`AUTO_ROUTER_EMBEDDING_MODEL`. Artifacts store aggregate centers and stats only.
Local collection, corpus, cache, and validation files stay ignored, mode `0600`,
and need manual review before any commit.

```bash
npm run eval -- collect-avengers --dataset path/to/reviewed-dataset.json --models paper/a=provider/a,paper/b=provider/b --output phase-4-collection.local.jsonl --confirm-live
npm run eval -- curate-avengers --input phase-4-collection.local.jsonl --dataset path/to/reviewed-dataset.json --models paper/a=provider/a,paper/b=provider/b --output phase-4-corpus.local.json
npm run eval -- train-avengers --corpus phase-4-corpus.local.json --artifact-dir path/to/artifact --cache phase-4-embeddings.local.json --clusters 8 --seed 4683 --held-out-ratio 0.2 --top-k 3 --beta 9 --min-observations 3 --max-input-chars 16000 --timeout-ms 400 --confirm-live
npm run eval -- validate-avengers --corpus phase-4-corpus.local.json --artifact-dir path/to/artifact --output phase-4-validation.local --bootstrap-seed fixture-seed --timeout-ms 400 --confirm-live
```

## Docs

| Doc | Purpose |
|-----|---------|
| [PLAN.md](./PLAN.md) | Canonical scope, implementation status, acceptance criteria, and decision log |
| [design.md](./design.md) | Architecture, the two hard problems, classification tiers |
| [roadmap.md](./roadmap.md) | Phased plan, effort, checklist |
| [Phase 3 eval design](./docs/plans/2026-08-31-phase-3-eval-harness-design.md) | Accepted offline/live evaluation, recording, metrics, and trust-boundary design |
| [Phase 4 embedding classifier design](./docs/plans/2026-09-01-phase-4-embedding-classifier-design.md) | Approved Tier-1 architecture, privacy boundaries, and activation gates |

## Why this is a strong fit

Same shape as the Atlassian platform work: a **decision system on a hot path with a
measurement loop**. Route decision = escalate/approve risk engine. Eval harness =
backtest. Stickiness + context-fit guards = the operational judgment that separates a
demo from something that survives production.
