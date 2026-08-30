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
2. **Classifier v1:** Tier-0 heuristics only. Embeddings / LLM-judge are later phases.
3. **First target:** opencode plugin (tighter loop, richer session state for the
   "don't lose context" logic). Proxy adapter second for broad reach.
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

## Integration seam (verified)

- opencode 1.18.25 plugins expose `chat.message` and `chat.params` hooks with full
  session signals, but `chat.params` does not expose a supported provider/model
  mutation. The plugin therefore records one task-level recommendation and leaves the
  actual model unchanged until an upstream routing hook is available.
- Open feature request `sst/opencode#45764` asks for exactly `llm.request.before`
  model routing → documented community demand; possible upstream contribution.

## Docs

| Doc | Purpose |
|-----|---------|
| [PLAN.md](./PLAN.md) | Canonical scope, implementation status, acceptance criteria, and decision log |
| [design.md](./design.md) | Architecture, the two hard problems, classification tiers |
| [roadmap.md](./roadmap.md) | Phased plan, effort, checklist |
| [task-level routing plan](./docs/superpowers/plans/2026-08-29-task-level-routing.md) | Current implementation plan and decision log |

## Why this is a strong fit

Same shape as the Atlassian platform work: a **decision system on a hot path with a
measurement loop**. Route decision = escalate/approve risk engine. Eval harness =
backtest. Stickiness + context-fit guards = the operational judgment that separates a
demo from something that survives production.
