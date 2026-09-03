# OpenCode Apply Path Design

**Status:** Approved after source audit on 2026-09-03
**Implementation status:** Not started
**Scope:** Apply auto-router selections inside stock OpenCode using connected providers, at confirmed task boundaries, without the API-key proxy
**Canonical project plan:** [PLAN.md](../../PLAN.md)

## Context

Phases 0-4 of auto-router are code-complete. The OpenCode plugin already:

- Builds a live catalog from `client.provider.list({ query: { directory } })`.
- Detects task boundaries and calls `selectModel`.
- Logs `TASK SELECT` / `TASK RECOMMEND`.
- Does not change the outbound model.

An initial design proposed adding `output.model` to `chat.params`. An audit against
OpenCode 1.18.27 rejected that approach: OpenCode resolves the language model,
provider, auth, system prompt, variants, provider options, tool compatibility, and
headers before or while invoking `chat.params`. Changing the model there would leave
part of the request prepared for the previous provider/model.

Stock OpenCode already exposes the correct earlier seam. `chat.message` receives a
mutable pending `UserMessage` as `output.message` before OpenCode validates and saves
it. The session run loop later resolves the model from that saved user message, before
provider auth and request preparation. Therefore, assigning
`output.message.model = { providerID, modelID }` applies the selected model to the
complete current turn without an OpenCode patch.

The local proxy can switch models but only through four API-key backends. It cannot use
all OpenCode `/connect` providers (OAuth, Copilot, Bedrock, and custom npm providers).
This phase does not extend the proxy.

Priority: the lightweight router must apply selections locally in OpenCode using the
same providers the user already connected.

## Source Evidence

The design is pinned to official OpenCode 1.18.27 source:

- [`@opencode-ai/plugin` declares mutable `chat.message` output](https://github.com/anomalyco/opencode/blob/v1.18.27/packages/plugin/src/index.ts#L232-L256).
- [`createUserMessage` invokes `chat.message` with the pending message](https://github.com/anomalyco/opencode/blob/v1.18.27/packages/opencode/src/session/prompt.ts#L999-L1009), then [validates and saves that same message](https://github.com/anomalyco/opencode/blob/v1.18.27/packages/opencode/src/session/prompt.ts#L1022-L1047).
- [The run loop resolves the provider/model from the saved user message](https://github.com/anomalyco/opencode/blob/v1.18.27/packages/opencode/src/session/prompt.ts#L1092-L1142).
- [Provider, auth, and request preparation use that resolved model](https://github.com/anomalyco/opencode/blob/v1.18.27/packages/opencode/src/session/llm.ts#L85-L113).

OpenCode updates its session-level selected model before `chat.message` runs. The
plugin override is therefore request-scoped and does not change the TUI model picker.
The plugin reapplies the held task target to every new user message and shows a
boundary toast so actual model use is visible without changing the user's default.

## Goals

- Auto-switch the current OpenCode turn at a confirmed task boundary.
- Hold and apply that target to every user message inside the task.
- Select and apply only models from a successful live connected-provider snapshot.
- Keep auth on OpenCode `/connect`. No environment API keys. No proxy.
- Fail open when live discovery or selection fails.
- Preserve existing stickiness: only confirmed boundaries trigger reselection.
- Keep `router-core` harness-agnostic and reuse its existing policy.

## Non-Goals

- Reimplementing OpenCode's provider SDK inside auto-router.
- Changing the proxy or adding OAuth/Copilot/Bedrock adapters to it.
- Changing models within one task.
- Persisting the router target as the session or global OpenCode default.
- Synchronizing the TUI model picker with the request-scoped target.
- Adding or patching an OpenCode hook.
- Abort-and-reprompt workarounds.
- Tier-1 activation, the live benchmark gate, or a Go proxy rewrite.

## Decisions

1. Use existing `chat.message.output.message.model`; do not mutate `chat.params` or patch OpenCode.
2. Select a new target only at a confirmed boundary or the first task message.
3. Apply the held target to every user message in that task so the unchanged TUI default cannot cause drift.
4. Apply only a provider-qualified target present in the latest successful live connected-model snapshot.
5. Clear `variant` when switching models so a variant from the previous model cannot leak across providers.
6. Use `chat.params` only to confirm which model OpenCode resolved.
7. Fail open on every routing failure. Never block a turn because routing failed.

## Architecture

```text
OpenCode TUI / session
        |
        v
chat.message
        |-- refresh connected catalog (bounded)
        |-- boundary: detectBoundary + selectModel
        |-- sticky: reuse taskTarget
        |-- validate target against live snapshot
        `-- set output.message.model before save
        |
        v
OpenCode saves UserMessage with selected provider/model
        |
        v
OpenCode resolves model + provider + auth and prepares full request
        |
        v
chat.params confirms resolved model (observation only)
        |
        v
Connected provider (OpenCode auth)
```

Only the auto-router repository changes. Stock OpenCode 1.18.27 is the supported host.

## Existing Hook Contract

No public interface change is required:

```ts
"chat.message"?: (
  input: {
    sessionID: string
    agent?: string
    model?: { providerID: string; modelID: string }
    messageID?: string
    variant?: string
  },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>
```

At apply time:

```ts
output.message.model = { providerID, modelID }
```

The replacement intentionally omits `variant`. Model IDs may contain `/`, so a
provider-qualified runtime ID must be split at its first `/`, not its last one.

## Plugin Flow

1. **Startup / `config`:** load config and fallback catalog, then call
   `client.provider.list` with a 1500 ms timeout. A successful non-empty response
   replaces the selection catalog and the live connected-model ID set.
2. **`chat.message`:** extract prompt text from `output.message` / `output.parts`, then
   build session state and call `detectBoundary`.
3. **Boundary:** call `selectModel` against the live catalog and store the resulting
   provider-qualified `taskTarget`. Log `TASK SELECT`.
4. **Sticky turn:** do not reselect; reuse `taskTarget`.
5. **Apply:** if `taskTarget` is in the live connected-model ID set, compare it with
   `output.message.model`. When different, replace `output.message.model` with the
   target pair and omit `variant`. Store the expected message ID, agent, and model pair
   for confirmation.
6. **No live proof:** if the target came only from fallback/cache data, leave the
   message unchanged and log `TASK RECOMMEND`. Fallback data is never proof that auth
   is connected.
7. **`chat.params`:** ignore calls whose message ID or agent does not match the pending
   confirmation. This excludes title generation and subtask agents that can run in the
   same session. On the first matching LLM call, compare `input.model.providerID` /
   `input.model.id` with the expected pair. Log `TASK APPLY` or
   `TASK APPLY mismatch`, then clear the pending confirmation.
8. **Visibility:** show one fail-open TUI toast at a new boundary when a different
   target is applied. Do not toast on sticky turns.

Selection continues to use existing task-type policy, quality floors, context fit,
free-first verification ordering, and task stickiness inside `router-core`.

## Failure Modes

| Condition | Behavior |
|-----------|----------|
| `provider.list` timeout, throw, or empty result | Keep selection available for recommendation, but do not mutate the message without a successful live snapshot. |
| Target absent from live connected set | Leave message unchanged; log `TASK RECOMMEND`. |
| `selectModel` throws | Catch, leave message unchanged, and log the error. |
| Target runtime ID is malformed | Leave message unchanged; log `TASK APPLY skipped`. |
| TUI toast or log call fails | Ignore; routing and the user turn continue. |
| `chat.params` resolves a different model | Do not retry or reprompt; log `TASK APPLY mismatch` for diagnosis. |

No prompt text, response content, credentials, or provider auth values are written to
decision logs.

## Testing

### auto-router plugin

- Boundary with a connected different target replaces `output.message.model`.
- First session message is treated as a boundary and may apply.
- Sticky follow-up reuses the task target without calling `selectModel` again.
- Sticky follow-up starting from a different TUI model is rewritten to the held target.
- Same provider/model leaves the message model and valid variant unchanged.
- Cross-model apply omits the previous model's variant.
- Runtime IDs containing `/` preserve the complete model ID.
- Target absent from the latest live snapshot is recommendation-only.
- Catalog timeout/throw does not throw and does not apply fallback models.
- First `chat.params` call confirms the expected applied model once.
- A title-agent `chat.params` call does not consume the main agent's pending confirmation.

### Manual local gate

On stock OpenCode 1.18.27 with the plugin loaded and real `/connect` providers:

1. Start a session on any connected model.
2. A planning prompt applies a quality-first connected model.
3. A long corroborated `run ...` verification prompt applies a free/lowest-cost connected model.
4. `run that again, please` stays on the verification target.
5. Saved user and assistant message metadata show the routed provider/model.
6. Decision logs show `TASK SELECT` / `TASK APPLY` / sticky hold behavior matching those turns.

## Rollout

1. Add focused plugin tests around existing hooks.
2. Implement `chat.message` apply and `chat.params` confirmation.
3. Run the repository test suite and build.
4. Deploy the verified plugin to `~/.config/opencode/plugins/auto-router.ts`.
5. Pass the manual local gate on stock OpenCode 1.18.27.
6. Update `PLAN.md` and `roadmap.md` with the supported native apply path.

## Ownership

- **OpenCode:** existing message persistence, provider/model resolution, auth, and request preparation.
- **auto-router plugin:** discovery, boundary detection, selection, request-scoped model assignment, confirmation, and logging.
- **router-core:** unchanged policy and selection contract.

## Alternatives Rejected

- **`chat.params.output.model`:** too late in OpenCode's request pipeline and requires a host API change.
- **Local OpenCode fork:** unnecessary once the earlier `chat.message` seam is used.
- **Abort and reprompt:** risks duplicate or dropped messages.
- **Proxy apply:** cannot reuse all OpenCode-managed provider connections.
- **Recommendation only:** does not satisfy automatic application.

## Acceptance

This phase is done when:

- A stock OpenCode 1.18.27 session applies router targets using `/connect` providers.
- Only task boundaries reselect; every sticky task turn keeps the held target.
- No target is applied without proof from a successful live connected-provider snapshot.
- The plugin confirms the resolved model through `chat.params` without mutating it.
- Focused tests, the full repository test suite, build, and manual local gate pass.
- `PLAN.md` and `roadmap.md` record the native apply path.
