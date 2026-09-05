# Universal Proxy + Installer Design

**Status:** Approved in design review on 2026-09-04
**Implementation status:** Env helper, settings UI, and installer are implemented. Docs updated.
**Scope:** Public v1 is a local TypeScript proxy plus an installer and a local settings UI. The OpenCode plugin remains private and is not shipped.
**Canonical project plan:** [PLAN.md](../../PLAN.md)

## Objective

Match Workweave’s “one local endpoint, wire the clients” shape while keeping auto-router principles: task-level stickiness, fail-open, verification free-first, planning quality-first, no per-turn switching, no prompt/credential logging.

## Assumptions

1. Users run the proxy on `127.0.0.1:8787`.
2. Provider keys live in a local `.env` (mode `0600`), edited by a small UI the proxy serves.
3. Claude Code and OpenCode speak Anthropic Messages to the proxy. Codex and Cursor speak OpenAI Chat Completions.
4. The existing OpenCode `/connect` plugin is local-only and not part of the installer.
5. No Postgres, no `rk_` router keys, no hosted cloud, no analytics warehouse.

## Tech Stack

- `packages/proxy` (TypeScript) — public apply path
- `packages/router-core` — unchanged policy
- New installer entry (Node script, `npx`-runnable) — client config patches
- Static settings UI served by the proxy

## Commands

```bash
npm start --workspace=@auto-router/proxy
npm run install-clients -- --claude --codex --cursor --opencode
npm test --workspace=@auto-router/proxy
```

Exact installer package name is `packages/install` or a bin on the proxy package; pick one at implementation and keep a single command.

## Architecture

```
Claude Code / OpenCode  --Anthropic Messages-->  proxy :8787
Codex / Cursor          --Chat Completions---->  proxy :8787
                                              |
                                              +--> router-core.selectModel (task lock)
                                              +--> env BYOK backends (OpenAI, Zen, Anthropic, Gemini)
                                              +--> GET /  settings UI  --> local .env
```

`router-core` stays harness-agnostic. The proxy reconstructs conservative `SessionState`, locks one target per task, and translates to the chosen backend. Missing keys or ineligible targets fail open: forward the client’s requested model if a matching backend exists, otherwise return an error without retrying unknown-billing timeouts.

## Installer

Default scope is user-level config (not project). Re-install rewrites only a managed block.

| Client | Config | Protocol |
|--------|--------|----------|
| Claude Code | Anthropic `baseURL` → `http://127.0.0.1:8787` | Messages |
| OpenCode | Anthropic-compatible provider → proxy `/v1` | Messages |
| Codex | `model_providers` OpenAI-compatible → proxy `/v1` | Chat Completions |
| Cursor | OpenAI base URL override → `http://127.0.0.1:8787/v1` | Chat Completions |

Uninstall restores the managed block only. OpenCode plugin files are not installed or removed.

## Settings UI

Served at `GET /` on the proxy (loopback only).

- Form for `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (and optional base URLs).
- Save writes `~/.config/auto-router/.env` or project `.env.local` with mode `0600`. Never logs values.
- Shows `/health` and the last `TASK SELECT` line (model id, task type, via). No prompts or responses.

## Failure Modes

| Condition | Behavior |
|-----------|----------|
| Proxy down | Clients error as today; installer `status` reports unreachable |
| Missing backend key for selected target | Fail open to inbound model if that backend is keyed; else 4xx |
| Task boundary | New `selectModel`; sticky turns keep the target |
| UI save with empty key | Leaves existing env value unchanged |
| Timeout to upstream | No retry |

## Testing

- Installer dry-run: writes fixtures, not real home dirs, asserts managed blocks.
- Proxy regression: Messages, Chat Completions, fail-open, no secret in logs.
- UI save: temp dir `.env` mode `0600`, keys not present in log output.

No live provider calls in CI.

## Boundaries

- Always: task stickiness; fail-open; loopback UI; `0600` env files; plugin stays private.
- Ask first: Postgres, `rk_` keys, hosted deploy, shipping the OpenCode plugin, extra provider SDKs.
- Never: per-turn switching; log prompts/credentials; mix installer with the private plugin.

## Success Criteria

- Four clients can be pointed at `:8787` by the installer.
- A local UI can set env keys without printing them.
- Existing proxy tests still pass; installer tests cover managed-block install/uninstall.
- OpenCode plugin is unchanged and not distributed.

## Open Questions

None for v1. Dashboard analytics and encrypted key stores are later slices.
