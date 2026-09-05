# Phase 3 Zen Live Eval Design

**Status:** Approved in design review on 2026-09-03
**Implementation status:** Responses transport and local 30-turn dataset are implemented. Offline replay is complete. Confirmed Zen `--confirm-live` run is pending an eval API key. Phase 4 remains deferred.
**Scope:** OpenAI Responses transport in `packages/eval` live mode, a local 30-turn Zen dataset, and one confirmed live run. Phase 4 corpus, training, and activation are out of scope.
**Canonical project plan:** [PLAN.md](../../PLAN.md)
**Prior eval contract:** [2026-08-31-phase-3-eval-harness-design.md](./2026-08-31-phase-3-eval-harness-design.md)

## Objective

Run the existing Phase 3 live benchmark against OpenCode Zen using Muse as the cheap/free model, GPT 5.6 Sol as frontier, and GPT 5.6 Luna as judge. The current live runner only posts to `{baseUrl}/chat/completions`. Zen GPT and Muse require `{baseUrl}/responses`. This slice adds that transport, authors 30 non-confidential local cases, and records a live report. The 0.95 quality / 0.50 cost gates are measured, not required to pass.

## Assumptions

1. `AUTO_ROUTER_EVAL_BASE_URL` is `https://opencode.ai/zen/v1` with no credentials, query, or fragment.
2. Auth uses the existing eval key env (`AUTO_ROUTER_EVAL_API_KEY`), populated from a Zen API key.
3. Dataset prompts contain no secrets, personal data, or proprietary code. Muse contributor-free may use prompts for training.
4. The 30-case dataset and live reports stay local (`0600`, gitignored). They are not commit-safe without a later privacy review.
5. Phase 4 collection remains deferred until a larger held-out corpus exists.

## Tech Stack

- TypeScript in `packages/eval`
- Native `fetch`
- OpenCode Zen Responses API for Muse and GPT-class models
- Existing chat-completions client unchanged for other models

## Commands

```bash
npm test --workspace=@auto-router/eval
npm run build --workspace=@auto-router/eval
npm run eval -- replay --dataset path/to/phase-3-zen-live.local.json
AUTO_ROUTER_EVAL_BASE_URL=https://opencode.ai/zen/v1 \
AUTO_ROUTER_EVAL_API_KEY=... \
AUTO_ROUTER_EVAL_JUDGE_MODEL=gpt-5.6-luna \
npm run eval -- live --dataset path/to/phase-3-zen-live.local.json --confirm-live
```

## Project Structure

- `packages/eval/src/live.ts` — live orchestration
- `packages/eval/src/types.ts` / `schema.ts` — optional `liveTransports`
- `packages/eval/tests/live.test.ts` / `live-eval.test.ts` — transport and mock coverage
- Local ignored dataset and reports — not under `packages/eval/fixtures/`

## Architecture

`packages/eval` remains the only live caller. Do not import `packages/proxy`. Add a thin Responses client beside the chat-completions client.

Each catalog runtime id already maps through `liveModelAliases` to a Zen model id.
Add optional `liveTransportDefault: "responses" | "chat"` (default `chat`) and optional
`liveTransports: Record<string, "responses" | "chat">` keyed by catalog runtime ids.
Alias lookups use the per-id transport when present, otherwise the dataset default.
The judge call uses `liveTransportDefault` because the judge model comes from
`AUTO_ROUTER_EVAL_JUDGE_MODEL`, not the catalog. This run sets
`liveTransportDefault` to `responses`. `schemaVersion` stays 1.

Frozen catalog for this run:

| Role | Catalog runtime id | Zen model id | Transport | Price (input/output per 1M, ≤272K) |
|------|--------------------|--------------|-----------|-------------------------------------|
| Cheap / free | `opencode/muse-spark-1.3-contributor-free` | `muse-spark-1.3-contributor-free` | `responses` | $0 / $0 |
| Frontier | `opencode/gpt-5.6-sol` | `gpt-5.6-sol` | `responses` | $2 / $10 |
| Judge | n/a | `gpt-5.6-luna` | `responses` | $0.20 / $1.20 |

Router selection uses the frozen catalog and existing task policies. Always-frontier and always-cheap use the catalog extrema. Live generation uses the alias + transport for the selected runtime id.

## Data Flow

1. Validate and offline-replay the dataset. Incomplete replay fails before any billable call.
2. Print planned calls: 90 generation + 30 judge.
3. For each turn, generate router, always-frontier, and always-cheap outputs.
4. Responses requests send conversation `input` derived from `turn.messages`. Parse `output_text` (or equivalent output items) and usage. Chat requests keep the current `/chat/completions` path.
5. One blinded judge call per complete triple, JSON object scores, Luna via Responses.
6. Write `*.live.eval-report.local.json` and `.md` with mode `0600`. Reports include IDs, metrics, gates, and reasons. No prompt text, model responses, or credentials.

## Failure Modes

| Condition | Behavior |
|-----------|----------|
| Timeout or unknown billing outcome | Do not retry. Mark the case incomplete. |
| Truncation, empty output, or non-stop finish | Case incomplete. |
| Missing alias | Fail that selection; do not guess a model id. |
| Missing transport | Default to `chat`. |
| Transport/HTTP error | Fail that model call; continue other strategies in the case when possible; case incomplete if any required strategy fails. |
| Judge parse failure | Case incomplete. |
| Fewer than 30 complete live cases | Quality gate fails with the existing reason. Process still writes the report. |

## Dataset

Thirty turns across sessions, locally authored:

- 10 verification (`run_tests` / no-mistakes / lint / typecheck style)
- 10 planning / architecture
- 10 sticky follow-ups after an implement or verification lock

Each turn has `messages`, a `judgeRubric`, and may include deterministic checks. No secrets. Sticky turns must keep the prior task target under existing boundary rules.

## Testing Strategy

Mock both `/responses` and `/chat/completions`. Cover:

- Alias plus transport selection per model
- Responses input/output/usage mapping
- Chat path unchanged when transport is `chat` or omitted
- Timeout with no retry
- Existing live plan of 3 generations + 1 judge per case
- Quality gate still requires 30 complete cases

Do not call Zen from unit tests or CI.

## Boundaries

- Always: fail open on live errors; print planned call counts; keep reports local `0600`; keep unit tests provider-free.
- Ask first: committing any dataset or live report; changing judge/frontier/cheap ids; enabling Phase 4 collection.
- Never: import proxy into eval; put credentials in datasets; retry timed-out billable calls; claim the 0.95/0.50 bar without a 30-complete-case live report.

## Success Criteria

- Focused eval tests and `npm run build --workspace=@auto-router/eval` pass.
- `planLiveEvaluation` reports 90 generation and 30 judge calls for the 30-turn dataset.
- A `--confirm-live` Zen run writes a local report with completeness and quality/cost gates filled in.
- Phase 4 corpus, training, and activation remain unchecked.

## Open Questions

None. Phase 4 corpus is explicitly deferred.
