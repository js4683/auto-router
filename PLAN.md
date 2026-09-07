# Auto-Router Project Plan

## Purpose

Build a lightweight, harness-aware model router that chooses one appropriate model for
each task/theme rather than changing models on every turn. The router should minimize
cost for routine verification work, reserve high-capability models for planning and
architecture, preserve context-window fit, and avoid prompt-cache thrashing.

This file is the canonical living plan and decision log. Update it whenever routing
policy, integration behavior, scope, or verification evidence changes.

## Current Scope

### Current delivery status (2026-09-06)

Public v1 is the local proxy, client installer, settings dashboard, and shared UI/CLI
provider login. The native OpenCode plugin is optional and is not part of the public
installer. Recent work added extra credentials, per-account cards, same-provider 429
retry, and on-use OAuth refresh. These are implemented happy paths, not a completed
multi-account reliability gate.

The next work is correctness and security hardening, not more providers or training.
See [the code audit](docs/plans/2026-09-06-proxy-account-audit.md) for evidence,
priorities, and regression criteria. This audit updated documentation only; source,
tests, credentials, and the running proxy were not intentionally changed.

Live benchmark acceptance remains unproven and deferred at the user's request.
Phase 4 code exists, but corpus collection, training, and production activation remain
deferred. A successful login does not prove inference, quota accuracy, or failover.

### In scope

- Classify task complexity as `simple`, `medium`, or `complex`.
- Resolve task type from explicit tags, agent mappings, and narrow high-confidence
  inference.
- Discover models from OpenCode's connected providers with a bounded fallback.
- Preserve provider-qualified runtime IDs.
- Select one target model at a confirmed task/theme boundary.
- Hold that target for every message inside the task.
- Prefer free models for routine work when they clear the required quality floor.
- For verification tasks, use a free model first and otherwise the lowest-cost eligible
  model.
- For planning and architecture tasks, use a high quality floor and quality-first
  ordering so Sol, Fable, Opus, or equivalent frontier models win when connected.
- Log `TASK RECOMMEND` when live proof is unavailable and confirm each rewritten message
  through observational `chat.params`.
- Apply the selected target to OpenCode's pending user message; retain the local
  OpenAI/Anthropic-compatible proxy for other harnesses.
- Reconstruct conservative routing signals from normalized request messages, tool
  schemas, and tool-call history.
- Replay versioned datasets against router, always-frontier, and always-cheap strategies.
- Report deterministic cost, quality-proxy, switching, cache-impact, and completeness
  evidence without provider access.
- Support explicitly confirmed live generation and blinded judging without making live
  calls a required local or CI gate.
- Record proxy turns only through disabled-by-default metadata/content modes and require
  manual privacy review after curation.
- Keep unit, integration, build, deployment, and smoke-test evidence current.

### Out of scope

- Per-turn model switching.
- Recursive `opencode models` discovery from inside the plugin.
- Mutating unsupported fields in `chat.params`.
- Competing for the assigned OpenCode `llm.request.before` hook.
- Training a new Avengers-Pro cluster set from scratch in the first proxy slice.
- Hardcoding a single provider as the only source of models.

## Routing Contract

### Task boundaries

A new model decision is allowed only when one of these establishes a task boundary:

- New session.
- Explicit task tag, such as `[task:planning]` or `[task:run_tests]`.
- Active-agent change.
- Compaction or cleared context.
- High-confidence topic shift supported by multiple boundary signals.

Substantive verification instructions beginning with `run` can provide the new-goal
signal when another heuristic corroborates them. Short anaphoric follow-ups such as
`run that again` (including trailing whitespace or punctuation and optional `please`)
remain below the boundary threshold and keep the current task target.

Errors, retries, file growth, and tool depth are complexity signals. They do not switch
models in the middle of a task.

### Task locking

- The first message in a task selects the task target.
- Non-boundary follow-up messages keep that target even if their individual wording looks
  easier or harder.
- A confirmed new task performs a fresh selection immediately.
- Task-level selection must not inherit the old task's downgrade delay. Downgrade delay
  is unnecessary once a new task has been confirmed.

### Verification policy

Verification includes:

- Tests and coverage.
- `no-mistakes`.
- Lint and formatting checks.
- Build and compile checks.
- Typecheck.
- Validate and verify commands.

Selection order:

1. Models that clear the effective quality floor and fit the context.
2. Free eligible models, highest quality first.
3. If no free model is eligible, lowest blended cost first.
4. Quality is the tie-breaker for equal cost.

### Planning and architecture policy

Planning includes architecture, system design, design decisions, trade-off analysis,
and implementation planning.

Selection order:

1. Apply an effective minimum quality of at least `85`.
2. Select the highest-quality eligible connected model.
3. Use value as the tie-breaker.
4. Recognize Sol, Fable, and Opus families as high-capability when live quality metadata
   is unavailable.

Model family names are hints for offline quality inference, not hardcoded provider
requirements. Any connected model with equivalent or better quality may win.

## Architecture

### Router core

`packages/router-core` remains harness-agnostic and owns:

- Complexity classification.
- Task-type resolution.
- Boundary detection.
- Catalog normalization.
- Cost, quality, and context-window policy.
- Provider-qualified target selection.

### OpenCode adapter

`.opencode/plugins/auto-router.ts` owns:

- Mapping OpenCode events to router session state.
- Lazy connected-provider discovery with a 1500 ms fail-open timeout.
- Task target persistence with instance-local live proof.
- Native apply through `chat.message.output.message.model`.
- Observational `chat.params` confirmation and fallback `TASK RECOMMEND` logging.
- Tool, diff, token, and error signal collection.

### Proxy adapter

`packages/proxy` owns:

- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages ingress.
- Conservative `SessionState` reconstruction from the normalized request context.
- Task-target selection and locking through `router-core`.
- Provider routing, credential isolation, and request/response translation.

The proxy estimates full-context tokens from normalized messages and tool schemas. Tool
history contributes tool depth, file and patch hints, and prior-error signals. Signals a
standard API request cannot expose remain at safe zero defaults.

The installed global adapter at
`~/.config/opencode/plugins/auto-router.ts` must stay behaviorally synchronized with the
repository adapter. Its compiled core is deployed under
`~/.config/opencode/plugins/router-core/dist`.

### Historical integration limitation (superseded 2026-09-03)

Before the OpenCode 1.18.27 source audit, the adapter used `chat.params` only for
observation because OpenCode 1.18.25 did not expose a supported provider/model mutation
there. That recommendation-only path and its dependency on an upstream hook are
retained as historical context; the current adapter applies the target through the
mutable `chat.message.output.message.model` seam.

## Configuration Contract

Task policies extend `taskTypeModels`:

```jsonc
{
  "taskTypeModels": {
    "run_tests": {
      "prefer": null,
      "strategy": "lowest-cost"
    },
    "planning": {
      "prefer": null,
      "strategy": "quality",
      "minQuality": 85
    }
  }
}
```

Supported strategies:

- `value`: free first, then best quality-per-cost value.
- `lowest-cost`: free first, then lowest blended cost.
- `quality`: highest quality above the effective floor.

## Implementation Work

### 1. Documentation and decision record

- [x] Create this canonical `PLAN.md`.
- [x] Record task-level, verification-cost, planning-quality, and integration decisions.
- [x] Finish synchronizing `README.md`, `design.md`, and `roadmap.md` with this contract.
- [x] Link all project documentation back to this plan.

### 2. Task policy and classification

- [x] Add `planning` to `TaskType`.
- [x] Add task strategy and optional task quality floor to configuration types.
- [x] Recognize tests, `no-mistakes`, lint, build, typecheck, validate, and verify as
  `run_tests`.
- [x] Recognize planning, architecture, system design, design decisions, and trade-offs
  as `planning`.
- [x] Keep explicit tags and agent mappings highest priority.
- [x] Add red-green regression tests for each task family.

### 3. Cost and high-capability selection

- [x] Apply the greater of the tier quality floor and task policy quality floor.
- [x] Implement `lowest-cost` ordering after free-first filtering.
- [x] Implement quality-first planning selection.
- [x] Add fallback quality inference for Sol, Fable, and Opus families.
- [x] Preserve live provider cost, context limits, and provider-qualified runtime IDs.
- [x] Add red-green selector and catalog tests.

### 4. Task-level adapter locking

  - [x] Store a task target separately from the model OpenCode actually used.
  - [x] Select only on the first task message or a confirmed boundary.
  - [x] Prevent errors and complexity changes from switching targets mid-task.
  - [x] Emit at most one `TASK RECOMMEND` per task when live proof is unavailable.
  - [x] Apply each rewritten message through `chat.message.output.message.model`; keep
    `chat.params` observational and leave its output unchanged.
  - [x] Add red-green plugin integration tests.

### 5. Validation and deployment

  - [x] Run focused tests after each red-green cycle.
  - [x] Run `npm run build && npm test` from the repository root.
  - [x] Clean and deploy `packages/router-core/dist` to the global plugin directory.
  - [x] Smoke-test a verification task against the live provider catalog.
  - [x] Smoke-test a planning/architecture task against the live provider catalog.
  - [x] Verify long corroborated `run` verification instructions can reselect while
    short anaphoric follow-ups remain sticky.
  - [x] Record final test counts and runtime evidence below.

### 6. Proxy apply path

- [x] Add OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages ingress.
- [x] Select and lock one routed target per task.
- [x] Forward requests to OpenAI, OpenCode Zen, Gemini, or Anthropic backends.
- [x] Translate text, tools, terminal states, and client-compatible response envelopes.
- [x] Reconstruct request-derived context, tool, file, diff, and error signals.
- [x] Stream Gemini chat completions and native OpenAI Responses incrementally; request
  buffered upstream JSON before synthesizing SSE for other cross-protocol translations.

### 7. Eval harness

- [x] Add a separate `packages/eval` workspace with versioned, bounded dataset schemas.
- [x] Replay ordered sessions through router, always-frontier, and always-cheap using one
  frozen catalog, price snapshot, capabilities, and context eligibility rules.
- [x] Report deterministic cost, quality proxy, switch, cache-impact, completeness, and
  gate evidence as stable JSON and escaped Markdown.
- [x] Add bounded OpenAI-compatible live generation, deterministic checks, seeded blinded
  judging, and bootstrap confidence intervals behind `--confirm-live`.
- [x] Add opt-in proxy recording with header exclusion, redaction, serialized `0600`
  writes, bounded output capture, retention pruning, and fail-open behavior.
- [x] Add atomic recording curation with schema validation and a mandatory manual-review
  warning.
- [x] Add synthetic fixture/golden reports and mock-provider integration coverage.
- [ ] Pass the external benchmark gate with at least 30 complete live cases, quality
  retention `>= 0.95`, estimated cost savings `>= 0.50`, and a seeded interval.

### 8. Universal proxy and account hardening

- [x] Implement shared UI/CLI OAuth entry points and provider aliases.
- [x] Implement separate extra-account storage and preserve primary credentials on the
  tested add-account path.
- [x] Implement dashboard account cards and same-provider 429 retry for two accounts.
- [x] Implement extra OAuth refresh on requests and quota refresh (not a background job).
- [x] Protect local management routes against foreign origins and reject unexpected
  environment fields (A1).
- [x] Make every retry path terminate, drain 429 bodies, and return after all accounts
  are limited (A2).
- [x] Track credential source explicitly and refresh that store (A3).
- [x] Apply Gemini API-key-only eligibility to extras (A4).
- [x] Keep headerless follow-ups sticky using the first user message (A5).
- [x] Atomically persist extra-account files (A6). Malformed-store preservation and
  chmod of existing files remain open.
- [x] Require `--id` with `--code` and bound device-login polls (A7). Published bin /
  npm forwarding remain open.
- [x] Cool down rate-limited accounts for 5 minutes without changing the model (A8).
- [x] Treat Codex `used_percent` as already-percent and do not invent xAI /me usage (A9).
  Opaque-token labels remain open.
- [x] Include extra Google/Zen credentials in bootstrap catalog eligibility (A10).
  Eligibility is still not recomputed live after connect.
- [x] Set Codex `model_provider` and only uninstall a Claude base URL the installer
  owns (A11).
- [x] Cap management bodies, expire pending OAuth after 15 minutes, bound device polls,
  abort upstream fetches after 120s, and end the response after header-sent errors (A12).
- [x] Translate Responses clients for xAI chat backends (A13).
- [x] Attribute route log status/model to the request row, including Zen failover (A14).
- [ ] Run desktop/mobile dashboard verification and controlled live multi-account
  inference after the above regression gates pass. Do not equate stored tokens with
  distinct provider accounts or independent quota pools.

A1-A14 behavior tests and fixes landed in the proxy/install workspaces. Remaining:
malformed extra-account files, published `auto-router` bin, opaque-token dashboard
labels, live catalog recompute after connect, and the live/browser acceptance gate.

## Acceptance Criteria

- A prompt such as `Run no-mistakes and report failures` resolves to `run_tests` and
  targets a free eligible model, or the lowest-cost eligible paid model if no free model
  is available.
- A prompt such as `Plan the architecture for this project` resolves to `planning`,
  enforces quality `>= 85`, and chooses the highest-quality eligible connected model.
- A non-boundary follow-up message in either task keeps the existing task target.
- A long verification instruction beginning with `run` can establish a new boundary when
  a second heuristic signal corroborates it; short anaphoric `run ... again` follow-ups
  remain sticky.
- A confirmed new task performs one new selection.
- `chat.params` never receives unsupported model mutation fields.
- The task log uses provider-qualified target IDs and distinguishes recommendation from
  actual runtime model.
- Proxy routing uses the complete normalized request context rather than only the latest
  user message.
- Offline eval reports are byte-for-byte deterministic for identical inputs and complete
  all three strategies for every required fixture turn.
- Live quality claims require at least 30 complete cases and cannot use offline catalog
  quality proxies.
- Recorded terminal state, truncation, and hard capabilities remain visible in replay;
  incomplete or truncated records fail the completeness gate.
- Proxy recording remains off by default, never records headers, and curated content is
  not considered commit-safe without manual review.
- Build and all tests pass.
- Repository and installed global plugin behavior match.

## Verification Record

- **2026-09-06, documentation-only code audit:** proxy `npx vitest run` passed 86
  tests in 10 files; proxy `npx tsc -p tsconfig.json --noEmit` passed; installer
  `npx vitest run` passed 2 tests; eval `npx vitest run tests/live.test.ts` passed
  16 tests. These are offline tests, not fresh live-provider or browser evidence.
  No build, dependency audit, full monorepo suite, commit, or proxy restart was run.
  Findings A1-A14 remain open despite the passing tests.

- **2026-08-29, existing baseline:** `npm run build` passed.
- **2026-08-29, existing baseline:** 6 Vitest files and 37 tests passed.
- **2026-08-29, existing baseline:** live provider discovery returned a `live` catalog
  and selected `opencode/muse-spark-1.2-contributor-free` for a simple task.
- **2026-08-29, existing baseline:** a fresh OpenAI run logged a Muse recommendation
  while OpenCode correctly kept the requested OpenAI model unchanged.
- **2026-08-29, after task-level lock:** `npm run build && npm test` — 7 files, 49 tests passed.
- **2026-08-29, verification smoke:** `run no-mistakes...` → `TASK SELECT taskType=run_tests via=free-first source=live target=opencode/muse-spark-1.2-contributor-free`. Six later stream calls produced one `TASK RECOMMEND` only.
- **2026-08-29, planning smoke (stale config):** first run classified `planning` but selected `via=free-first` because global inline `opencode.json` lacked the planning policy.
- **2026-08-29, planning smoke (after merge):** `plan the architecture...` → `TASK SELECT taskType=planning via=quality source=live target=openai/gpt-5.6-sol` and one `TASK RECOMMEND` from Muse.
- **2026-08-30, Avengers-Pro + proxy:** `npm test` — 10 files, 58 tests passed (9 core + 1 proxy).
- **2026-08-31, proxy request state:** `npm run build && npm test` — 10 files,
  81 tests passed (56 core + 25 proxy).
- **2026-08-31, proxy streaming:** `npm test` — 10 files, 84 tests passed (56 core + 28 proxy, including incremental Gemini and native Responses streaming); live smoke on :8791 with `openai/gpt-4o-mini` via OpenRouter — `stream:true` chat and responses both incremental (first chunk <50% total, e.g., 472 ms / 1071 ms).
- **2026-09-01, Phase 3 eval harness:** `npm run build && npm test` passed 22 files
  and 166 tests (71 eval + 38 proxy + 57 core); `npm audit --audit-level=high` found
  zero vulnerabilities. Two offline replays matched each other and the checked-in
  golden reports byte-for-byte: JSON SHA-256
  `31b58f71b360d950516305e0b412cbe9c7214781742b27cd35b8d6e754ab5e09`, Markdown
  SHA-256 `5f75240b793d45e3e98dcca9f55e85ac54cdf5c068fb613f1d30511cb3119e26`.
  External benchmark acceptance remains unproven pending a complete 30-case live run.
- **2026-09-03, native OpenCode apply:** `npm test` passed all 344 tests,
  `npm run build` passed for all workspaces, and `git diff --check` was clean.
  Stock OpenCode 1.18.27 loaded the globally deployed plugin and connected-provider
  catalog without an Auto-Router proxy or injected provider credentials.
- **2026-09-03, attached multi-task smoke:** a planning turn submitted as
  `opencode/muse-spark-1.3-contributor-free` selected, applied, streamed, and persisted
  as `openai/gpt-5.6-sol`. A `[task:run_tests]` boundary then selected, streamed, and
  persisted as `opencode/muse-spark-1.3-contributor-free`.
- **2026-09-03, sticky apply smoke:** an untagged follow-up deliberately submitted as
  `openai/gpt-5.6-sol` emitted no new `TASK SELECT`, logged
  `TASK APPLY opencode/muse-spark-1.3-contributor-free`, and streamed and persisted on
  that held target. `opencode export ses_f973afb18ffeND36o1JTbs7eT7 --sanitize`
  confirmed all three user and assistant model assignments.
- **2026-09-03, Zen live eval transport:** eval live mode accepts `liveTransportDefault`
  and per-runtime `liveTransports`, posts Muse/GPT-class calls to `/responses`, and
  keeps `/chat/completions` as the default. `npm test --workspace=@auto-router/eval`
  passed 143 tests.
- **2026-09-03, Zen live dataset replay:** local ignored
  `phase-3-zen-live.eval-dataset.local.json` (30 turns) replayed complete. Verification
  selected Muse, planning selected Sol, sticky follow-ups used `stay-sticky`. Planned
  live calls are 90 generation + 30 judge. Phase 4 corpus remains deferred.
- **2026-09-03, Zen free-only live run:** paid Sol/Luna returned `CreditsError` (no
  payment method). Reran locally with Muse (Responses) + Nemotron 3.5 Lightning Free
  (chat) + Muse judge, `MAX_OUTPUT_TOKENS=4096`. Report
  `phase-3-zen-live-free.live.eval-report.local.json`: 24/30 complete live cases,
   router judge quality 0.873, live quality gate failed (`requires at least 30 complete
   live cases`). Six incomplete cases were Muse incomplete output, missing judge
   content, or Nemotron timeout. No dataset or report was committed.
- **2026-09-05, subscription live eval:** proxy live run against Grok, Claude, and
  ChatGPT completed 14/30 cases (16× HTTP 429). Replay estimated cost savings 60%.
  Live quality gate left unchecked. Dataset and report remain local/gitignored.

## Decision Log

- **2026-09-06:** Support both dashboard and terminal login through shared provider
  flows and credential storage. Preserve the user's primary login when adding another
  credential. The current CLI is an npm workspace command, not a published
  `npx auto-router` binary; a fresh `--code` invocation does not preserve PKCE state.
- **2026-09-06:** Separate task/model stickiness from account failover. A confirmed 429
  may try another eligible credential for the same provider/model; account cooldown and
  stable selection still require implementation. Zen billing failover is the previously
  approved narrow provider-switch exception, not permission for arbitrary per-turn
  model switching.
- **2026-09-06:** Treat multi-account/login as partially complete until the audit gates
  pass. Keep live quality claims and Phase 4 activation deferred. Reconfirm native-plugin
  deployment parity only when that optional integration is changed, not as a prerequisite
  for unrelated public-proxy account work.

- **2026-08-29:** Use task/theme-level routing. Per-turn routing is rejected because it
  harms cache reuse and task coherence.
- **2026-08-29:** Use existing boundary signals plus explicit task tags. Do not require
  tags for every task, but keep heuristic boundaries confidence-gated.
- **2026-08-29:** Treat tests, `no-mistakes`, lint, build, typecheck, validate, and verify
  as verification work.
- **2026-08-29:** Verification uses free-first selection, then strict lowest blended
  cost among eligible paid models.
- **2026-08-29:** Planning and architecture use quality-first selection with a minimum
  quality of `85`, favoring Sol/Fable/Opus-class models when connected.
- **2026-08-29:** A confirmed new task may downgrade immediately; no old-task downgrade
  counter carries across task boundaries.
- **2026-08-29:** Errors and hard signals do not change the model during a task. They are
  recorded as complexity evidence for the next confirmed boundary.
- **2026-08-29:** Never call `opencode models` from the plugin; use
  `client.provider.list({ query: { directory } })` with a timeout and fallback.
- **2026-08-29:** Do not mutate unsupported `chat.params` fields. Log a one-shot task
  recommendation until OpenCode exposes a supported model-routing hook.
- **2026-08-29:** Keep implementation inline for this lightweight, tightly coupled
  change. Subagents are unnecessary unless an independent final review is requested.
- **2026-08-29:** `loadConfig` must deep-merge user/global configs over defaults. Stale
  configs that omit new `taskTypeModels` keys otherwise silently drop planning/verification
  policy.
- **2026-08-30:** Do not implement the assigned OpenCode hook. The local proxy is the
  apply path for OpenCode and every other harness that can set a base URL.
- **2026-08-30:** When enabled, Avengers-Pro scores the first message of a task. Overlap
  models join through LLMRouterBench (`source: "bench"`). Muse / Grok / Luna-class IDs
  use an explicit `source: "hand"` bootstrap until we have our own labels.
- **2026-08-31:** Proxy `SessionState` uses the normalized message and tool payload for a
  conservative context estimate. Standard tool-call arguments provide tool-depth,
  file, patch-hunk, and prior-error hints; unavailable harness signals stay at zero.
- **2026-08-31:** Proxy streams Gemini Chat translation and native OpenAI Responses as
  upstream SSE arrives. Cross-protocol paths without an incremental translator request
  buffered upstream JSON before synthesizing the downstream event stream.
- **2026-08-31:** Required eval validation is deterministic offline replay. Live
  generation and blinded judging are opt-in and explicitly confirmed; only complete live
  cases can support a quality-retention claim.
- **2026-08-31:** All replay strategies share one frozen catalog, price snapshot,
  capabilities, and context eligibility constraints. Always-cheap intentionally omits
  router task-quality floors while still respecting hard eligibility.
- **2026-08-31:** Proxy recording is disabled by default. Content mode is explicit,
  local, bounded, redacted, access-restricted, retention-limited, and never considered
  safe to commit without manual review.
- **2026-09-01:** The Phase 4 Tier-1 embedding architecture is approved as opt-in;
  the checked-in fixture path remains disabled by default and fails open to Tier 0;
  production activation requires the held-out validation gate.
- **2026-09-03:** Substantive `run` verification instructions may establish a boundary
  when corroborated; short anaphoric `run that/this/it again` follow-ups remain sticky.
- **2026-09-04:** Proxy credentials prefer provider login (`auth.json`, Claude Code
  file), then settings `.env`. Gemini is the exception: use `GEMINI_API_KEY` / AI Studio
  key only; Google OAuth access tokens are never sent to the Gemini API. Multi-provider;
  Cursor Pro unused. Live eval may call the same proxy.
- **2026-09-04:** Public apply path is the local proxy plus an installer (Claude Code,
  Codex, Cursor, OpenCode) and a loopback settings UI with in-browser connect. Task
  stickiness and fail-open stay. The OpenCode plugin in `.opencode/plugins` is optional
  native apply. No Postgres or `rk_` keys in v1.
- **2026-09-05:** Include OpenCode Zen in the proxy catalog only when a Zen credential
  exists, and fail over to another provider on Zen billing errors. Codex uses
  `wire_api = "responses"`. Anthropic ingress accepts `/messages` and `/v1/messages`.
- **2026-09-03:** Supersede the recommendation-only OpenCode decisions above after a
  source audit of OpenCode 1.18.27. The existing mutable
  `chat.message.output.message.model` seam applies a complete request before provider,
  auth, and request preparation. `chat.params` remains observation-only; no OpenCode
  patch or upstream hook is required for user-message routing.
- [x] Phase 4 code complete
- [ ] real observed-outcome corpus collected
- [ ] production artifact trained
- [ ] production artifact activation gate passed

## Supporting Documents

- `docs/plans/2026-09-06-proxy-account-audit.md`: current code findings, proposed fixes,
  regression gates, and verification limits for the public proxy/account work.

- `design.md`: architecture rationale and selection model.
- `roadmap.md`: broader project phases and implementation status.
- `docs/plans/2026-08-31-phase-3-eval-harness-design.md`: accepted eval architecture,
  data contracts, trust boundaries, and acceptance gates.
- `docs/plans/2026-09-03-phase-3-zen-live-eval-design.md`: Zen Responses live transport,
  local 30-turn dataset, and deferred Phase 4 corpus.
- `docs/plans/2026-09-01-phase-4-embedding-classifier-design.md`: approved Tier-1
  embedding architecture, privacy boundaries, and activation gates.
- `docs/plans/2026-09-03-opencode-apply-path-design.md`: audited native OpenCode apply
  lifecycle, live-provider proof, and fail-open behavior.
- `docs/plans/2026-09-04-universal-proxy-installer-design.md`: public v1 proxy, installer,
  and loopback settings UI.
