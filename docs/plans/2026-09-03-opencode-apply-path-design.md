# OpenCode Apply Path Design

**Status:** Approved in design review on 2026-09-03
**Implementation status:** Not started
**Scope:** Apply auto-router selections inside OpenCode using connected providers, at confirmed task boundaries, without the API-key proxy
**Canonical project plan:** [PLAN.md](../../PLAN.md)

## Context

Phases 0–4 of auto-router are code-complete. The OpenCode plugin already:

- Builds a live catalog from `client.provider.list({ query: { directory } })`
- Detects task boundaries and calls `selectModel`
- Logs `TASK SELECT` / `TASK RECOMMEND`
- Does not change the outbound model

OpenCode 1.18.27 (`~/.opencode/bin/opencode`) still has no supported model override:

- `chat.params` output is `temperature`, `topP`, `topK`, `maxOutputTokens`, `options`
- `session.update` accepts only `title`
- [anomalyco/opencode#45764](https://github.com/anomalyco/opencode/issues/45764) remains open

The local proxy can switch models but only through four API-key backends. That path cannot use OpenCode `/connect` providers (OAuth, Copilot, Bedrock, custom npm providers). This phase does not extend the proxy.

Priority: the lightweight router must apply selections locally in OpenCode using the same providers the user already connected.

## Goals

- Auto-switch the **current** OpenCode turn at a confirmed task boundary.
- Select only from models returned by connected OpenCode providers.
- Keep auth on OpenCode `/connect`. No env API keys. No proxy.
- Fail open when the hook is missing, the catalog is stale, or the target is disconnected.
- Preserve existing stickiness: non-boundary turns do not set a model override.
- Keep `router-core` policy, classification, and selection unchanged except for consuming a live catalog.

## Non-Goals

- Reimplementing OpenCode’s provider SDK inside auto-router.
- Changing the proxy apply path, adding OAuth/Copilot/Bedrock adapters to the proxy, or pointing OpenCode at `auto-router/auto`.
- Per-turn switching inside a task.
- Abort-and-reprompt workarounds.
- Tier-1 activation, live benchmark gate, or a Go proxy rewrite.
- Waiting on upstream before a local OpenCode patch.

## Decisions

1. Extend existing `chat.params` with optional `output.model`. Do not add a second hook named `llm.request.before`.
2. Patch OpenCode locally against 1.18.27 first; upstream a PR for the same hook after the local path works.
3. The auto-router plugin is the apply path. `router-core` stays harness-agnostic.
4. Override applies to this request only. Unset `output.model` means OpenCode keeps `input.model`.
5. Fail open on every apply failure. Never crash a turn because routing failed.
6. The plugin must not mutate `input.model`.

## Architecture

```
OpenCode TUI / session
        │
        ▼
chat.message  →  detectBoundary + selectModel → store taskTarget
        │
        ▼
chat.params   →  if boundary and target connected and different
                     set output.model = { providerID, modelID }
                 else leave unset (sticky)
        │
        ▼
OpenCode LLM request path
        │  uses output.model when present and valid
        ▼
Connected provider (OpenCode auth)
```

Two repositories:

| Repo | Change |
|------|--------|
| OpenCode 1.18.27 | Honor optional `chat.params` `output.model` |
| auto-router | Plugin sets `output.model` at confirmed boundaries |

## Hook Contract

Existing hook, additive field only:

```ts
"chat.params"?: (
  input: {
    sessionID: string
    agent: string
    model: Model
    provider: ProviderContext
    message: UserMessage
  },
  output: {
    temperature: number
    topP: number
    topK: number
    maxOutputTokens: number | undefined
    options: Record<string, any>
    model?: { providerID: string; modelID: string }
  }
) => Promise<void>
```

OpenCode request-path rules:

1. After all `chat.params` plugins run, if `output.model` is set, resolve that `providerID`/`modelID` against the live provider catalog.
2. If resolved, use it for this LLM call only.
3. If missing, unknown, deprecated, or disconnected, ignore the override and use `input.model`.
4. Do not persist the override as the session or global default model. A later user `/models` choice remains a separate OpenCode action.

## Plugin Flow

1. **Startup / `config`:** `loadConfig()`, `loadCatalogSync()`, then start `client.provider.list` with a 1500 ms fail-open timeout. Replace the catalog only when the live list is non-empty.
2. **`chat.message`:** Extract session state from the user message and session signals. `detectBoundary`. On a confirmed boundary (or first message), `selectModel` against the live catalog. Store `taskTarget` as a provider-qualified runtime id (`providerID/modelID`). Log `TASK SELECT`.
3. **`chat.params`:** Parse `taskTarget` into `{ providerID, modelID }`. Set `output.model` only when all of these hold:
   - this turn is a confirmed boundary (or the first message of a task)
   - `taskTarget` is present
   - the pair exists in the connected catalog
   - it differs from `input.model.providerID` / `input.model.modelID`
4. **Sticky turns:** leave `output.model` unset. Log `TASK HOLD`.
5. **Logging:** append `TASK SELECT`, `TASK APPLY`, `TASK HOLD`, and `TASK APPLY skipped` lines to `~/.cache/auto-router-decisions.log` and `client.app.log`.

Selection continues to use existing task-type policy, free-first / quality floors, context-fit, and stickiness inside `router-core`.

## Failure Modes

| Condition | Behavior |
|-----------|----------|
| Stock OpenCode without the patch | `output.model` is ignored by the host. Plugin logs `TASK RECOMMEND` as today. No crash. |
| Invalid or disconnected target | OpenCode ignores override. Plugin logs `TASK APPLY skipped`. |
| `provider.list` timeout or throw | Keep last catalog or fallback. Do not block the turn. |
| `selectModel` throw | Catch, leave model unchanged, log error. |
| Empty live catalog | Keep fallback catalog; apply only if the target still resolves. |

## Testing

### auto-router plugin

- Boundary turn with a connected different target → `output.model` set to that pair.
- Sticky follow-up → `output.model` unset.
- Unknown target → `output.model` unset.
- Catalog timeout → no throw; no false apply.
- First session message → treated as a boundary and may apply.

### OpenCode patch

- Valid override used for exactly one request.
- Invalid override ignored; `input.model` used.
- Unset override keeps current model.
- Existing `chat.params` temperature/options behavior unchanged.

### Manual local gate

On patched OpenCode with the plugin loaded and real `/connect` providers:

1. Start a session on any connected model.
2. Planning prompt (`Plan the architecture for this project`) applies a quality-first connected model.
3. A long corroborated `run …` verification prompt applies a free/lowest-cost connected model.
4. `run that again, please` stays on the verification model.
5. Decision log shows `TASK SELECT` / `TASK APPLY` / `TASK HOLD` matching those turns.

## Rollout

1. Patch local OpenCode 1.18.27 so `chat.params` honors `output.model`.
2. Wire the auto-router plugin apply path with fail-open.
3. Pass plugin tests and the manual local gate.
4. Open an upstream OpenCode PR for the hook (same contract as the local patch).
5. Keep the plugin fail-open until upstream ships; local patched OpenCode is the supported apply runtime until then.

## Ownership

- **OpenCode:** request-path override and catalog validity check.
- **auto-router plugin:** boundary detection, selection, setting `output.model`, logging.
- **router-core:** unchanged selection contract.

## Out of this change

- Proxy backends, OpenRouter-only launchers, and `OPENCODE_CONFIG_CONTENT` pointing at `auto-router/auto`.
- Mutating `input.model`.
- Persisting a new global default model as a side effect of routing.
- Competing for an assigned `llm.request.before` implementation beyond the additive `chat.params` field.

## Acceptance

This phase is done when:

- A local patched OpenCode session applies router targets at task boundaries using `/connect` providers.
- Sticky turns do not switch models.
- Stock OpenCode without the patch still runs the plugin without errors.
- Tests listed above pass.
- PLAN.md and roadmap.md record the apply-path decision and remaining upstream-PR item.
