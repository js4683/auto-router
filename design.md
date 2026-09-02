# auto-router — Design

## Architecture: harness-agnostic core + thin adapters

```
        +-------------------------------------+
        |   router-core  (no harness deps)    |
        |   classify(session_state) -> tier   |
        |   tier + policy -> model choice     |
        |   context-fit + stickiness guards   |
        +-------------------------------------+
              ^                        ^
     +--------+--------+      +--------+---------+
     | opencode plugin |      | OpenAI-compatible|
     | (context hook)  |      | proxy (any harness
     |                 |      |  via base_url)   |
     +-----------------+      +------------------+
```

Two adapters deliver "opencode **or any harness**":

- **opencode plugin** — session signals and one-shot recommendations. It cannot change
  the outbound model while `llm.request.before` is assigned to someone else.
- **OpenAI/Anthropic proxy** — the apply path. Point OpenCode, Claude Code, Codex, or
  Cursor at `http://127.0.0.1:8787`. It accepts OpenAI Chat Completions, Anthropic
  Messages, and OpenAI Responses requests, selects the target `model`, and translates
  text and function calls across Zen's Responses API and Gemini's `generateContent` API,
  forwarding with each provider's backend key.

`router-core` has zero harness dependencies. Both adapters call the same
`classify()` + policy engine.

The proxy reconstructs a conservative `SessionState` from each normalized request. It
estimates context from messages and tool schemas, then derives tool depth, file hints,
patch hunks, and prior errors from tool-call history. Signals unavailable through the
wire protocol remain zero rather than being guessed.

---

## The two hard problems (the real differentiators)

### 1. "Without losing context"

Three sub-problems most routers ignore. The harness owns the message thread, so the
router chooses *which model should own the current task* — but changing that target is
not free:

- **Context-window fit** — never route to a cheaper model whose window cannot hold the
  current session. Guard: measure live token count; only downgrade if it fits with
  margin.
- **Prompt-cache destruction** — caches are model-specific. Flipping models every turn
  nukes the cache and can cost *more* than staying put. This is why naive routing loses
  in agent loops.
- **Coherence** — mid-task model swaps cause style/format discontinuity.

### 2. Routing trigger: confident task boundaries, not per-turn / per-session

The router does **not** switch every turn (thrashes the cache) or every session (too
coarse). It switches when it **confidently detects a new task**:

- **Task-boundary detection** — new user goal, topic shift, cleared/compacted context,
  a phase change (e.g. implementation -> review).
- **Confidence gate** — only re-route when boundary + tier/type classification clear a
  confidence threshold. Low confidence => stay on the current model (safe default,
  preserves cache).
- **Sticky within a task** — once chosen, hold the model for the whole sub-task.
- **Task-only switching** — hard signals and new complexity affect the next confirmed
  task boundary; they do not switch the model in the middle of the current task.
- **High-capability planning** — planning and architecture tasks use a quality floor and
  quality-first selection rather than the low-cost policy.

---

## Model catalog — bang-for-buck + free-first

Classification decides *how hard* the task is. The catalog decides *which model* wins
for that difficulty at the best value.

### Source: Artificial Analysis free API

```
GET https://artificialanalysis.ai/api/v2/data/llms/models
Header: x-api-key: <key>
```

- Free, **1,000 req/day**, attribution + response caching required (ToS).
- One call returns all models, so refresh **daily** into a cached catalog.
- Fields used:
  - `evaluations.artificial_analysis_coding_index`  (quality signal for a coding harness)
  - `pricing.price_1m_blended_3_to_1`, `price_1m_input_tokens`, `price_1m_output_tokens`
  - `median_output_tokens_per_second`, `median_time_to_first_token_seconds`

### Value score

```
value = coding_index / blended_price     // bang-for-buck, higher is better
```

Rank models by `value` within each complexity tier. Tie-break on speed / TTFT.

### Free-first selection

Complexity tier sets the **minimum quality bar** (min coding_index). Among models that
clear the bar:

1. Prefer models **free to the user** (see registry join below), highest quality first.
2. For verification work, if no free model is available, pick the lowest blended cost.
3. For planning and architecture, pick the highest-quality model above the task floor.
4. Otherwise pick highest `value` (bang-for-buck).
5. Apply capability + context-fit guards (below) before committing.

### Two gaps the AA API does not fill

| Gap | Why it matters | Source |
|-----|----------------|--------|
| No context-window sizes | Context-fit guard needs them | models.dev / provider registry |
| "Free" is not `price == 0` | AA reports list price, not what's free *to you* | provider config (local, OpenRouter `:free`) joined to AA quality |

So "free" is a **registry join**: `providerFreeSet` INTERSECT `AA quality data`, not a
price filter.

---

## Two routing axes

Selection is a function of **both** how hard the task is and **what kind** of task it
is. AA data drives Axis 1; user config drives Axis 2.

### Axis 1 — complexity (how hard)

Heuristics -> tier (`simple | medium | complex`) -> minimum quality bar (min
`coding_index`). Drives *how capable* a model must be. See classification below.

### Axis 2 — task type (what kind)

Some models are better at specific kinds of work (code review, running tests,
monitoring pipelines) regardless of raw index. AA's single `coding_index` cannot
express this, so Axis 2 is a **user-configurable map**:

```jsonc
"taskTypeModels": {
  "code_review":  { "prefer": "<model>" },
  "run_tests":    { "prefer": null, "strategy": "lowest-cost" },
  "monitoring":   { "prefer": "<model>" },
  "planning":     { "prefer": null, "strategy": "quality", "minQuality": 85 },
  "implement":    { "prefer": "<tier-default>" },
  "debug":        { "prefer": "<tier-default>" }
}
```

The user's empirical knowledge ("model X is great at reviews") is the input here — the
router does not try to derive it.

**v1 stance — task type is explicit where possible and narrowly inferred where safe.**
User tags and active-agent mappings remain highest priority. Clear verification language
(`run tests`, `no-mistakes`, lint, build, typecheck) is safe to infer because the policy
only reduces cost. Clear planning/architecture language is inferred into the
quality-first planning policy. Other signal-based task detection remains gated and
best-effort.

### Combining the axes

```
1. resolve task type (explicit or safe gated inference) + complexity tier (with confidence)
2. compute the effective quality floor from the tier and task policy
3. candidate = taskTypeModels[type].prefer, if set and it clears the effective quality bar
4. else apply the task strategy: free-first, lowest-cost, quality-first, or best value
5. apply guards: context-fit, capability, then commit at a task boundary (or keep current model)
```

Model names are never hardcoded in core — they come from the AA catalog + provider
free-set + this user map, so the router survives model churn without code changes.

---

## Complexity classification — tiered, start simple

Rule-based is the correct starting point (confirmed across RouteLLM / vLLM
semantic-router / production write-ups).

### Tier 0 — heuristics (ship first; deterministic, zero-cost, zero-latency)

Signals from whole-session state, not just the prompt:

- prompt token count + total session token count
- number of files in context
- diff / hunk size in the current turn
- tool-call depth (how deep the agent loop is)
- keyword signals:
  - up: `refactor`, `architecture`, `design`, `debug`, `why`, `race`, `concurrency`
  - down: `rename`, `typo`, `format`, `comment`, `bump version`

Map aggregate score -> tier -> model (via policy config). Planning and architecture
keywords additionally activate the planning quality floor so they cannot route to a
trivial-task model.

### Tier 1 — embedding similarity (approved, opt-in)

Use task-boundary embeddings and observed model outcomes to train deterministic clusters,
then constrained-rerank eligible models. The checked-in fixture-backed path remains
disabled by default and falls back to Tier 0. The full architecture, including the
held-out activation gate, is documented in the
[Phase 4 embedding classifier design](./docs/plans/2026-09-01-phase-4-embedding-classifier-design.md).

### Tier 2 — LLM judge (optional, later)

Tiny model rates difficulty 1-5. Adds a call; gate behind a flag.

---

## Policy config (sketch)

```jsonc
{
  "tiers": {
    "simple":  { "minQuality": 0 },
    "medium":  { "minQuality": 60 },
    "complex": { "minQuality": 80 }
  },
  "taskTypeModels": {
    "run_tests": { "prefer": null, "strategy": "lowest-cost" },
    "planning": { "prefer": null, "strategy": "quality", "minQuality": 85 }
  },
  "stickiness": { "downgradeAfter": 3, "upgradeImmediate": true },
  "guards": { "contextFitMarginTokens": 8000 }
}
```

## OpenCode integration boundary

OpenCode 1.18.25 exposes `chat.message` and `chat.params`, but `chat.params` only
supports generation options such as temperature and provider options. It does not expose
a supported provider/model mutation. The adapter therefore selects and locks a task
target, observes the model OpenCode actually runs, and writes one task-level
recommendation when they differ. Automatic task-level application can use the same
target state once an upstream `llm.request.before`-style hook exists.

## Decision log

- **2026-08-29:** Routing is task/theme scoped, not per-turn. A confirmed boundary starts
  one model decision; subsequent messages remain on that task target.
- **2026-08-29:** Tests, `no-mistakes`, lint, build, typecheck, validate, and verify use a
  free model first, then the lowest blended-cost eligible model.
- **2026-08-29:** Planning and architecture use a quality floor of 85 and quality-first
  ordering so high-class models such as Sol, Fable, or Opus win when connected.
- **2026-08-29:** Unsupported OpenCode model mutations are not attempted; task-level
  recommendations are logged until an upstream model-routing hook is available.

## Eval harness

`packages/eval` is a separate workspace over `router-core`. Its required offline mode
replays versioned datasets through the router and deterministic always-frontier and
always-cheap baselines. All strategies share one frozen catalog, price snapshot,
capability map, and context eligibility rules. Reports separate observed data from
counterfactual estimates and include cost, model switches, cache impact, completeness,
and deterministic routing evidence.

Opt-in live mode calls an OpenAI-compatible endpoint for all three strategies, applies
bounded deterministic checks, and uses seeded blinded response labels for a judge. Live
calls require `--confirm-live`, explicit environment credentials, request timeouts, and
output limits. Only complete live cases can establish quality retention; offline catalog
quality is a proxy and cannot satisfy the benchmark gate.

The proxy may emit local JSON Lines in disabled-by-default `metadata` or explicitly
enabled `content` mode. Headers and environment values are excluded, common credential
formats are redacted, writes are serialized with restrictive permissions, and old files
are pruned. Curation validates records into dataset shape but always requires manual
privacy review before commit. Proxy token counts remain explicitly estimated; reports
aggregate provider-observed usage separately.

The accepted design and exact gates are recorded in
[`docs/plans/2026-08-31-phase-3-eval-harness-design.md`](./docs/plans/2026-08-31-phase-3-eval-harness-design.md).
