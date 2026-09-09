# Universal Proxy + Installer Design

**Status:** Approved in design review on 2026-09-04
**Implementation status (2026-09-08):** Env helper, settings UI, installer, UI/CLI login,
extra-account storage, retry, on-use refresh, and Google OAuth/Antigravity model discovery
have implemented happy paths. Reliability and security acceptance remain open; see [the
audit](2026-09-06-proxy-account-audit.md).
**Scope:** Public v1 is a local TypeScript proxy plus an installer and a local settings UI. The OpenCode plugin remains private and is not shipped.
**Canonical project plan:** [PLAN.md](../../PLAN.md)

## Objective

Match Workweave’s “one local endpoint, wire the clients” shape while keeping auto-router principles: task-level stickiness, fail-open, verification free-first, planning quality-first, no per-turn switching, no prompt/credential logging.

## Assumptions

1. Users run the proxy on `127.0.0.1:8787`.
2. Existing logins come from OpenCode `auth.json` and Claude Code credentials. Additional
   logins use `~/.config/auto-router/accounts.json`. Settings keys use a local `.env`;
   connect-page keys use the account store. Credential files should remain mode `0600`.
3. Claude Code and OpenCode speak Anthropic Messages. Codex uses OpenAI Responses;
   Cursor uses OpenAI Chat Completions. Gemini API-key inference uses an AI Studio API
   key; Antigravity OAuth uses the separate Cloud Code Assist transport and must not be
   sent to the Gemini API as a key.
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

The installer workspace is `@auto-router/install`. Terminal login currently lives in
`@auto-router/proxy`; after building it, the explicit workspace form is
`npm run login --workspace=@auto-router/proxy -- claude` (also codex/grok/zen/gemini/antigravity).
There is no published `auto-router` binary or package `bin` entry. Root npm forwarding
and non-interactive PKCE completion are open acceptance items, not verified interfaces.

## Architecture

```
Claude Code / OpenCode  --Anthropic Messages-->  proxy :8787
Codex                   --Responses---------->  proxy :8787
Cursor                  --Chat Completions----> proxy :8787
                                              |
                                              +--> router-core.selectModel (task lock)
                                              +--> provider logins / extra accounts / API keys
                                              +--> GET /  settings UI  --> local .env
```

`router-core` stays harness-agnostic. The proxy reconstructs conservative `SessionState`, locks one target per task, and translates to the chosen backend. Missing keys or ineligible targets fail open: forward the client’s requested model if a matching backend exists, otherwise return an error without retrying unknown-billing timeouts.

## Installer

Default scope is user-level config (not project). Re-install rewrites only a managed block.

| Client | Config | Protocol |
|--------|--------|----------|
| Claude Code | Anthropic `baseURL` → `http://127.0.0.1:8787` | Messages |
| OpenCode | Anthropic-compatible provider → proxy `/v1` | Messages |
| Codex | `model_providers` OpenAI-compatible → proxy `/v1` | Responses |
| Cursor | OpenAI base URL override → `http://127.0.0.1:8787/v1` | Chat Completions |

Intended uninstall preserves user-owned values and restores only installer-owned
changes. Current JSON updates do not fully meet that contract (audit A11). Codex's
provider block is written, but provider activation is not selected automatically.
Cursor configuration remains manual instructions. OpenCode plugin files are not
installed or removed.

## Settings UI

Served at `GET /` on the proxy (loopback only).

- Form for `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (and optional base URLs).
- Save writes `~/.config/auto-router/.env` or project `.env.local` with mode `0600`. Never logs values.
- Shows `/health` and the last `TASK SELECT` line (model id, task type, via). No prompts or responses.

## Failure Modes

This table is the intended contract, not a claim of verified implementation. In
particular, installer `status`, missing-key fallback, bounded upstream waits, and
management-route origin protection are not established by current tests.

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

The original v1 direction remains approved. The audit now identifies open implementation
gates for account identity, concurrency, session stickiness, CLI lifecycle, quota units,
and local management security. Resolve those before expanding features. Dashboard
analytics, encrypted key stores, hosted deployment, and classifier activation remain
later slices.
