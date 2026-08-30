# Task-Level Cost-Aware Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select one model per task/theme, prefer free or lowest-cost models for verification work, and require high-capability models for planning and architecture work.

**Architecture:** Keep model policy and selection in the harness-agnostic `router-core`. The OpenCode adapter will lock the selected target to a task boundary, observe the actual model without mutating unsupported request fields, and emit at most one recommendation for that task. Existing live provider discovery remains the catalog source, with the static catalog as a fail-open fallback.

**Tech Stack:** TypeScript, OpenCode plugin hooks, OpenCode SDK provider catalog, Vitest, npm workspaces.

**Spec:** `PLAN.md` is canonical; `design.md` provides supporting architecture detail.

## Global Constraints

- Route only at a confirmed task/theme boundary; hold the task target for all messages inside that task.
- Verification tasks prefer a connected free model; if none is available, choose the lowest blended-cost eligible model.
- Planning and architecture tasks require a high-capability quality floor and prefer quality over cost.
- Preserve provider-qualified runtime IDs such as `opencode/muse-spark-1.2-contributor-free`.
- Do not call `opencode models` from the plugin; recursive CLI discovery previously caused startup hangs.
- Do not mutate `chat.params` model fields; OpenCode 1.18.25 exposes no supported model mutation hook.
- Live provider discovery is bounded and fail-open; fallback selection must remain usable if the provider API fails.
- Every policy change must update `design.md`, `roadmap.md`, and this plan's decision log.
- Every policy change must also update the canonical root `PLAN.md`.

## File Map

- Modify `packages/router-core/src/types.ts`: task types and task-selection policy shape.
- Modify `packages/router-core/src/config.ts`: safe defaults for verification and planning policies.
- Modify `packages/router-core/src/task-type.ts`: recognize verification and planning language.
- Modify `packages/router-core/src/catalog.ts`: infer high-capability model classes used when AA data is unavailable.
- Modify `packages/router-core/src/selector.ts`: apply per-task cost and quality strategies.
- Modify `packages/router-core/tests/task-type.test.ts`: regression coverage for verification and planning detection.
- Modify `packages/router-core/tests/selector.test.ts`: regression coverage for lowest-cost and high-quality selection.
- Modify `packages/router-core/tests/plugin.test.ts`: regression coverage for task-level locking and one recommendation per task.
- Modify `.opencode/plugins/auto-router.ts`: task target state and boundary-only routing.
- Modify `~/.config/opencode/plugins/auto-router.ts`: deployed global adapter with the same task behavior.
- Modify `design.md`: authoritative architecture and decision record.
- Modify `roadmap.md`: current implementation status and remaining upstream dependency.
- Modify `README.md`: user-facing behavior and integration limitation.

## Decision Log

- **2026-08-29:** Model selection is task/theme scoped, not per-turn. A confirmed boundary starts a new decision; messages within that task remain sticky.
- **2026-08-29:** Verification work includes tests, `no-mistakes`, lint, build, typecheck, validate, and verify. It prefers free models, then the lowest blended cost.
- **2026-08-29:** Planning and architecture work uses a high quality floor and quality-first selection so models such as Sol, Fable, or Opus are preferred when present in the live catalog.
- **2026-08-29:** The OpenCode adapter must not mutate unsupported model fields. Until an upstream model-routing hook exists, it records the task-level recommendation and observes the model OpenCode actually used.

---

### Task 1: Synchronize the written design

**Files:**
- Modify: `design.md`
- Modify: `roadmap.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-29-task-level-routing.md`

**Interfaces:**
- Documents the policy implemented by Tasks 2–4; no code interface changes.

- [x] **Step 1: Update the architecture text**

  Replace per-turn switching claims with task-boundary selection, document the verification cost strategy, document the planning/architecture quality floor, and state that current OpenCode integration records recommendations because model mutation is unsupported.

- [x] **Step 2: Update the roadmap status**

  Mark completed catalog/core/plugin items, add task-level cost policy and live-provider discovery to the completed work, and leave the upstream model-routing hook as the remaining integration dependency.

- [x] **Step 3: Verify the decision record**

  Search all three docs for `per-turn`, `task boundary`, `lowest`, `planning`, `architecture`, and `model mutation`; every user-visible statement must match the Global Constraints above.

### Task 2: Add task policy and classification

**Files:**
- Modify: `packages/router-core/src/types.ts`
- Modify: `packages/router-core/src/config.ts`
- Modify: `packages/router-core/src/task-type.ts`
- Modify: `packages/router-core/tests/task-type.test.ts`

**Interfaces:**
- `TaskType` gains `planning`.
- `RouterConfig.taskTypeModels[type]` accepts `{ prefer: string | null; strategy?: "value" | "lowest-cost" | "quality"; minQuality?: number }`.
- Defaults set `run_tests` to `{ prefer: null, strategy: "lowest-cost" }` and `planning` to `{ prefer: null, strategy: "quality", minQuality: 85 }`.
- High-confidence verification and planning phrases resolve without file/depth corroboration because their policies are intentionally explicit and bounded.

- [x] **Step 1: Add failing classifier tests**

  Cover `run no-mistakes`, `run lint and typecheck`, and `plan the architecture` as the expected task types, including a direct `[task:planning]` tag.

- [x] **Step 2: Run the focused tests**

  Run `npm test --workspace=@auto-router/router-core -- tests/task-type.test.ts`.
  Expected: the new cases fail because the task type and patterns are not implemented.

- [x] **Step 3: Add the policy shape and defaults**

  Extend the task type union and task policy type, then add the `planning` default and the verification/planning strategy values to the repository config and fallback config.

- [x] **Step 4: Implement safe task-type patterns**

  Add verification terms (`no-mistakes`, lint, typecheck, validate, verify, coverage, and test commands) to `run_tests`. Add planning terms (`plan`, planning, architecture, system design, design decision, trade-off) to `planning`, with planning checked before the broader `implement` pattern. Permit a clear high-confidence match for these two policy families without requiring a second session signal.

- [x] **Step 5: Run the focused tests again**

  Run `npm test --workspace=@auto-router/router-core -- tests/task-type.test.ts`.
  Expected: all task-type tests pass.

### Task 3: Implement cost and high-capability selection

**Files:**
- Modify: `packages/router-core/src/catalog.ts`
- Modify: `packages/router-core/src/selector.ts`
- Modify: `packages/router-core/tests/selector.test.ts`
- Modify: `packages/router-core/tests/catalog.test.ts`

**Interfaces:**
- `buildCatalogFromProviders` continues to produce live provider-qualified entries.
- The selector reads `taskTypeModels[taskType].strategy` and `minQuality`.
- `strategy: "lowest-cost"` sorts eligible non-free models by `blendedPrice`, then quality; free models remain preferred and are sorted by quality.
- `strategy: "quality"` sorts eligible models by `codingIndex`, then value.

- [x] **Step 1: Add failing selector tests**

  Add a verification catalog where a low-cost paid model has lower value than a more expensive model and assert the low-cost policy chooses the cheaper model when no free model is present. Add a planning catalog with Sol/Fable/Opus-like IDs and assert a planning task rejects models below quality 85 and selects a high-capability entry.

- [x] **Step 2: Run the focused selector tests**

  Run `npm test --workspace=@auto-router/router-core -- tests/selector.test.ts`.
  Expected: the new strategy cases fail before implementation.

- [x] **Step 3: Add strategy-aware candidate selection**

  Compute the effective quality floor as the greater of the complexity tier floor and the task policy floor. Keep free-first behavior for all strategies; choose lowest blended cost for `lowest-cost`, highest quality for `quality`, and existing value-per-dollar ordering for `value`.

- [x] **Step 4: Extend offline model inference**

  Treat Sol, Fable, and Opus model IDs as high-capability when live provider metadata lacks AA quality, while retaining live provider costs and context limits. Do not replace provider-qualified runtime IDs.

- [x] **Step 5: Run focused and full core tests**

  Run `npm test --workspace=@auto-router/router-core`.
  Expected: all existing and new catalog/selector tests pass.

### Task 4: Lock model decisions to task boundaries

**Files:**
- Modify: `.opencode/plugins/auto-router.ts`
- Modify: `~/.config/opencode/plugins/auto-router.ts`
- Modify: `packages/router-core/tests/plugin.test.ts`

**Interfaces:**
- Per-session state stores the task target, the model OpenCode actually used, and a one-shot pending recommendation.
- `chat.message` selects only when there is no task target or `detectBoundary` reports a confirmed boundary; otherwise it preserves the existing task target.
- `chat.params` records the actual provider/model and consumes a pending task recommendation without modifying `output`.

- [ ] **Step 1: Add failing plugin tests**

  Assert that two messages without a boundary produce one task selection and no second recommendation. Assert that a new boundary produces a second selection. Assert that `chat.params` records the actual model and leaves all output fields unchanged.

- [ ] **Step 2: Run the focused plugin tests**

  Run `npm test --workspace=@auto-router/router-core -- tests/plugin.test.ts`.
  Expected: the task-level assertions fail against the current per-hook recommendation behavior.

- [ ] **Step 3: Add task target state**

  Keep `currentModel` as the task-locked target, add `actualModel` and `pendingRecommendation`, and preserve the existing session counters and boundary bookkeeping.

- [ ] **Step 4: Restrict routing to boundaries**

  In `chat.message`, commit a new target only for the first message or a confirmed boundary. Do not change the target for a tier upgrade, error, or task-type change until the next confirmed task boundary.

- [ ] **Step 5: Make parameter handling observational**

  In `chat.params`, capture the actual provider-qualified model, consume the one-shot pending recommendation, log the task-level recommendation once, and leave `output` untouched. Remove per-turn selection and recommendation generation.

- [ ] **Step 6: Run the focused plugin tests again**

  Run `npm test --workspace=@auto-router/router-core -- tests/plugin.test.ts`.
  Expected: all task-locking and no-mutation tests pass.

### Task 5: Build, deploy, and verify the integration

**Files:**
- Modify: `packages/router-core/tsconfig.json` only if the final integration test import requires the existing build exclusion.
- Deploy generated output to `~/.config/opencode/plugins/router-core/dist/`.

**Interfaces:**
- Production plugin imports the rebuilt `router-core/dist` modules.
- Verification uses the live OpenCode provider catalog and a fresh session, not recursive CLI discovery.

- [ ] **Step 1: Run the complete validation**

  Run `npm run build && npm test` from the repository root.
  Expected: TypeScript exits 0 and all Vitest files pass.

- [ ] **Step 2: Deploy the clean build**

  Remove the generated global `router-core/dist` directory, copy the clean package `dist` directory into it, and verify the deployed JavaScript contains the task strategy and runtime ID logic.

- [ ] **Step 3: Run a verification-task smoke test**

  Start a fresh OpenCode run with a prompt such as `Run no-mistakes and report failures`. Verify the log shows one live-catalog task selection, a free or lowest-cost target, and no repeated target changes while the task continues.

- [ ] **Step 4: Run a planning-task smoke test**

  Start a fresh OpenCode run with `Plan the architecture for this project`. Verify the selected target meets the high-capability floor and is a Sol/Fable/Opus-like model when one is connected.

- [ ] **Step 5: Record final evidence**

  Update this plan's checkboxes, append any new dated decision to the Decision Log, and update `design.md`/`roadmap.md` if runtime verification changes an assumption.
