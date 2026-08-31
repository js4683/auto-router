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
2. **Classifier:** Avengers-Pro cluster scoring on a task boundary, with heuristic
   `selectModel` as fallback. Overlap models join through LLMRouterBench; Muse/Grok/Luna
   use an explicit hand map until we have our own labels.
3. **Apply path:** a local OpenAI/Anthropic proxy. The OpenCode plugin stays observational.
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

The OpenCode plugin can recommend a model but cannot change the outbound request.
`chat.params` has no model field, and `anomalyco/opencode#45764` is assigned to someone
else, so we do not implement that hook.

To actually switch models, run the local proxy and point the harness at it:

```bash
export OPENCODE_API_KEY="..."
export GEMINI_API_KEY="..."
npm start --workspace=@auto-router/proxy
```

Set the matching API-key environment variable for every provider the router may
select (`OPENAI_API_KEY`, `OPENCODE_API_KEY`, `GEMINI_API_KEY`, or
`ANTHROPIC_API_KEY`).

Default listen address is `http://127.0.0.1:8787`.

- OpenCode: add an `@ai-sdk/openai-compatible` custom provider whose `baseURL` is
  `http://127.0.0.1:8787/v1` and whose model is a virtual id such as
  `auto-router/auto`.
- Other OpenAI Chat Completions clients can use `http://127.0.0.1:8787/v1`.
- Claude Code can use `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
- Codex can use `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`.

The proxy accepts OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses
requests. It translates text and function calls across Zen's Responses API and
Gemini's `generateContent` API, including client-compatible streaming envelopes.
Gemini chat completions and native OpenAI Responses streams are forwarded
incrementally as upstream chunks arrive; other translated paths synthesize
client-compatible events incrementally.

The proxy scores the first message of a task with Avengers-Pro fixture ranking when
enabled, applies free-first / planning-quality overlays, then holds that target until
a confirmed boundary. Routing state is reconstructed conservatively from normalized
messages, tool schemas, and tool-call history so context size, tool depth, file/patch
hints, and prior tool errors inform selection when the request exposes them.

## Docs

| Doc | Purpose |
|-----|---------|
| [PLAN.md](./PLAN.md) | Canonical scope, implementation status, acceptance criteria, and decision log |
| [design.md](./design.md) | Architecture, the two hard problems, classification tiers |
| [roadmap.md](./roadmap.md) | Phased plan, effort, checklist |

## Why this is a strong fit

Same shape as the Atlassian platform work: a **decision system on a hot path with a
measurement loop**. Route decision = escalate/approve risk engine. Eval harness =
backtest. Stickiness + context-fit guards = the operational judgment that separates a
demo from something that survives production.
