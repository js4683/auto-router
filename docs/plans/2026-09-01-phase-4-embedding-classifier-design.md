# Phase 4 Tier-1 Embedding Classifier Design

**Status:** Approved in design review on 2026-09-01
**Implementation status:** Phase 4 code and the OpenAI OAuth production experiment are
complete: the shared `router-core` embedding boundary, observed-outcome collection,
artifact building, held-out validation, and opt-in runtime wiring are implemented. The
80-row production corpus and eligible artifact remain local/ignored; the checked-in
default stays disabled after local digest-bound activation verification.
**Scope:** End-to-end observed-outcome training, artifact validation, and opt-in runtime inference
**Canonical project plan:** [PLAN.md](../../PLAN.md)

## Execution Handoff (2026-09-07)

The user requires **both real coding tasks and a public coding benchmark**, with
**Luna subagents at maximum reasoning**. Verify the configured model and reasoning
controls before delegation; report a blocker and ask before substituting. Assign
disjoint ownership for dataset/provenance, pipeline correctness, and independent
validation. One coordinator owns the frozen experiment, live budget, and activation.
Do not claim unsupported model settings. This handoff update performs no collection,
training, live calls, or activation.

### Dataset and split

- Inventory only user-authorized task sources. Review/redact private prompts, code,
  paths, secrets, and transcripts before generation, judging, or embedding. Do not
  scrape unrelated repositories/logs or assume permission to transmit private content.
- Select a licensed public benchmark and pin name, version, source URL, original item
  IDs, attribution, and known contamination limitations. Preserve original tests.
  Generated paraphrases are not independent evidence. Keep reference answers/tests out
  of generation and embedding inputs. Sandbox executable checks without credentials,
  network, or host writes.
- Freeze a justified real/public source mix and task/language/difficulty coverage; no
  percentage has been approved. Require both sources in both train and held-out splits
  and report counts and performance separately as well as in aggregate.
- Deduplicate across sources and group related sessions/issues/variants before splitting.
  Related examples must share a session group. Record source/group mapping and review
  decisions locally using schema-supported metadata or an ignored machine-readable
  manifest, not a new process document.
- Use the implemented `splitAvengersCorpus` to calculate exact counts before observing
  outcomes. A 0.2 held-out ratio with 150 examples does not guarantee 30 held-out cases.
  Require >=30 held-out examples plus meaningful independent training coverage. Never
  search for a favorable seed, drop difficult cases, or tune on held-out results.
- Freeze candidate runtime/canonical identities, catalog, capabilities, dated token
  prices, mappings, checks/rubrics, judge, split parameters, cluster settings, and timeout.
  Use distinct actual models; do not reuse Phase 3's Gemini-priced Grok/Claude aliases
  as faithful production pricing. Disclose candidate-as-judge bias if retained.

### Preflight and budget

Use the pure `readDataset`, `planAvengersCollection`, and `splitAvengersCorpus` interfaces
for offline preflight; the CLI has no collection `--dry-run`. Verify relevant offline
tests before live work. Do not assume prior audit completion statements prove readiness.

A 60-example/two-candidate pilot with a verified 30/30 split requires up to 120 generation
calls, 60 judge calls, one training batch of 30 short embedding inputs, and 30 held-out
single-item embedding calls: up to 211 requests, excluding probes. A one-cluster pilot
tests mechanics/global ranking, not task-specific learned routing. Production size and
cluster count must be justified by coverage and per-cluster observations; do not weaken
minimum observations or activation thresholds to fit this pilot.

For N examples, M candidates, J rubric-scored examples, T training examples, and H
held-out examples: budget N*M generations, up to J judges, training batches within
128-item/1-MiB input limits, and H fresh validation embedding requests. Include prompt,
output/reasoning, judge, and embedding costs, not only candidate generation. Subscription
access proves neither zero marginal cost nor available quota. Present bounded token/dollar
estimates and confirm the concrete live-call budget before execution. Do not automatically
retry timeouts whose billing outcome is unknown.

Configure these variables without printing their values:

```text
AUTO_ROUTER_EVAL_BASE_URL
AUTO_ROUTER_EVAL_API_KEY
AUTO_ROUTER_EVAL_JUDGE_MODEL
AUTO_ROUTER_EVAL_TIMEOUT_MS
AUTO_ROUTER_EVAL_MAX_OUTPUT_TOKENS
AUTO_ROUTER_EVAL_RETRY_MAX_ATTEMPTS
AUTO_ROUTER_EVAL_RETRY_BASE_DELAY_MS
AUTO_ROUTER_EVAL_RETRY_MAX_DELAY_MS
AUTO_ROUTER_UPSTREAM_TIMEOUT_MS
AUTO_ROUTER_EMBEDDING_BASE_URL
AUTO_ROUTER_EMBEDDING_API_KEY
AUTO_ROUTER_EMBEDDING_MODEL
```

Verify a separate OpenAI-compatible embeddings endpoint/model, authentication, dimensions,
limits, and realistic latency with approved probes. Do not assume the local proxy or a
subscription login supports embeddings. Use the same embedding endpoint/model and
normalization in training, validation, and runtime; use a fresh cache when changing the
endpoint. The example 400-ms deployment timeout is not permission to inflate latency
thresholds until validation passes; resolve product tradeoffs explicitly.

### Source-visible hazards and resolutions

- `avengers-collection.ts` uses Chat Completions and does not inherit Phase 3 transport
  overrides. The production models were verified on that transport. The collection CLI
  now opts into bounded retries for 429/502/503/504 and honors structured provider delay
  metadata; explicit per-day quota exhaustion fails immediately. Library callers retain
  single-attempt behavior unless they opt in. Timeouts are never retried because their
  billing outcome is ambiguous.
- The loopback proxy's external-request deadline defaults to 120,000 milliseconds and accepts
  the bounded `AUTO_ROUTER_UPSTREAM_TIMEOUT_MS` override from 1 through 600,000 milliseconds
  (10 minutes). This is useful for slow OAuth-backed model completions but does not change
  the no-timeout-retry rule.
- Collection refuses an existing output and has no resume flag. A judge exception can
  abort after billed generation; retain partial results and explicitly reconcile missing
  outcomes without silently repeating calls or cherry-picking successful cases.
- Cost needs returned usage and a matching runtime-keyed dataset price. Catalog-derived
  cost is not an observed invoice; document estimates and classifier overhead separately.
- Curation now binds every row to the supplied dataset, exact aliases, and runtime IDs,
  rejects unknown/duplicate/missing examples, and rejects explicit unjudged records.
- Incomplete sibling generations can skip judging. Do not accept a rubric-only completed
  answer as deterministically scored zero without meaningful check evidence.
- Training options are validated before billable embedding requests. Inspect and test
  affected code paths rather than assuming the Phase 3 passing report validates Phase 4
  mechanics.

### Execution and acceptance

Use the collect/curate/train/validate commands already documented below; replace example
paths/settings with the frozen experiment. Actual flags are defined in
`packages/eval/src/avengers-cli.ts`. Keep private outputs ignored, for example
`phase-4-collection.local.jsonl`, `phase-4-corpus.local.json`,
`phase-4-embeddings.local.json`, and `phase-4-validation.local.json`/`.md`.
Use `.cache/phase-4-artifact` for local production artifacts and verify ignore coverage
for any alternate paths. Archive prior evidence instead of overwriting it. Never commit
private text, responses, or individual embeddings.

Train only on the training partition; verify deterministic artifact bytes using frozen
inputs and cached vectors. Validate using fresh held-out single-item embeddings at the
intended deployment timeout. Keep all gates below intact, including completeness,
nonsynthetic provenance, mapping, >=0.95 retention, >=0.50 model-cost savings, no Tier-0
quality/cost regression, seeded uncertainty, and latency. Current uncertainty validation
checks interval presence, not a confidence-bound threshold; report the actual interval.
Check unselected-candidate failures and separate source-cohort results explicitly rather
than overinterpreting aggregate eligibility. Further tuning needs an untouched holdout.

Only eligible manifests bound to the exact artifact and deployment endpoint can activate
Tier 1. Preserve checked-in `enabled: false`; use authorized local configuration for
rollout. Verify boundary-only embeddings, explicit force-header bypass, sticky turns,
timeout/429/bad-vector fallback, and rollback by disabling Tier 1 and restarting. If
data, provider compatibility, budget, or validation blocks activation, leave it disabled
and report the exact blocker.

Update existing PLAN.md, roadmap.md, and this spec with actual commands, source/split
counts, digests, metrics, checks, limitations, and activation state. Publication and Git
delivery require their own authorization and the required repository gate. Completion
means reviewed mixed corpus, trained production artifact, passing held-out evidence,
and verified authorized activation, not just a successful training command.

## Production Freeze And Current Blocker (2026-09-07)

### Frozen experiment

- Dataset ID `phase-4-production-v1` has 80 examples in 57 leakage groups: 51 HumanEval
  items and 29 tasks reconstructed from this repository's public history. Real-task
  commits are bounded to at most 250 changed lines and four source files. Related commits
  share a feature-family group.
- HumanEval is pinned to commit `6d43fb980f9fee3c892a914eda09951f772ad10d` under
  MIT. Archive SHA-256 is
  `b796127e635a67f93fb35c04f4cb03cf06f38c8072ee7cee8833d7bee06979ef`;
  license SHA-256 is
  `bcba3de214851cce46ed5af42d6698044616eeace887c3231bc7a20474ab639e`.
  Original tests and canonical solutions are retained locally for judging but excluded
  from candidate and embedding inputs.
- Seed `phase4-production-v1`, held-out ratio `0.5`, was fixed before outcomes. The exact
  split is 45 training examples (25 public, 20 real) and 35 held-out examples (26 public,
  9 real). Validation found no group overlap, duplicate prompt hash, reference leakage,
  or static API-key pattern.
- Candidates are `paper/cheap=gemini-3.1-flash-lite` and
  `paper/frontier=gemini-3.6-flash`; the distinct blinded judge is
  `gemini-3.8-flash`. Official standard prices through 2026-12-31 are $0.25/$1.50 per
  million input/output tokens for cheap and $0.75/$3.75 for frontier and judge. Artificial
  Analysis Intelligence Index values 16 and 34 are mapped into the legacy catalog
  `codingIndex` field; the source pages did not expose a separate Coding Index.
- `gemini-embedding-001` is fixed at 3072 dimensions. Official input limit is 2,048
  tokens, so training text is capped at 6,000 characters. Paid text input is $0.15 per
  million tokens; free tier is free of charge.
- Offline validation reported 80 unique prompts, maximum prompt size 10,992 characters,
  and approximately 37,802 prompt tokens. Planned live work is 160 candidate generations,
  80 batched blinded judgments, one training embedding batch for 45 examples, and 35
  held-out embedding calls. The conservative candidate/judge bound is $2.54 at a 4,096
  output-token cap; bounded embedding input adds less than $0.02 at paid pricing.
- Local ignored artifacts are `phase-4-production.eval-dataset.local.json`,
  `phase-4-production-source-manifest.local.json`, and
  `.cache/phase-4-human-eval-source.local.json`. They are mode 0600. Publication remains
  unauthorized.

### Collection evidence and blocker

- A one-example smoke run completed both candidates and one blinded judgment. Both
  outcomes scored 1.0; provider-reported candidate costs were $0.000318 for cheap and
  $0.004155 for frontier.
- `.cache/phase-4-production.collection.local.jsonl` is rejected operational evidence.
  The pre-hardening collector wrote 80 rows and exited zero despite 62 cheap 429s, two
  cheap 503s, 79 frontier 429s, one frontier 503, and zero judgments.
- `.cache/phase-4-production-retry1.collection.local.jsonl` is also rejected. With the
  corrected retry/failure behavior, its first case completed and was judged; the second
  durably recorded the cheap output plus a frontier 429 and then exited non-zero. The
  smoke and retry files overlap on the first example, so there is only one unique complete
  production pair, not two.
- `.cache/phase-4-production-retry2.collection.local.jsonl` is a rejected one-row partial
  from the requested paid-tier retry: cheap completed, frontier returned the same free-tier
  429, and collection stopped before judging. After a ten-minute propagation wait, one
  minimal frontier probe returned 200 but an immediate second probe again returned the
  free-tier quota ID. The configured key therefore has not demonstrated paid-tier quota.
- Gemini returned quota metric
  `generativelanguage.googleapis.com/generate_content_free_tier_requests`, quota ID
  `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, value 20 for
  `gemini-3.6-flash`. Official rate-limit documentation says RPD resets at midnight
  Pacific. The pricing page marks Batch unavailable on this model's free tier.
- Completing this fixed Gemini experiment still requires either a paid-tier Gemini project
  with sufficient quota or collection across multiple daily reset windows. Do not change
  its candidates, seed, split, or drop blocked examples. Do not combine its partial rows.
- The separate OpenAI OAuth experiment completed the same reviewed 80-case task corpus;
  its production curation, embedding cache, artifact, held-out validation, and local
  activation evidence are recorded in the OpenAI completion section below. Tier 1 remains
  disabled in the checked-in configuration.

## Live Attempt And Recovery (2026-09-07)

This section supersedes earlier conversation claims that the pilot was production-ready,
that its dollar estimate was verified, or that cooldown proved an RPM-only limit.
Collection was attempted inline. **Production curation, training, validation, and
activation are still pending. Do not train on a success-only subset of this attempt.**
The prior Luna/max-reasoning delegation requirement above was not verified or exercised;
confirm the next execution mode rather than claiming it was satisfied.

### Experiment actually attempted

- Local root: `phase-4.eval-dataset.local.json`, ID `phase-4-pilot-v1`, 60 independent
  single-turn sessions: HumanEval/0 through /29 plus `original-001` through `original-030`.
- HumanEval was fetched from `https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz`.
  The generator used prompts, not canonical solutions or hidden tests. The source was
  NOT commit-pinned; the MIT license/attribution must be verified and preserved before reuse.
  Original benchmark tests were downloaded but not executed in a sandbox.
- The 30 original prompts were newly authored, not sourced from authorized real task
  histories. They do NOT establish the required real-task cohort. Do not relabel them.
- Seed `4683`, ratio `0.5`: original pre-outcome calculation reported 29 training
  (17 public, 12 original) and 31 held-out (13 public, 18 original). This calculation
  used a Python reproduction; recheck with `splitAvengersCorpus` before accepting it.
  Later remainder files are retry queues, NOT new experimental partitions.
- Direct Chat Completions base: `https://generativelanguage.googleapis.com/v1beta/openai`.
  Aliases: `paper/cheap=gemini-3.5-flash,paper/frontier=gemini-3.6-flash`.
  Judge: `gemini-3.1-flash-lite`; timeout 120000 ms. Output cap changed from 1024
  to 4096 after truncated outputs. This is an unfrozen protocol change, not comparable
  production evidence. Judge calibration has not been established.
- Embedding probe: `gemini-embedding-001` at the same base returned 3072 dimensions;
  index zero was omitted while later indices were explicit. No production cache,
  latency measurement, trained artifact, or held-out validation was produced.
- Dataset token rates ($/million input/output) were manually set to 0.15/0.60 for
  cheap and 0.30/2.50 for frontier after the pricing-page fetch failed. The manifest
  explicitly says rates were differentiated by hand. **These are unsupported prices;
  do not use them for cost savings, a budget estimate, or activation.** Catalog quality
  scores 72/90 and blended prices 0.3/1.5 also lack verified provenance.
- The stated ~$1-2 budget was not substantiated or concretely confirmed. Reconcile
  provider usage/billing, all probes, retries, reasoning and judge costs before further
  paid work. Returned `total_tokens` exceeded prompt plus completion tokens in probes;
  current accounting must be checked for omitted billable reasoning tokens.

### Local evidence inventory

All paths below are relative to the repository and must remain private, ignored, and
mode 0600. Verify existence and content before resuming; do not overwrite archives.

| Path | Observed contents / purpose |
| --- | --- |
| `phase-4.eval-dataset.local.json` | Original 60-case diagnostic dataset |
| `phase-4-source-manifest.local.json` | Local source mapping; stale after later retries, includes unsupported pricing and exclusion decisions |
| `phase-4-remainder.eval-dataset.local.json` | 58 sessions, excluding 000/001 |
| `phase-4-remainder-2.eval-dataset.local.json` | 46 sessions, public 014 onward plus originals |
| `phase-4-remainder-3.eval-dataset.local.json` | 42 both-candidate-429 retry sessions |
| `phase-4-remainder-4.eval-dataset.local.json` | 40 sessions, public 018 onward and outstanding originals |
| `.cache/phase-4-collection.partial-503.jsonl` | 000/001: truncated/partial, unjudged |
| `.cache/phase-4-collection.batch1-judged.jsonl` | 11 judged pairs: public 002 through 012 |
| `.cache/phase-4-collection.batch2-mixed.jsonl` | 46 rows: 42 both-failed 429, 3 partial, 1 judged |
| `.cache/phase-4-collection.batch2-judged.jsonl` | Copy of original-004, already in batch2-mixed |
| `.cache/phase-4-collection.batch3-mixed.jsonl` | public 016 judged; 017 cheap 429/frontier completed |
| `.cache/phase-4-collection.batch3-judged.jsonl` | Copy of public 016, already in batch3-mixed |
| `.cache/phase-4-collection.batch4-429.jsonl` | public 018 both-candidate 429 |
| `phase-4-collection.local.jsonl` | Latest retry: public 018 both-candidate 429 again; NOT the combined collection |

There are **13 unique complete judged pairs**, not 13 held-out cases: public 002-012,
016, and original-004. Never concatenate the `*-judged` copies with their mixed
parents without deduplicating by example and candidate. Preserve all failed attempts.
Public 013 generated candidates before a judge 503 aborted without persisting them;
its responses/usage are unavailable. Public 002 also had an extra generation probe.
Partial retained rows exist for public 000/001, 014/015/017, and original-024.
The local generator `/tmp/build_phase4_dataset.py` and downloaded
`/tmp/HumanEval.jsonl.gz` are ephemeral and must not be assumed available or rerun:
the generator overwrites the dataset and manifest.

### Historical failures and subsequent fixes

- A proxy Gemini completion returned HTTP 200 without usage. Source inspection found
  `writeChatCompletion` omitted usage in translated non-stream responses. The proxy now
  normalizes Anthropic, OpenAI, xAI, Google, and OpenAI-compatible Responses usage into
  the OpenAI Chat Completions envelope; the Anthropic cache-token regression is covered
  by `packages/proxy/tests/server.test.ts`.
- `requestCompletion` already sends `x-force-model` for qualified model IDs. The earlier
  claim that collection cannot pin non-Anthropic proxy candidates was incorrect.
- Claude probe returned 429; judge alternatives returned 404/429/503. Availability and
  quota must be reverified; model-list presence does not establish inference access.
- Short probes sometimes returned 200 while full requests returned 429. Later sanitized
  provider details identified a free-tier per-project, per-model RPD limit of 20. The
  official reset is midnight Pacific; a short retry delay cannot overcome exhausted RPD.
- `router-core/src/embeddings.ts` now interprets an absent index as zero, not array
  position. Duplicate/out-of-range checks remain. Two regression tests were added.
  Targeted checks reported 34 embedding tests and 170 core tests passing.
- `eval/src/avengers-collection.ts` now persists explicit judge and generation transport
  errors, marks missing rubric judgments `unjudged`, exits non-zero, and prevents curation
  from accepting those rows as observed quality zero.
- Provider usage accounting includes hidden thinking tokens reported only by
  `total_tokens`. Curation binds all rows and aliases to the frozen dataset, and training
  validates its options before embedding requests.
- Final local verification passed 155 eval tests, 170 router-core tests, 104 proxy tests,
  3 installer tests, all package builds, corpus invariants, permission/ignore checks, and
  rejection of the partial production collection by curation.

## Anthropic Replacement Snapshot (2026-09-08)

- `phase-4-production-anthropic-v1.eval-dataset.local.json` is a separate ignored
  provider snapshot derived from the immutable 80-case production task corpus. It keeps
  the 45/35 split and 57 leakage groups; Gemini outcomes are not reused or combined.
- Candidates are `anthropic/claude-haiku-4-5` and `anthropic/claude-sonnet-5`; the distinct
  judge is `anthropic/claude-opus-5`. Official model IDs and standard API-equivalent
  prices are recorded at [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview)
  and [pricing page](https://platform.claude.com/docs/en/about-claude/pricing#model-pricing).
  Subscription usage is not invoiced at these API rates; costs are estimates.
- Embeddings use local Ollama `nomic-embed-text` at 768 dimensions through
  `http://127.0.0.1:11434/v1/embeddings`. The local endpoint returned a valid vector and
  the new dataset replay passed offline.
- The loopback proxy is the only generation path. A live Haiku smoke returned HTTP 429
  with the account's Claude Pro five-hour window at 100%; no new candidate or judge
  outcomes exist yet. The snapshot is prepared but not collected, curated, trained,
  validated, or eligible for activation.

## OpenAI OAuth Snapshot (2026-09-08)

- `phase-4-production-openai-v1.eval-dataset.local.json` and its source manifest are
  separate ignored snapshots derived from the immutable 80-case production corpus. They
  retain the 45/35 split and 57 leakage groups and do not reuse provider outcomes.
- Candidates are `paper/cheap=openai/gpt-5.6-luna` and
  `paper/frontier=openai/gpt-5.6-sol`; the distinct judge is
  `openai/gpt-5.6-terra`. Official model pages and standard short-context pricing are
  recorded in the local manifest. Subscription OAuth usage is not invoiced at those API
  rates, so the prices are estimates for comparison only.
- All three model probes returned HTTP 200 with provider usage through the rebuilt
  loopback proxy. Offline preflight planned 160 candidate generations and 80 judges.
- The confirmed collection produced 51 complete judged rows, then stopped at
  `real-client-installer/real-2ad6fe28d89f`: the Luna outcome completed and the Sol
  request timed out at the shared 120-second eval/proxy boundary. The partial collection
  is rejected evidence. Do not retry the timed-out request or train from this partial
  matrix without explicit recovery approval because its billing outcome is ambiguous.
- The user chose to skip further expensive frontier calls for now. The synthetic fixture
  pipeline was exercised instead with local Ollama embeddings: three training embeddings,
  three held-out embeddings, a 62.54 ms p95 at a two-second timeout, and mode-0600 artifact
  files. Validation correctly remained ineligible because the fixture is synthetic, has
  fewer than 30 held-out cases, and misses the cost-savings gate. This is mechanics-only
  evidence; no production artifact or Tier 1 activation exists.

## OpenAI OAuth Production Completion (2026-09-09)

The initial OpenAI collection stopped at the first real task because the loopback proxy's
120,000-millisecond upstream deadline was shorter than the Sol completion. The proxy now
accepts `AUTO_ROUTER_UPSTREAM_TIMEOUT_MS` from 1 through 600,000 milliseconds (10 minutes);
timeouts remain single-attempt because their billing outcome is ambiguous. Recovery was run with a 600-second proxy
deadline, a 660-second eval deadline, the frozen two candidates and Terra judge, and a
fresh output path. The initial 51 rows and fresh 29 rows were reconciled by immutable ID.

- Complete matrix: 80 unique rows, 160 completed candidate outcomes, 80 blinded judgments,
  provider usage on every candidate outcome, zero collection errors, and mode-0600 local
  output.
- Dataset/split: 57 leakage groups; 45 train (25 public, 20 real) and 35 held-out (26
  public, 9 real), seed `phase4-production-v1`, held-out ratio `0.5`.
- Candidate totals: cheap `43,872` input and `82,526` output tokens, estimated `$0.107806`;
  frontier `43,872` input and `116,711` output tokens, estimated `$2.509708`. These are
  API-equivalent comparison prices, not subscription invoices, and exclude judge/embedding
  overhead from the candidate totals.
- Artifact: local Ollama `nomic-embed-text`, 768 dimensions, 6,000-character bound, two
  clusters, top-K `2`, beta `9`, minimum observations `3`; artifact digest
  `17241130c16044b638c529ee63454ae0fd732e3704707290ac3c7191f491cbd1`; corpus digest
  `4ff03aa311b305e5d9eca62a03e077d77320b3d5a7195fc2c00e968c2383aeac`.
- Validation: endpoint digest
  `9b514b1a65f6ebfaa4da53a116ea003831b044dc32a989733eace74554ef5b0c`, 35 fresh held-out
  single-item requests, p95 `239.83 ms` at a 2,000 ms timeout, quality retention `1.1097`,
  candidate-generation cost savings `0.9537`, and all gates passed. The seeded interval is
  `[0.9462, 1.3413]`; the current uncertainty gate checks presence only.
- Cohorts: public Tier 1 quality/cost `0.9585`/`$0.000302` versus frontier
  `0.8046`/`$0.003864`; real-task Tier 1 quality/cost `0.2556`/`$0.003014` versus
  frontier `0.4011`/`$0.072664`. Tier 1, Tier 0, and always-cheap selected identically on
  every held-out case, so the artifact passes the formal gate without demonstrating a
  Tier-0 quality improvement.
- Local authorized runtime activation loaded the exact eligible digest and ranked a smoke
  task successfully. The checked-in configuration remains `enabled: false`; private corpus,
  responses, embeddings, artifact, and validation outputs are ignored and unpublished.

The sanitized recovery, reconciliation, curation, training, validation, runtime-smoke,
and repository-check commands are recorded in the [canonical execution record](../../PLAN.md#sanitized-openai-production-execution-record).

### Deferred Anthropic replacement sequence

The OpenAI completion above satisfies the current Phase 4 delivery. The following
Anthropic snapshot remains an optional provider comparison, not a prerequisite for the
OpenAI artifact or local activation:

1. Restart the local proxy from the rebuilt `packages/proxy/dist` and wait for the
   subscription quota reset. Run one forced Haiku smoke and require a Chat Completions
   response with `usage.prompt_tokens` and `usage.completion_tokens` before collection.
2. Use the Anthropic snapshot and a fresh output path. Collect all 80 rows through the
   loopback proxy; require both candidate runtime IDs, complete terminal state, provider
   usage, and blinded Opus judgment for every row.
3. Curate only the complete replacement collection, train with local Ollama embeddings,
   verify deterministic artifact bytes, and validate all 35 untouched held-out examples
   plus both source cohorts. Keep Tier 1 disabled unless the artifact is eligible and
   rollout is separately authorized.

### Historical Gemini execution sequence

1. Supply a Gemini project whose AI Studio project shows Tier 1 or higher and verify at
   least two consecutive frontier requests, or wait across quota reset windows to collect
   the exact frozen experiment. Do not rotate model aliases or tune the seed, split,
   corpus, or output cap after observing results.
2. Use a fresh output path. Reconcile retry artifacts by ID and candidate before any
   rerun; the stock CLI has no candidate-specific resume or judge-only mode. Never count
   overlapping smoke/retry rows twice or accept success-only subsets.
3. Require all 80 exact rows to contain both mapped runtime IDs, complete terminal state,
   provider usage/cost, and blinded judgment before curation. Run full builds/tests and
   inspect redaction before training.
4. Train on the fixed 45-example training partition with the frozen embedding settings,
   verify deterministic artifact bytes, and validate all 35 untouched held-out examples
   plus both source cohorts. Keep every original gate unchanged and Tier 1 disabled unless
   the artifact is eligible and rollout is separately authorized.

Documentation updates do not authorize new live calls, Git publication, or activation.

## Context

Phase 4 now spans these implemented Tier-1 pieces:

- `router-core` loads versioned Avengers-Pro cluster artifacts, scores supplied embeddings,
  and exposes the constrained learned reranker.
- `router-core` exposes the shared dependency-free OpenAI-compatible embedding boundary
  for normalization, endpoint binding, and batched validated requests.
- `packages/eval` owns observed-outcome collection, curation, deterministic artifact
  training, and held-out validation.
- The proxy can pass the resulting canonical model ranking into `selectModel`.

The runtime classifier path is implemented and has an eligible local OpenAI artifact. The
checked-in corpus and artifact remain synthetic, their validation is intentionally
ineligible for activation, and `auto-router.json` keeps Tier 1 disabled by default.
Production corpus, artifact, and validation outputs remain private local evidence; local
digest-bound activation was verified separately. The implementation preserves the
existing task-policy, Tier-0, context-fit, and stickiness contracts.

## Goals

- Build a reproducible pipeline from manually reviewed task text and observed per-model
  outcomes to a validated Avengers-Pro artifact.
- Learn task-specific model quality rather than freezing provider prices into the
  artifact.
- Use one configurable OpenAI-compatible embeddings boundary for collection, training,
  validation, and runtime inference.
- Apply learned scores only as a constrained reranker of models that already satisfy the
  router's hard policy and safety guards.
- Keep Tier 1 disabled by default and fail open to Tier 0 on every artifact or embedding
  failure.
- Reuse the Phase 3 benchmark bar before allowing a real artifact to activate.
- Keep prompts, responses, individual embeddings, and credentials out of committed
  artifacts and runtime logs.

## Non-Goals

- Replacing Tier-0 classification, task policies, model mapping, context-fit guards, or
  task stickiness.
- Per-turn embedding or model switching inside a task.
- Native embedding adapters for individual providers in the first version.
- Bundling a local embedding model or provider SDK.
- Training from human `simple | medium | complex` labels.
- Enabling a synthetic fixture artifact in production.
- Making live provider calls part of normal build, test, or CI commands.

## Decisions

1. Extend the existing package split instead of creating a classifier workspace.
2. Use observed model outcomes as the canonical training signal.
3. Learn per-cluster model quality and completion evidence; apply current prices and task
   strategy at selection time.
4. Use deterministic seeded k-means over L2-normalized embeddings.
5. Require a leakage-free held-out validation manifest bound to the exact artifact.
6. Consider Phase 4 code complete with deterministic fixtures and mock integrations, but
   keep production activation unchecked until a real artifact passes the live-data gate.

## Ownership Boundaries

### `packages/router-core`

`router-core` owns code required by both offline and runtime paths:

- Corpus-independent task-text normalization.
- OpenAI-compatible embedding request and response validation with injected `fetch`.
- Versioned artifact and validation-manifest types.
- Strict artifact loading, digest verification, and semantic validation.
- L2 normalization, nearest-cluster weighting, and predicted model quality.
- Constrained candidate selection using learned quality plus current catalog policy.

The embedding request helper accepts explicit endpoint, key, model, timeout, and input.
It does not read environment variables or log request content. Callers own configuration
and secret lookup.

### `packages/eval`

The eval workspace owns offline and billable pipeline behavior:

- Versioned observed-outcome corpus schema and validation.
- Explicitly confirmed candidate-model data collection.
- Stable train/held-out splitting by session group.
- Batched embedding and ignored local embedding caches.
- Deterministic clustering and cluster-statistic generation.
- Canonical artifact output and digest calculation.
- Held-out replay, activation gates, and JSON/Markdown reports.

### `packages/proxy`

The proxy owns runtime orchestration:

- Resolve embedding credentials from the configured environment variable.
- Load and activate one validated artifact during bootstrap.
- Request one embedding at a confirmed task boundary.
- Fall back to normal Tier-0 selection on any Tier-1 failure.
- Emit privacy-safe outcome and latency diagnostics.

## Observed-Outcome Corpus

The corpus is a versioned local JSON document. Each example contains:

- An opaque example ID.
- An opaque session-group ID used to prevent train/held-out leakage.
- Manually reviewed task-boundary text.
- Optional task type.
- One outcome per canonical paper model ID.

Each model outcome contains:

- Canonical paper model ID.
- Terminal state: `completed`, `incomplete`, or `failed`.
- Quality in `[0, 1]`, with judge/check provenance.
- Provider-observed or explicitly estimated token usage.
- Observed or estimated request cost and its source.

Incomplete and failed outcomes train as quality zero. Missing outcomes are not silently
treated as failures; they remain missing and cannot satisfy a complete held-out candidate
matrix.

Collection planning rejects any turn that has neither a non-empty judge rubric nor a
usable deterministic check (recorded-outcome checks do not count), so a completed turn
can never be silently scored as quality zero for lacking a quality signal.

Collection may retain bounded responses locally long enough to run deterministic checks
and blinded judging. A separate curation step removes responses before producing the
training corpus. Corpora, collection output, and embedding caches remain ignored local
files unless a synthetic fixture has received manual privacy review.

## Live Collection

The eval CLI adds an explicitly billable candidate-model collection mode. Conceptually:

```bash
npm run eval -- collect-avengers \
  --dataset path/to/reviewed-dataset.json \
  --models paper/a=provider/a,paper/b=provider/b \
  --output phase-4-collection.local.jsonl \
  --confirm-live

npm run eval -- curate-avengers \
  --input phase-4-collection.local.jsonl \
  --dataset path/to/reviewed-dataset.json \
  --models paper/a=provider/a,paper/b=provider/b \
  --output phase-4-corpus.local.json
```

Before making a request, the command prints the exact planned generation and judge call
counts. It reuses Phase 3 request limits, terminal-state checks, deterministic checks,
blinded judging, usage provenance, and secret handling. A timed-out billable request is
not automatically retried because its billing outcome is unknown.

Collection requires an explicit candidate list and records canonical IDs separately from
runtime provider IDs. This preserves artifact stability when provider aliases change.

## Split And Embedding

The builder splits examples by session-group ID before clustering. A stable hash of the
group ID and explicit split seed assigns the entire group to train or held-out data.
Related turns cannot cross the split.

Training and inference use the same text-normalization function. It normalizes line
endings, trims outer whitespace, and applies one configured input bound without changing
case or internal content. The artifact records that normalization version and bound.

The shared boundary exports `normalizeEmbeddingText`, `embeddingEndpointDigest`, and
`requestEmbeddings`. It uses native `fetch` and Node built-ins only. The configured
`baseUrl` includes the API version prefix, such as `https://embedding.example/v1`; the
client appends exactly `/embeddings` after removing trailing slashes. HTTPS is required
except for `127.0.0.1`, `localhost`, and `::1`; credentials, query strings, and fragments
are rejected. The endpoint digest is SHA-256 over that normalized pre-append base URL.

`normalizeEmbeddingText` normalizes line endings, trims outer whitespace, and applies a
positive integer character bound without changing case or internal content.
`requestEmbeddings` accepts 1–128 strings totaling at most 1 MiB of UTF-8 input,
requires a positive integer timeout, rejects redirects, performs no retries, and bounds
successful response bodies to 16 MiB. Responses must contain unique in-range indices,
one consistent positive dimension, and finite numeric values. Non-success errors expose
only the HTTP status and cancel the response body; keys and provider bodies are never
included in errors.

Offline embedding caches are keyed by corpus example ID, normalized-input digest, and
embedding model. They are ignored local data and never contain API keys or raw responses.
Runtime adds no cache in the first version because one embedding is requested only at a
task boundary.

## Deterministic Training

The train command requires explicit cluster count and accepts an explicit seed:

```bash
npm run eval -- train-avengers \
  --corpus phase-4-corpus.local.json \
  --artifact-dir path/to/artifact \
  --clusters 8 \
  --seed 4683 \
  --held-out-ratio 0.2 \
  --top-k 3 \
  --beta 9 \
  --min-observations 3 \
  --max-input-chars 16000 \
  --cache phase-4-embeddings.local.json \
  --timeout-ms 400 \
  --confirm-live
```

Training performs these steps:

1. Validate corpus bounds, IDs, quality values, outcome provenance, and group integrity.
2. Create the stable train/held-out split.
3. Embed and L2-normalize training task text.
4. Run seeded k-means with deterministic initialization, iteration order, tie-breaking,
   convergence criteria, and maximum iterations. These fixed algorithm-version constants
   are recorded in metadata; changing one creates a new algorithm version.
5. Fail if any cluster is empty rather than silently changing cluster count.
6. Assign each training example to its nearest cluster.
7. Aggregate quality, completion count, failure count, and observation count for each
   cluster and canonical model.
8. Omit a model from a cluster when its observation count is below the configured
   minimum.
9. Write canonical, timestamp-free artifacts with stable object-key and array ordering.

The artifact stores quality statistics, not cost rankings. Cost changes do not require
retraining.

## Artifact Contract

The existing unversioned fixture format is replaced by a strict versioned format. Old
fixture artifacts intentionally fail validation; Phase 4 has not shipped a production
artifact requiring backward compatibility.

The artifact directory contains:

- `metadata.json`: schema version, synthetic flag, embedding model/dimension,
  normalization version/bound, corpus digest, split seed, cluster count, `topK`, `beta`,
  held-out ratio, minimum observations, algorithm version, and canonical model IDs.
- `cluster_centers.json`: finite, L2-normalized centers with one fixed dimension.
- `cluster_model_stats.json`: quality means and completion/failure/observation counts for
  each cluster and canonical model.
- `validation.json`: artifact digest, embedding-endpoint digest, held-out metrics, latency
  evidence, individual gate results, and aggregate eligibility.

The artifact digest covers metadata, centers, and model statistics in canonical byte
order. `validation.json` names that digest so a report from one artifact cannot activate
another.

Synthetic fixture metadata forces aggregate eligibility to `false`, regardless of its
test metrics.

## Held-Out Validation

Validation embeds held-out task text, scores the artifact, and replays selections against
the observed outcome matrix. It compares:

- Tier 1 constrained reranking.
- Existing Tier 0.
- Always-frontier.
- Always-cheap.

```bash
npm run eval -- validate-avengers \
  --corpus phase-4-corpus.local.json \
  --artifact-dir path/to/artifact \
  --output phase-4-validation.local \
  --bootstrap-seed fixture-seed \
  --timeout-ms 400 \
  --confirm-live
```

Validation uses single-item embedding requests against the endpoint and timeout intended
for deployment. It records a SHA-256 digest of the normalized `baseUrl`, not the URL
itself. Runtime activation requires the configured endpoint digest to match; changing the
endpoint requires a new validation run, not retraining.

An activation-eligible manifest requires all of the following:

- At least 30 complete held-out cases with outcomes for every candidate model needed by
  the compared strategies.
- Tier-1 quality retention of at least `0.95` relative to always-frontier.
- Tier-1 estimated cost savings of at least `0.50` relative to always-frontier.
- Tier-1 aggregate quality no lower than Tier 0.
- Tier-1 aggregate cost no higher than Tier 0.
- Seeded uncertainty evidence using the Phase 3 bootstrap implementation.
- Measured p95 embedding latency no greater than the configured runtime timeout.
- No failed, incomplete, truncated, unmapped, or excluded required case.

Reports follow the Phase 3 privacy contract: they include IDs, metrics, evidence, and
reasons, but no task text, model response, or individual embedding.

## Runtime Configuration

Tier 1 remains opt-in:

```jsonc
{
  "avengersPro": {
    "enabled": false,
    "artifactDir": "./artifacts/avengers-pro/production",
    "embedding": {
      "baseUrl": "https://embedding.example/v1",
      "apiKeyEnv": "EMBEDDING_API_KEY",
      "model": "embedding-model-id"
    },
    "timeoutMs": 400,
    "maxInputChars": 16000
  }
}
```

`topK`, `beta`, dimensions, and normalization settings come from the validated artifact
and cannot be overridden at runtime without generating a new artifact and manifest.
`maxInputChars` must equal the artifact's normalization bound. The checked-in config and
defaults use `enabled: false`.

## Runtime Data Flow

The proxy uses this order for each request:

1. Honor an explicit `x-force-model` header before task stickiness and bypass embedding.
2. Otherwise return the existing task lock inside a task; request-body model selection
   remains subject to that lock.
3. Confirm a new task boundary.
4. Normalize and bound the task-boundary text.
5. Request one embedding with `AbortSignal.timeout` and no automatic retry.
6. Score the nearest `topK` centers using softmax over `-beta * cosineDistance`.
7. Aggregate cluster quality means into predicted task-specific quality per canonical
   model.
8. Map canonical IDs to currently connected runtime IDs.
9. Run constrained selection and write the final task lock.

The selector first applies existing task policy and global catalog quality floors.
Learned scores cannot make an otherwise ineligible model eligible. Among eligible mapped
models:

- `quality` chooses the highest predicted task-specific quality, then generic catalog
  quality as a tie-breaker.
- `lowest-cost` chooses the lowest current blended price, then predicted quality.
- `value` remains free-first; among free models it chooses predicted quality, and among
  paid models with positive finite price it chooses the highest
  `predictedQuality / blendedPrice`, then predicted quality.

Context fit, upgrade/downgrade behavior, and task stickiness run unchanged after candidate
selection. If Tier 1 produces no eligible candidate, the selector executes the existing
Tier-0 path.

## Failure Behavior

Startup validates the artifact, manifest, digest, embedding model, dimensions, and
eligibility. Invalid configuration emits one structured warning and leaves Tier 1
disabled; it does not prevent the proxy from serving requests.

Runtime falls back to Tier 0 on:

- Missing embedding credentials.
- Timeout, `429`, transport error, or non-success response.
- Malformed, missing, non-finite, or wrong-dimension vectors.
- Embedding model mismatch.
- Artifact or mapping inconsistency.
- No mapped learned candidate that clears existing guards.

There is no retry on the request path. A sticky target is written only after final Tier-1
or Tier-0 selection succeeds.

## Privacy And Observability

Embedding is disabled unless the operator explicitly configures and enables it. Runtime
sends only normalized task-boundary text to the configured endpoint. It does not send
headers, credentials, tool results, or the complete transcript as classifier input.

Diagnostics may include:

- Artifact digest and embedding model ID.
- Embedding latency and outcome code.
- Tier-1 success or fallback reason code.
- Predicted canonical ID and selected runtime ID.
- Selection strategy and existing guard outcome.

Diagnostics must not include task text, response text, vectors, API keys, or raw embedding
provider bodies.

## Testing

### `router-core`

- Artifact schema, digest, dimensions, finite numbers, model consistency, and synthetic
  eligibility.
- Embedding request shape, batching, response order, timeout, and malformed responses.
- Deterministic nearest-cluster weighting and model-quality aggregation.
- Missing and low-observation model handling.
- Mapping, `quality`, `lowest-cost`, and `value` selection with hard policy guards.
- Tier-0 fallback when learned candidates are absent or ineligible.

### `packages/eval`

- Corpus bounds, terminal states, provenance, and privacy-safe reports.
- Group split stability and leakage rejection.
- Seeded clustering, deterministic tie-breaking, convergence, and empty-cluster failure.
- Incomplete outcomes scoring as zero and minimum-observation omission.
- Canonical artifact and report bytes across repeated builds.
- Manifest-to-artifact digest binding and every activation gate.
- Confirmed collection call counts, no timeout retries, and mock judge/check evidence.
- Ignored embedding-cache reuse and invalidation.

### `packages/proxy`

- Existing task locks and forced models bypass embedding.
- Only confirmed boundaries call embedding.
- Successful Tier 1 changes constrained candidate ordering.
- Every embedding/artifact error falls back to Tier 0 once.
- Final selection alone writes task state.
- Logs contain no task text, vectors, provider bodies, or credentials.

### End-To-End Fixture

A synthetic corpus is embedded through a mock endpoint, trained, and validated as
non-activation-eligible. Pure artifact loading/scoring and an injected proxy test use it
for stable routing assertions, while a production-bootstrap test proves the same fixture
cannot activate. Two complete runs must produce byte-identical artifacts and reports. CI
performs no live provider calls.

## Rollout And Rollback

1. Merge code with Tier 1 disabled and synthetic fixtures only.
2. Collect a manually reviewed local observed-outcome corpus when provider quota permits.
3. Train an artifact and inspect its held-out JSON/Markdown report.
4. Activate only when `validation.json` is eligible and bound to the artifact digest.
5. Monitor latency, fallback reason counts, and Tier-1/Tier-0 decision differences.

Rollback is setting `avengersPro.enabled` to `false` and restarting the proxy. No data
migration or state rewrite is required. Existing task locks remain valid until their
normal session lifetime ends.

## Documentation And Status

Implementation updates must keep `README.md`, `PLAN.md`, `roadmap.md`, configuration
examples, and the verification record aligned. Status must distinguish:

- Phase 4 code complete.
- Real observed-outcome corpus collected.
- Production artifact trained.
- Production artifact activation gate passed.

Until the final state is proven, no documentation may claim production quality or cost
improvement from Tier 1.
