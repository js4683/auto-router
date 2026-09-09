# Subscription Credentials Design

**Status:** Superseded for current OAuth and Google inference behavior; retained as the
historical Slice 1 design from 2026-09-04.
**Implementation status:** Slice 1 implemented (env then OpenCode then Claude Code credentials).
**Scope:** Historical Slice 1 — resolve per-provider credentials for the local proxy from
env API keys, then OpenCode auth, then Claude Code login. Live eval calls the same proxy.
**Depends on:** [2026-09-04-universal-proxy-installer-design.md](./2026-09-04-universal-proxy-installer-design.md)
**Canonical project plan:** [PLAN.md](../../PLAN.md)

> Current shared UI/CLI OAuth, Google Antigravity transport, and Google API-key isolation
> are owned by the [universal proxy design](./2026-09-04-universal-proxy-installer-design.md)
> and [PLAN.md](../../PLAN.md). The historical boundaries below do not describe those
> later flows.

## Objective

The proxy sits in front of many providers. It is not tied to one vendor. For each selected task target, use that provider’s subscription token when present, otherwise an API key. Evals go through the same proxy so they use the same subscriptions.

## Assumptions

1. OpenCode `~/.local/share/opencode/auth.json` may hold openai/xai/google OAuth and
   anthropic/google/openrouter API-key entries.
2. Claude Code may have a local Anthropic credential we can read; if the file layout is unknown, skip that provider rather than guess.
3. Cursor Pro quota cannot be used. Cursor as a *client* of the proxy is unchanged.
4. Tokens are never logged. Empty env values do not wipe a stored key.
5. In-UI ChatGPT/Claude login is a later slice.

## Credential chain

For a selected runtime id `provider/model`:

1. Env / settings `.env` key for that backend (if set).
2. OpenCode `auth.json` entry for that provider (`key` or oauth `access`/`token`).
3. Claude Code credential, Anthropic targets only.
4. Fail-open: retry the inbound client model with its own chain; else HTTP 401 without leaking secrets.

Mapping (v1):

| Target prefix | Env | OpenCode auth id |
|---------------|-----|------------------|
| `openai/` | `OPENAI_API_KEY` | `openai` |
| `opencode/` | `OPENCODE_API_KEY` | — |
| `anthropic/` | `ANTHROPIC_API_KEY` | `anthropic` |
| `google/` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `google` |
| `xai/` | — | `xai` |
| `github-copilot/` | — | `github-copilot` |
| `openrouter/` | — | `openrouter` |

Unknown prefixes: env only if we add them later; otherwise 401.

## Eval

`AUTO_ROUTER_EVAL_BASE_URL=http://127.0.0.1:8787/v1` (loopback). Eval sends Chat Completions; the proxy routes and attaches provider creds. `AUTO_ROUTER_EVAL_API_KEY` may be any placeholder. No separate eval provider keys required.

## Testing

- Unit: given a temp auth.json + env, `resolveCredential("openai/gpt-4o")` prefers env, then oauth token.
- Unit: missing cred → null, no throw, no token in error string.
- Proxy test: backend `apiKey` unset, resolver supplies token from fixture auth file.
- Never print secrets in test names or logs.

## Boundaries

- Always: multi-provider; fail-open; no secret logs.
- Ask first in this historical slice: new provider prefixes; reading Cursor’s own tokens.
- Never: claim Cursor Pro works; retry after timeout; log tokens.

## Success Criteria

- Proxy can call OpenAI/Anthropic/Google/xAI using OpenCode-stored creds when env keys are absent.
- Settings UI keys still win when set.
- A loopback live eval against the proxy does not need `OPENAI_API_KEY` in the eval process if OpenCode already has openai oauth.

## Open Questions

None for the historical Slice 1. Later OAuth behavior is documented by the current
universal-proxy design and PLAN.md.
