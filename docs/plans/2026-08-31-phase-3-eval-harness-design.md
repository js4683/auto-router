# Phase 3 Eval Harness Design

## Status

Accepted on 2026-08-31.

## Context

Auto-router needs evidence that task-level routing reduces model cost without materially
reducing answer quality. Unit tests prove routing rules, but they cannot establish the
quality of model outputs. A live-only benchmark can measure output quality, but it is
costly, nondeterministic, and unsuitable as a required local or CI gate.

The eval harness therefore needs two complementary modes:

- Deterministic offline replay for routing, cost, switching, cache, and report regressions.
- Explicitly enabled live generation for deterministic output checks and blinded judging.

The harness must compare the router with always-frontier and always-cheap baselines using
the same sessions, model catalog, price snapshot, and eligibility constraints.

## Decision

Add a separate `packages/eval` workspace that imports `router-core`. Keep evaluation,
recording, live-provider calls, judging, and reporting out of `router-core` so the core
remains harness-agnostic.

Offline replay is the required deterministic gate. Live evaluation is an opt-in higher
confidence gate. A quality-retention claim may use only live results, never the offline
model-quality proxy alone.

## Alternatives Considered

### Offline-only replay

This is deterministic, inexpensive, and suitable for CI, but cannot measure actual model
answer quality. Rejected as the sole evaluation method.

### Live-only benchmark

This measures real outputs, but is expensive, nondeterministic, quota-dependent, and
unsuitable for routine verification. Rejected as the sole evaluation method.

### Layered offline and live evaluation

Offline replay catches deterministic regressions. Opt-in live runs establish output
quality with deterministic checks and blinded judging. Chosen because each layer covers
the other's primary weakness.

## Package Boundary

`packages/eval` owns:

- Versioned recording and dataset schemas.
- Boundary validation for recordings, datasets, provider responses, and judge responses.
- Session replay and router-state progression.
- Always-frontier and always-cheap strategies.
- Cost, quality, switch-count, and cache-impact metrics.
- OpenAI-compatible live generation and judging.
- JSON and Markdown reports.
- Recording primitives and the `curate`, `replay`, and `live` command implementations.

`packages/router-core` continues to own classification, boundary detection, selection,
guards, model metadata used by routing, and `RouterState` semantics.

`packages/proxy` may emit opt-in records, but does not calculate evaluation metrics.

## Data Contracts

Every persisted input and output includes a numeric `schemaVersion`. Version 1 is the
only accepted version initially. Unsupported versions fail validation rather than being
interpreted approximately.

### Dataset

A dataset contains:

- A stable dataset ID and human-readable description.
- A frozen catalog reference and price snapshot.
- One or more sessions.
- Optional default live-runner and judge model aliases without credentials.

Each session contains ordered turns. Each turn has:

- A stable turn ID.
- The `SessionState` snapshot provided to `selectModel`.
- The prior agent and prior message inputs needed by boundary detection.
- Optional recorded messages for live replay.
- Optional observed model and token usage.
- Required terminal state and content-truncation metadata for recorded turns.
- Required hard capabilities derived from the normalized request (`text`, plus `tools`
  when tools or tool calls are present).
- Optional deterministic quality checks and a judge rubric.
- An optional non-negative case weight, defaulting to one.

Catalog runtime IDs are joined to a separate eval price table. Evaluation pricing does
not extend `ModelEntry`, because input, output, cache-read, and cache-write prices are
evaluation concerns and not currently required by routing.

### Usage and pricing

Token usage is represented explicitly:

- Input tokens.
- Output tokens.
- Cache-read input tokens.
- Cache-write input tokens.

Prices are USD per one million tokens for the same four categories. Missing usage or
price data remains missing. It never silently becomes zero.

### Deterministic checks

Version 1 supports bounded data checks only:

- Exact text.
- Required text fragments.
- Parsed JSON equality.
- Expected tool name and arguments.
- Expected terminal state.
- Recorded task outcome.

The harness does not execute model output, shell commands, or arbitrary fixture code.
Executable coding-task sandboxes are outside the initial Phase 3 scope.

### Reports

The machine-readable report includes:

- Dataset and schema versions.
- Strategy results for `router`, `always-frontier`, and `always-cheap`.
- Per-turn selections and reasons.
- Observed and estimated usage and cost, kept separate.
- Deterministic, judge, and composite quality scores.
- Switch counts and cache-impact estimates.
- Failed, skipped, incomplete, and excluded cases with reasons.
- Aggregate metrics, sample size, and confidence intervals where applicable.
- A completeness gate that fails for failed, incomplete, or truncated replay turns.
- Gate results and the thresholds used to calculate them.

The Markdown report is a deterministic presentation of the JSON report. Raw prompts and
model outputs are excluded by default.

## Recording and Curation

Proxy recording is disabled by default. The supported modes are:

- `off`: no evaluation records.
- `metadata`: routing, timing, token usage, and terminal metadata only.
- `content`: metadata plus redacted request and response content.

Content recording requires an explicit setting. Local recording files use restrictive
permissions and a default retention period of 30 days. Expired records are pruned when
the recorder starts.

HTTP headers and environment values are excluded by construction. Content redaction
recursively replaces structured credential keys, including nested objects, and covers
common bearer tokens and provider-key formats, but the command warns that automatic
redaction cannot guarantee anonymity.

The `curate` command validates and redacts a recording into the dataset shape. It does
not imply that the output is safe to commit. Only manually reviewed curated fixtures may
enter version control.

Records use JSON Lines with one turn per line. Writes are serialized within a proxy
process so concurrent requests cannot interleave bytes. Persisted session and turn IDs
are opaque HMAC digests using a process-local secret; caller IDs and prompt-derived
fallbacks are never stored. An interrupted session may lose its active turn but
preserves completed turns. Curation rejects a session whose first recorded turn is not
explicitly marked as a new session.

Recorded usage carries an explicit `provider` or `estimated` source. Proxy token counts
are estimates unless a provider usage envelope is captured; estimated recording usage
must not be aggregated as provider-observed cost. A historical recorded outcome does not
score a newly generated live response because the initial harness does not execute that
response in a task sandbox.

## Replay Strategies

### Router

Replay turns in order through `selectModel`. Preserve `RouterState` and the previous
agent/message inputs across turns. State transitions use the same semantics as an active
adapter; the evaluator does not implement a second routing policy.

### Always-frontier

Choose the highest-coding-index model that satisfies the turn's context-window and
required-capability constraints. Use value as a deterministic tie-breaker.

### Always-cheap

Choose the lowest-cost model that satisfies the same constraints. Prefer lower blended
price, then higher coding index as a deterministic tie-breaker. This baseline does not
apply the router's task-specific quality floor, because it represents a deliberately
cost-minimizing policy.

All strategies use the same frozen catalog and price snapshot. A strategy that has no
eligible model fails that turn; it does not silently use an ineligible model.

## Metrics

### Cost

For each priced usage category:

```text
category cost = tokens * USD per million tokens / 1,000,000
total cost = sum(category costs)
cost saved = 1 - router cost / frontier cost
```

Observed provider usage and counterfactual estimates are reported independently. A gate
cannot mix observed and estimated values without labeling the aggregate as estimated.

### Switches and cache impact

A switch occurs when consecutive turns in the same session use different runtime model
IDs. The first selected model is not a switch.

Observed cache tokens are used when a provider reports them. For counterfactual replay,
a model switch invalidates reusable prefix tokens for that turn. The evaluator reports
the resulting estimated cache-token and dollar difference. It does not present this
estimate as provider-observed behavior.

### Quality

Live cases with deterministic checks use:

```text
composite quality = 0.80 * deterministic score + 0.20 * judge score
```

Open-ended cases without deterministic checks use the judge score. The report always
shows both component scores when both exist.

The judge receives anonymized responses, no model or strategy identity, no credentials,
no tools, a case-specific rubric, and a bounded structured-output request. Judge output
is untrusted and must satisfy the response schema before use.

Aggregate quality is a case-weighted arithmetic mean. Quality retained is:

```text
quality retained = router aggregate quality / frontier aggregate quality
```

A zero-quality frontier result makes the case invalid for retention and is reported as
such. Router scores above the frontier are not capped, so improvements remain visible.

Offline replay may report a clearly labeled model-quality proxy from catalog metadata,
but that proxy cannot satisfy the live quality gate.

## Live Evaluation

The initial live runner targets an OpenAI-compatible endpoint configured entirely by
environment variables and command arguments. Runtime model aliases map dataset model IDs
to provider model IDs. Credentials are never stored in datasets or reports.

Live mode requires `--confirm-live`, applies request timeouts and output-token limits,
and prints the planned case/model call count before execution. A timed-out request is not
automatically retried because its billing outcome is unknown. Provider failures remain
visible as failed cases rather than being replaced with synthetic output.

Every generated response and blinded judge response must have a completed terminal
state before the live case is complete or contributes to the 30-case quality gate. A
missing or unrecognized finish reason or terminal status is incomplete.

The live runner sends recorded transcript context but does not execute tools. Recorded
tool calls and results may remain in the transcript as context.

## CLI

The root workspace exposes:

```bash
npm run eval -- replay --dataset <path>
npm run eval -- live --dataset <path> --confirm-live
npm run eval -- curate --input <recording> --base-dataset <path> --output <dataset>
```

Commands write a JSON report and a concise Markdown report. Invalid input, incomplete
strategy runs, malformed provider output, malformed judge output, and missing required
pricing cause a non-zero exit. Expected exclusions and optional missing observations are
reported but do not become successful zero values.

## Trust Boundaries and Abuse Cases

Trust boundaries are recording input, curated datasets, provider responses, judge
responses, and report rendering.

Primary abuse cases and controls:

- A recording contains credentials: headers are excluded and message content is redacted.
- A recording contains personal or proprietary data: content mode is explicit, local,
  access-restricted, retained for 30 days, and must be reviewed before commit.
- A fixture consumes excessive memory or provider cost: validate size/count limits and
  cap output tokens before processing.
- A model response attempts judge prompt injection: isolate the response as quoted data,
  provide no tools, validate structured output, and retain deterministic checks.
- A model or judge response becomes executable: treat every response as data and never
  pass it to a shell, `eval`, or dynamic module loader.
- A partial live run appears successful: report failures explicitly and fail required
  gates when any required strategy is incomplete.

## Verification Strategy

### Unit tests

- Accept valid version-1 datasets and reject malformed, oversized, and unsupported data.
- Redact bearer tokens and representative provider-key formats.
- Select deterministic frontier and cheap baselines with context constraints.
- Preserve router state across boundaries and sticky follow-up turns.
- Calculate input, output, cache-read, and cache-write costs exactly.
- Count model switches and estimate cache loss across switches.
- Calculate deterministic, judge, composite, and retained quality.
- Reject incomplete prices instead of converting them to zero.
- Escape untrusted report text and omit raw content by default.

### Integration tests

- Replay a curated multi-session fixture into a stable golden JSON report.
- Verify the Markdown report is deterministic for the same JSON report.
- Use a local mock OpenAI-compatible server for generation and judging.
- Cover success, HTTP 429/5xx, timeout, malformed generation, and malformed judge JSON.
- Verify no credential or raw header reaches recordings or reports.

### Repository verification

- Run focused eval tests after each implementation slice.
- Run the root build and all workspace tests.
- Run the package manager's native audit and triage reachable high/critical findings.
- Run an explicitly confirmed real-provider smoke benchmark when quota permits.

## Acceptance Gates

Implementation acceptance requires:

- Byte-for-byte deterministic offline reports for identical inputs.
- Complete router, frontier, and cheap results for every required fixture case.
- Passing package and repository build/tests.
- Passing mock live-runner and security-boundary tests.

Benchmark acceptance requires:

- At least 30 complete live cases.
- Router quality retention of at least 95 percent against always-frontier.
- Router estimated cost at least 50 percent below always-frontier.
- A seeded bootstrap confidence interval included in the report.

The harness may ship before external provider quota permits benchmark acceptance, but
the roadmap quality bar remains unchecked and the report must say that it is unproven.

## Phase 2 Compatibility

Translated paths without an incremental translator request buffered upstream JSON before
synthesizing client-compatible SSE. Regression coverage in
`packages/proxy/tests/server.test.ts` protects this compatibility boundary.

## Consequences

- Routine validation stays deterministic and free of provider dependencies.
- Real quality evidence remains available without making every test run expensive.
- Quality and cost claims expose incomplete data and statistical limits.
- Recordings introduce privacy risk, constrained through opt-in content capture,
  minimization, redaction, local retention, and manual review.
- Versioned contracts make dataset evolution deliberate rather than silently breaking
  historical replays.
- Executable coding-task sandboxes remain future work rather than expanding the initial
  trusted-computing surface.
