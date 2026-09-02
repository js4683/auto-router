# Phase 4 Tier-1 Embedding Classifier Design

**Status:** Approved in design review on 2026-09-01
**Scope:** End-to-end observed-outcome training, artifact validation, and opt-in runtime inference
**Canonical project plan:** [PLAN.md](../../PLAN.md)

## Context

The router currently has two partial Tier-1 pieces:

- `router-core` can load fixture Avengers-Pro cluster artifacts and score a supplied
  embedding.
- The proxy can pass the resulting canonical model ranking into `selectModel`.

The executable path is not production-ready. It uses a two-dimensional keyword fixture,
does not call a real embedding endpoint, and has no observed-outcome corpus or artifact
builder. The checked-in `auto-router.json` keeps this fixture disabled by default. Phase 4
completes that path without weakening the existing task-policy, Tier-0, context-fit, or
stickiness contracts.

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
- Terminal state: `complete`, `incomplete`, or `failed`.
- Quality in `[0, 1]`, with judge/check provenance.
- Provider-observed or explicitly estimated token usage.
- Observed or estimated request cost and its source.

Incomplete and failed outcomes train as quality zero. Missing outcomes are not silently
treated as failures; they remain missing and cannot satisfy a complete held-out candidate
matrix.

Collection may retain bounded responses locally long enough to run deterministic checks
and blinded judging. A separate curation step removes responses before producing the
training corpus. Corpora, collection output, and embedding caches remain ignored local
files unless a synthetic fixture has received manual privacy review.

## Live Collection

The eval CLI adds an explicitly billable candidate-model collection mode. Conceptually:

```bash
npm run eval -- collect-avengers \
  --dataset path/to/reviewed-dataset.json \
  --models model-a,model-b,model-c \
  --output phase-4-collection.local.jsonl \
  --confirm-live

npm run eval -- curate-avengers \
  --input phase-4-collection.local.jsonl \
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

The configured `baseUrl` includes the API version prefix, such as
`https://embedding.example/v1`; the client appends `/embeddings`. Requests may be batched
offline; runtime sends one normalized task. Every response must contain the expected item
count, one consistent positive dimension, and finite numeric values. The configured
embedding model and returned vectors must match artifact metadata.

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
  --max-input-chars 16000
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
  --output phase-4-validation.local
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

1. Return the existing task lock when the request remains inside a task.
2. Honor an explicit forced model according to the existing force/stickiness contract.
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
