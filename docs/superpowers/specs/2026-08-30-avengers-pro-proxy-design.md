# Avengers-Pro Scorer + Harness Proxy

Date: 2026-08-30
Status: draft for review
Repo: `js4683/auto-router`

## Problem

The OpenCode plugin can recommend a model but cannot change the outbound LLM request. `chat.params` only exposes temperature, top-p, top-k, max tokens, and options. Issue `anomalyco/opencode#45764` (`llm.request.before`) is assigned to someone else, so we will not implement or compete for that hook.

The current classifier is regex plus hardcoded name-to-quality scores. That is why most real sessions resolve to `taskType=none` and free-first Muse.

We need one control point that actually switches models for OpenCode, Claude Code, Codex, Cursor, and any other client that can set a base URL. The scorer for that control point should be Avengers-Pro, not name heuristics.

## Goals

- Switch the model for real, not just log `TASK RECOMMEND`.
- Score the first message of a task with Avengers-Pro cluster routing.
- Hold that model until a confirmed task boundary.
- Keep existing policy overlays: free-first for verification, quality-first for planning, context-fit, provider-qualified IDs.
- Work in front of OpenCode the same way it works in front of Claude/Codex: one local proxy.
- Keep provider keys on this machine. The proxy forwards to the user's existing backends.

## Non-goals

- Contributing `llm.request.before` to OpenCode while it is assigned.
- Forking or vendoring Workweave Router.
- Training a new Avengers-Pro cluster set from scratch in the first slice.
- Rewriting message arrays, tools, or vision payloads.
- Supporting Gemini native `/v1beta/models/:action` in the first slice.
- Making the OpenCode plugin apply model changes. The plugin stays observational.

## Architecture

```
OpenCode / Claude Code / Codex / Cursor
        │  OpenAI Chat Completions and/or Anthropic Messages
        ▼
local proxy  :8787
        │  one decision per task
        ├─ Avengers-Pro: embed query → nearest clusters → ranked models
        ├─ map paper model IDs onto the connected catalog
        ├─ apply task lock, free-first, planning floor, context-fit
        ▼
user backends (OpenCode Zen, OpenAI, Bedrock, OpenRouter, …)
```

`router-core` remains harness-agnostic. The proxy is a new thin adapter. The existing OpenCode plugin stays for session signals and logs; it is not the apply path.

## Avengers-Pro integration

Avengers-Pro ([ZhangYiqun018/AvengersPro](https://github.com/ZhangYiqun018/AvengersPro), MIT, arXiv:2508.12631) is a test-time router, not a server.

Training / offline:

1. Embed labeled queries.
2. K-means cluster the embeddings (default 32, paper explores 25–64).
3. Per cluster, rank models by accuracy, or by `performance_weight * norm(accuracy) + cost_sensitivity * (1 - norm(cost))`.

Inference:

1. Embed the query (`text-embedding-3-large` in their default config).
2. L2-normalize.
3. Take `top_k` nearest cluster centers (default 1; paper uses small k).
4. Softmax over `-beta * distance`.
5. Aggregate rank scores across those clusters.
6. Return the top model, or a ranked list.

We will port inference into TypeScript inside `router-core`. We will not ship their training scripts, sklearn, or Python runtime in the proxy path.

### Artifacts the scorer loads

A versioned directory, for example `packages/router-core/artifacts/avengers-pro/`:

- `cluster_centers.npy` or an equivalent JSON/float32 dump
- `normalizer` metadata (L2 only; no sklearn object required at runtime)
- `cluster_rankings.json` (`ranking`, `scores` or `balance_scores` per cluster)
- `metadata.json` (`n_clusters`, `embedding_model`, `available_models`, `top_k`, `beta`)

First slice uses published or exported Avengers-Pro artifacts if they can be redistributed under MIT. If binary artifacts cannot be committed cleanly, the repo stores JSON centers/rankings generated from their export and a documented fetch script.

### Embedding provider

The scorer needs an embedding endpoint compatible with OpenAI embeddings:

```
POST {baseUrl}/v1/embeddings
{ "model": "text-embedding-3-large", "input": "<first user message>" }
```

Config:

```jsonc
{
  "avengersPro": {
    "enabled": true,
    "artifactDir": "./artifacts/avengers-pro",
    "embedding": {
      "baseUrl": "https://api.openai.com",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "text-embedding-3-large"
    },
    "topK": 3,
    "beta": 9,
    "alpha": 0.53,
    "timeoutMs": 400
  }
}
```

`alpha` maps onto Avengers-Pro's performance/cost weights: `performance_weight = alpha`, `cost_sensitivity = 1 - alpha`. First slice uses precomputed balance rankings from the artifact when present; it does not recompute Pareto sets online.

If the embedding call fails or exceeds `timeoutMs`, fall back to the current heuristic `selectModel`. Never fail the user request because the scorer is down.

### Model mapping

Avengers-Pro rankings use paper IDs (`openai/gpt-5-medium`, `google/gemini-2.5-pro`, `qwen/qwen3`, …). The live catalog uses runtime IDs (`opencode/muse-spark-1.2-contributor-free`, `openai/gpt-5.6-sol`, `amazon-bedrock-mantle/xai.grok-4.6`).

A required `modelMap` file joins them:

```json
{
  "openai/gpt-5-medium": ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra"],
  "qwen/qwen3": ["opencode/muse-spark-1.2-contributor-free"],
  "anthropic/claude-opus-4.1": ["anthropic/claude-opus-5"]
}
```

Resolution:

1. Avengers-Pro returns a ranked paper-model list.
2. Walk the list. For each paper ID, take the first mapped runtime ID that exists in the connected catalog and passes context-fit.
3. If none map, fall back to heuristic `selectModel` on the live catalog.

Unmapped connected models (Muse, Grok, Luna, Sol) do not invent Avengers-Pro scores. They only win through an explicit map or the heuristic fallback. Later we can replace the hand map with logs labeled from real sessions.

## Task lock

Avengers-Pro scores the **first user message of a task**, not every proxy request.

A new decision is allowed only when `detectBoundary()` is true:

- new session / first request for that `sessionID`
- explicit `[task:…]` tag
- agent change, if the client sends one
- compaction / cleared context, if signaled
- high-confidence topic shift from existing boundary signals

Follow-up tool calls, retries, and streamed continuations reuse `taskTarget`. This is the opposite of Workweave's per-action default and is intentional: prompt-cache and coherence stay first-class.

Session key: `sessionID` from OpenCode / Claude headers if present, else a hash of the first user message plus client identity, else a cookie/header we set.

## Proxy adapter

New package: `packages/proxy`.

Listen on `127.0.0.1:8787` by default.

### Endpoints, first slice

| Method | Path | Role |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible, routed |
| `POST` | `/v1/messages` | Anthropic Messages, routed |
| `POST` | `/v1/route` | Decision only, no upstream call |
| `GET` | `/health` | liveness |
| `GET` | `/v1/models` | passthrough or connected catalog |

Streaming must work. Tools, system prompts, and multipart content are forwarded unchanged. The proxy only rewrites `model` (and the provider base URL / auth used to reach that model).

### Provider dispatch

Config lists backends the user already has:

```jsonc
{
  "listen": "127.0.0.1:8787",
  "backends": {
    "openai": { "baseUrl": "https://api.openai.com", "apiKeyEnv": "OPENAI_API_KEY" },
    "opencode": { "baseUrl": "https://opencode.ai/zen", "apiKeyEnv": "OPENCODE_API_KEY" },
    "anthropic": { "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  }
}
```

Exact Zen/Bedrock URLs stay in local config, not in the spec. The proxy never logs API keys.

### Wiring OpenCode

OpenCode already supports custom providers. Add one provider whose `baseURL` is the proxy and whose model list is a single virtual model, e.g. `auto-router/auto`. OpenCode always "uses" that model. The proxy chooses the real backend.

Claude Code: `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
Codex / Cursor: OpenAI base URL `http://127.0.0.1:8787/v1`.

The existing plugin can keep logging. It must not also try to mutate `chat.params`.

## Policy composition

Order for a new task:

1. Resolve session + boundary. If not a boundary, return `taskTarget`.
2. Extract the last user text.
3. Apply explicit tags (`[task:planning]`, `[force:complex]`) first. These still win.
4. Run Avengers-Pro → mapped ranked runtime IDs.
5. Overlay task-type policy:
   - `run_tests`: prefer free mapped candidates, else lowest-cost mapped candidate
   - `planning`: drop candidates below quality 85, then take highest quality
   - otherwise take Avengers-Pro's top mapped candidate
6. Context-fit: reject models whose window cannot hold `lifetimeTokens + margin`.
7. Commit `taskTarget`. Log one `TASK SELECT` and, if the inbound requested model differed, one `TASK RECOMMEND`.

Verification and planning overlays remain deterministic even when Avengers-Pro ranks a frontier model first.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Missing artifacts | Start proxy, disable Avengers-Pro, use heuristic `selectModel` |
| Embedding timeout / 4xx / 5xx | Heuristic fallback for that task |
| No mapped candidate | Heuristic fallback |
| Unknown inbound model | Route anyway using scorer + catalog |
| Upstream backend error | Return the upstream status/body; do not silently retry a different model in v1 |

## Testing

- Unit: Avengers-Pro scorer with fixture embeddings and tiny cluster centers (2–3 clusters, 3 models). Assert nearest-cluster ranking and `top_k` aggregation.
- Unit: `modelMap` walks the ranked paper list and skips missing runtime IDs.
- Unit: task lock — second request with same session and no boundary does not re-embed.
- Unit: planning overlay still rejects mapped models below quality 85.
- Unit: embedding timeout triggers heuristic fallback.
- Integration: proxy `POST /v1/chat/completions` with a fake upstream; assert the outbound `model` is the mapped target and the body otherwise matches.
- Integration: `/v1/messages` same contract.
- No live-network tests in CI. Embeddings and upstreams are mocked.

## Files likely to change

- `packages/router-core/src/avengers-pro.ts` — load artifacts, score, rank
- `packages/router-core/src/selector.ts` — call scorer on boundary, then overlays
- `packages/router-core/src/types.ts` / `config.ts` — `avengersPro` + `modelMap`
- `packages/router-core/artifacts/avengers-pro/` — committed inference artifacts
- `packages/proxy/` — HTTP adapter
- `packages/router-core/tests/avengers-pro.test.ts` and proxy tests
- `PLAN.md`, `design.md`, `README.md` — document proxy as the apply path

## Implementation order

1. Port Avengers-Pro inference + fixtures + model map. Heuristic remains fallback.
2. Teach `selectModel` to consume the ranked list on a task boundary.
3. Add the proxy and wire OpenCode to it locally.
4. Only then consider logging real tasks to replace the hand map.

## Open decisions already locked

- Do not touch the assigned OpenCode hook.
- Do not start with heuristics-only proxy.
- Avengers-Pro is the first scorer, with a hand-mapped catalog for Muse / Luna / Sol / Grok.
- Task lock stays. Avengers-Pro does not run on every tool call.
- MIT Avengers-Pro code is a reference. We reimplement inference; we do not exec their Python from the proxy.
