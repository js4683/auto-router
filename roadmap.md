# auto-router — Roadmap

Current scope, implementation status, acceptance criteria, and decisions are maintained
in [PLAN.md](./PLAN.md). This roadmap covers the broader project phases.

## Phases

| Phase | Deliverable | Effort |
|-------|-------------|--------|
| **0** | `router-core` (TS): `classify()` + policy config + Tier-0 heuristics + context-fit + task stickiness | ~3-4 days |
| **0.5** | **Model catalog**: Artificial Analysis client, live provider catalog, value/cost strategies + window registry join | ~2-3 days |
| **1** | opencode plugin adapter with task-boundary recommendations and decision logging | ~2-3 days |
| **2** | OpenAI-compatible proxy adapter (any harness via base_url) | ~2-3 days |
| **3** | Eval harness: replay real sessions, measure cost saved vs quality retained | ~3 days |
| **4** | Tier-1 embedding classifier (opt-in) | later |

## Phase 0 — router-core (start here)

- [x] TS package scaffold, no harness deps
- [x] `SessionState` type: tokens, files, diff size, tool-call depth, last user message
- [x] Tier-0 heuristic scorer -> `simple | medium | complex`
- [x] Policy engine: tier + config -> model choice
- [x] Context-fit guard: refuse downgrade if session won't fit target window + margin
- [x] Task-boundary detection + confidence gate (route only on confident new task)
- [x] Stickiness: hold model within a task
- [x] Task-type resolution (review / run_tests / monitoring / planning / implement / debug):
      **v1 = explicit** (user tag or opencode agent/mode -> task type). Auto-detection
      is narrow for verification and planning, and gated elsewhere.
- [x] Task policies: verification free/lowest-cost; planning quality-first with floor 85
- [x] Two-axis `selectModel`: task-type map first, else free-first within tier, guarded
- [x] Unit tests for scorer + guards + anti-thrash + task-type override

## Phase 1 — opencode plugin

- [x] Plugin scaffold (`@opencode-ai/plugin`), context hook wiring
- [x] Map opencode session -> `SessionState`
- [x] Lock one target per task and emit at most one recommendation per task
- [x] Config surface in `opencode.json` (tier/task policy, stickiness, guards)
- [x] Live connected-provider discovery with bounded fallback
- [x] Decision logging (target model and actual runtime model)
- [ ] Apply the locked target automatically when OpenCode exposes a routing hook
- [ ] Manual multi-task test after upstream model-routing support

## Phase 2 — proxy adapter

- [x] OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages server wrapping
      `router-core`
- [x] Reconstruct conservative `SessionState` signals from request messages, tools, and
      tool-call history
- [x] Forward to the chosen upstream model
- [ ] Stream translated upstream responses incrementally (translated paths are currently
      buffered before client-compatible events are emitted)
- [x] Works with OpenCode, Claude Code, Codex, and other clients by setting `base_url`

## Phase 3 — eval

- [ ] Record/replay real sessions
- [ ] Metrics: cost saved, quality retained, switch count, cache-hit impact
- [ ] Compare against always-frontier and always-cheap baselines
- [ ] Bar: approach ~95% quality at a large cost cut (RouteLLM reference)

## Stretch

- [ ] Tier-1 embedding classifier
- [ ] Tier-2 LLM judge (flagged)
- [ ] Upstream `llm.request.before` hook to opencode (ref #45764) if v2 hook is
      insufficient
- [ ] Go rewrite of the proxy for perf / single-binary distribution

## Key references

- opencode plugins: https://opencode.ai/docs/plugins/ (+ v2 build/plugins)
- Feature request (model routing hook): `sst/opencode#45764`
- RouteLLM: https://github.com/lm-sys/RouteLLM
- Not-Diamond RoRF: https://github.com/Not-Diamond/RoRF
- vLLM semantic-router (classification signals): https://github.com/vllm-project/semantic-router
