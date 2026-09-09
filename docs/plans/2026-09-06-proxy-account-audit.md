# Public Proxy and Account Audit

Date: 2026-09-06. Status: request changes before release.
Canonical plan: [PLAN.md](../../PLAN.md).

## Scope and Evidence

Reviewed the canonical plan, roadmap, core design, universal-proxy design, current
proxy/account/OAuth/CLI/quota implementation, installer, associated tests, and focused
eval changes. Source references below are repository-relative at this audit snapshot.
This is a focused public-v1 audit, not an exhaustive re-review of classifier training,
all core algorithms, dependency supply chain, or previously deployed global plugins.

Only planning Markdown was edited. No source/test fixes, credential changes, login
attempts, live inference, build, proxy restart, or commits were performed in this audit.
Findings are code-path evidence unless explicitly described as an executed check.

Checked offline:

- `packages/proxy`: `npx vitest run`, 86 tests passed in 10 files.
- `packages/proxy`: `npx tsc -p tsconfig.json --noEmit`, passed.
- `packages/install`: `npx vitest run`, 2 tests passed.
- `packages/eval`: `npx vitest run tests/live.test.ts`, 16 tests passed.

Tests use existing compiled workspace dependencies. No fresh full-workspace build or
full-monorepo suite was run. Desktop/mobile rendering and live multi-account inference
were not verified. Prior user-reported Anthropic CLI login and a stored credential are
not evidence of distinct accounts, independent quota pools, or successful inference.

## Plan Alignment

The product direction remains sound: one local endpoint, task/model stickiness,
verification free-first, planning quality-first, login reuse, API-key fallback, and
optional native OpenCode integration. Keep router-core policy separate from credential
selection and protocol handling. Do not add hosted services or training to solve local
account reliability problems.

Recent implementation covers happy paths but previous completion statements were too
broad. More than two credentials, source-aware refresh, concurrent writes, provider
cooldowns, and real CLI lifecycle tests are not covered. The live quality gate remains
unproven; Phase 4 activation remains deferred.

## Required Findings

### A1. High: Local management trusts unvalidated requests

`packages/proxy/src/server.ts:1203-1302` accepts credential/config mutation without
Origin or Host validation. `/settings` filters keys when writing the file, but then
copies every nonempty submitted field into `process.env` at lines 1300-1301. A crafted
form can therefore mutate environment fields outside the documented allowlist. Loopback
binding alone is not application-level protection from browser-origin attacks; browser
private-network protections vary. `AUTO_ROUTER_HOST` also permits non-loopback binding
at line 1636 without an authentication layer.

Fix: enforce the loopback management boundary, validate Host/Origin and allowed methods,
reject unexpected fields before persistence or runtime assignment, and cap body size.
Test foreign-origin forms, unexpected environment keys, and non-loopback startup.
No exploit was sent to the running proxy.

### A2. High: Retry exhaustion can leave the client unanswered

`packages/proxy/src/server.ts:1363-1365,1449-1453,1577-1578`: the retry loop stops at six
attempts, but the 429 branch continues whenever another account exists. With seven
credentials and the first six rate-limited, the sixth attempt continues out of the loop
without writing or ending a response. A final-attempt Zen failover can similarly exhaust
the loop. Rejected 429 bodies are not consumed or canceled before retry.

Fix: use a finite candidate snapshot and explicit terminal response on every exit;
cancel/drain rejected bodies. Tests: seven credentials, all limited, final-attempt Zen
failure, and streaming request variants. Supporting N stored accounts must not imply
unbounded retries or silently unanswered requests.

### A3. High: Refresh destination is inferred from list position

`packages/proxy/src/accounts.ts:188-207` sets `primary` based on whether an earlier
credential exists. `packages/proxy/src/oauth.ts:401-418` treats that flag as persistence
identity. An extra-only OAuth credential becomes primary and attempts refresh through
`auth.json`, leaving the expired extra unchanged. Conversely, an `auth.json` Claude
credential after a distinct keychain credential becomes non-primary and its refresh is
written through `updateExtraAccount` using an ID absent from the extra store. The new
token may work once but its rotated refresh token is lost.

Fix: explicit source (`keychain`, auth file, extra file, environment) and source key;
persist through that source regardless of ordering. Test extra-only, keychain-plus-auth,
and keychain-plus-auth-plus-extra configurations without accessing the real keychain.

### A4. Resolved: Google OAuth uses a dedicated inference transport

Google OAuth access tokens are not Gemini API keys. They are valid for the separate
Antigravity Cloud Code Assist transport, while AI Studio keys remain valid for the
Gemini API. The current account resolver excludes Google OAuth accounts whenever a
Gemini/Google API key is selected, and the proxy routes OAuth accounts only through
Cloud Code Assist. OAuth therefore cannot become a Gemini `?key=` credential.

The focused primary/extra account, refresh, Cloud Code Assist, discovery, and API-key
isolation coverage now protects this split. A Google OAuth login still does not provide
an AI Studio API key.

### A5. High: Headerless clients do not have stable task identity

`packages/proxy/src/server.ts:669-670` derives the fallback session ID from the latest
user text. A different follow-up creates a different task store entry; unrelated requests
sharing the first 64 characters collide. The installer does not establish a custom
session-header contract. Existing fake requests usually supply `x-session-id`, hiding
the missing real-client guarantee.

Fix: define and test conversation identity for supported client protocols, with explicit
isolation and bounded retention. Test two headerless turns in one conversation and two
independent conversations with identical prompts. This is a pre-existing central contract
gap, not merely a multi-account regression.

### A6. High: Credential persistence and refresh are not concurrency-safe

`packages/proxy/src/accounts.ts:103-133` reads then truncates/writes the store without
atomic replacement or cross-process coordination. UI and standalone CLI can lose each
other's additions. Malformed data is interpreted as an empty store and overwritten on
the next mutation. `oauth.ts:401-418` can concurrently exchange the same rotating refresh
token and write stale results. File creation mode does not tighten an existing file's
permissions.

Fix: validated reads with non-destructive corruption errors, atomic writes, coordination
across processes, and per-credential refresh single-flight with a freshness recheck.
Enforce existing-file permissions. Test simultaneous CLI/UI writes, interrupted writes,
malformed files, two concurrent refreshes, and read-only persistence failures.

### A7. Medium: CLI flags do not implement a resumable PKCE login

`packages/proxy/src/login-cli.ts:89-104` starts a fresh OAuth session even when `--code`
is supplied. A Claude/Google authorization code obtained from an earlier URL belongs to
that URL's verifier, not the newly generated verifier (`oauth.ts:39,92-123`). The mocked
test at `tests/login-cli.test.ts:72-95` accepts any code/session pairing and cannot expose
this. `readStdinCode` rejects piped input, and device polling has no overall deadline.
Uncaught network failures escape the structured error path. Gemini/Antigravity CLI login
now provides Google OAuth for Cloud Code Assist, but it still does not provision the AI
Studio key required for Gemini API-key inference.

`package.json:12` wraps the login script with a build and another npm command but no
explicit inner `--`; option forwarding is not subprocess-tested. Root and proxy now
declare local `auto-router` bins, but the package remains private, so the approved
published `npx auto-router login` interface is not delivered.

Fix: keep interactive completion in one process or explicitly persist/reuse bounded
sessions for non-interactive completion; do not claim a fresh `--code` command works.
Use safe secret input, deadlines/cancellation, provider polling intervals, and sanitized
errors. Test the actual npm entry point without real OAuth/network or credential writes.
Publishing or globally linking a command needs a separate delivery decision.

### A8. Medium: Rate-limited accounts are retried on every new request

`server.ts:1363` recreates `skippedAccounts` per request. `accounts.ts:253-254` always
chooses the first remaining entry, independent of recorded quota or prior success.
After account A returns 429 and B succeeds, the next turn starts with A again. There
is no Retry-After cooldown or session-to-account affinity. Token-string deduplication
also does not identify two logins belonging to the same provider account.

Fix: retain same-model account affinity while eligible, use bounded cooldowns, and
distinguish credential identity from provider account/quota identity. Do not blindly
rotate on transport timeouts. Test repeated turns, cooldown expiry, and repeated login
to the same account.

### A9. Medium: Quota numbers and account presentation can be misleading

`packages/proxy/src/quota.ts:40-44,95-104` guesses that values <=1 are fractions.
Codex `used_percent: 1` therefore renders 100% rather than 1%; null can become zero.
The xAI `/me` fallback at lines 211-217 invents a 0%-used meter without usage evidence.
Provider-level fallback in `server.ts:1160-1161,1197` can give an unsampled primary
another account's quota; request headers replace richer usage windows at lines 1445-1447.

Opaque-token extras have no account identity lookup (`accounts.ts:222-236`) and render
the same provider title (`settings-ui.ts:34-37`). API-key entries are also labeled logged
in by `server.ts:1191-1194`. Multiple cards do not prove multiple identifiable accounts.

Fix: provider-specific units, unknown/error/stale states, no fabricated quota, account-only
sample ownership, and safe labels/source/type. Tests: 0%, 0.5%, 1%, null, missing usage,
two independent account quotas, and opaque-token extras. Verify layout in a browser.

### A10. Medium: Newly connected providers can remain unroutable

Google OAuth now has account-scoped model discovery at a new task boundary, with
capability filtering and a cached fallback when discovery fails; Google API-key routing
bypasses OAuth discovery. The remaining bootstrap-only behavior is for Zen and providers
without a discovery adapter: adding a first credential can still leave excluded models
stale, while OpenAI/Anthropic/xAI are admitted unconditionally even when unusable. The
design's missing-key fallback to a usable inbound model is not implemented by this filter.

Fix: extend the same safe-boundary reconciliation to Zen and other providers without
disturbing existing task locks. Test first login after startup, extra-only availability,
missing-key selection, and recovery after Zen billing exclusion.

### A11. Medium: Installer does not fully meet activation/uninstall promises

`packages/install/src/clients.ts:56-61` writes a Codex provider table but never selects
`model_provider`/a profile, so installation alone need not route Codex traffic. Claude
installation overwrites an existing base URL; uninstall deletes it instead of restoring
the original (`40-52`). OpenCode similarly overwrites/removes a pre-existing
`auto-router` provider (`64-79`). Cursor is manual guidance, not automatic installation.

Fix: explicit activation instructions or an owned profile, plus ownership-aware restore
that never erases subsequent user changes. Test pre-existing configurations, repeated
install/uninstall, and user edits after installation. Do not claim all four clients are
automatically configured by the current installer.

### A12. Medium: Network and stream error paths are insufficiently bounded

`server.ts:59-64,1438-1444` lacks application body limits and upstream abort/deadline
handling. `quota.ts:165-220` and OAuth fetches lack explicit deadlines. CLI device polling
is unbounded (`login-cli.ts:54-67`), and pending OAuth state has no expiry (`oauth.ts:39`).
The top-level HTTP catch (`server.ts:1639-1643`) does nothing after headers have been
sent, leaving stream errors without a defined completion/teardown path.

Fix: bounded requests/poll sessions, cancellation on disconnect, sanitized terminal
errors, and stream teardown. Tests: stalled upstream, stalled usage fetch, expired login,
oversized request, and a reader throwing after response headers.

### A13. Medium: Responses ingress is not translated for chat-only backends

`server.ts:660-665` sends a normalized Chat Completions request for an xAI target, but
sets `translateResponse` only for Anthropic ingress. An OpenAI Responses client routed
to xAI receives the chat envelope rather than a Responses result. This is a pre-existing
protocol matrix gap relevant to the universal-client claim.

Fix: translate all non-native response protocols explicitly. Test Codex Responses to
xAI for text, tools, errors, and streaming, using realistic backend fixtures.

### A14. Medium: Route evidence can be attributed to the wrong request

`server.ts:1339,1448` records completion status into `routeLog[0]`, which can belong to a
newer concurrent request. Zen failover changes `result` after the route row and recorder
selection were captured (`1351-1356,1566-1570`), so evidence may identify the original
provider rather than the one that generated the answer.

Fix: retain a per-request row/reference and record attempted versus final target.
Test out-of-order concurrent completions and Zen fallback attribution. This matters for
both operator diagnosis and trustworthiness of future evaluation data.

## Improvements After Correctness

- Separate management routes, account resolution/refresh, and inference orchestration
  into cohesive modules. `server.ts` is 1648 lines; its handler spans roughly 445 lines.
  Do not keep adding conditional account logic to this handler. No formal McCabe
  measurement was performed; use repository-compatible tooling during a later refactor.
- Replace the positional `primary` flag with explicit source identity and a typed
  credential transport. Reuse eligibility rules instead of maintaining divergent
  primary/extra/environment logic.
- Add explicit account labels and eventually disable/remove controls. Treat removal of
  extras separately from modifying credentials owned by Claude Code or OpenCode.
- Keep the Google OAuth inference branch tied to Cloud Code Assist; remove it only after
  references/public usage are verified.
- Keep observed usage, estimated catalog cost, and subscription entitlements distinct.
  Do not promote a passing mock suite or a login success into a live quality claim.

## Next Delivery Slices

1. A1-A3: secure management, terminating retries, and source-aware refresh.
2. A5-A8: session/account identity, persistence/concurrency, CLI lifecycle, cooldowns.
3. A9-A14: trustworthy quota/evidence, dynamic eligibility, installer safety, bounded IO,
   and protocol completion. Add browser and controlled live acceptance afterwards.

No new provider, classifier training, or broad UI redesign is needed before these
gates. Findings marked resolved above are implemented; remaining fixes are proposed and
this audit is not release approval.
