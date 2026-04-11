# Skill Discovery and Install Safety Design

## Goal

Extend `Find Skills` from a retrieval UI into a staged discovery flow that can:

1. search for skills,
2. review and rank them with the existing Aether model,
3. explain why a result was recommended,
4. run static safety checks before install or update,
5. require explicit user confirmation for high-risk installs or updates.

This phase does not introduce freeform multi-skill orchestration. It only formalizes discovery, explanation, and install-time safety.

## Current Context

The current code already has three useful boundaries:

- `Catalog.search()` in `packages/opencode/src/skill/catalog.ts` handles retrieval, semantic expansion, reranking, and source status.
- `Catalog.describe()` generates short Chinese summaries for result cards.
- `Catalog.install()` and `Catalog.update()` execute installs and updates.

The missing piece is orchestration. Search results can now be found and ranked, but the product still lacks a unified explanation layer and a safety gate before install or update.

## Requirements

### Functional

- `Find Skills` must continue to search local and external sources.
- Search must continue to use the Aether model to review and rerank candidates.
- Recommended results must show a short explanation of why they were surfaced.
- Clicking install or update must trigger a static scan of the skill package content and install script before execution.
- High-risk scan results must not hard-block the action, but must require explicit user confirmation.
- Low- and medium-risk scan results may proceed without an extra confirmation dialog.

### Non-Goals

- No dynamic malware analysis or sandboxed execution in this phase.
- No repository reputation scoring.
- No package ecosystem trust analysis.
- No dependency graph or download-link analysis.
- No autonomous multi-skill workflow execution.

## Approach Options

### Option 1: Frontend-led orchestration

Let the app stitch together `search`, `describe`, `scan`, and `install`.

Pros:

- fewer new backend entry points
- quick to prototype

Cons:

- state becomes fragmented across search, explanation, and install safety
- update flow duplicates install logic
- harder to benchmark and test consistently

### Option 2: Backend-led orchestration with thin UI

Keep orchestration in `Catalog` and expose explicit route-level phases to the app.

Pros:

- one source of truth for search, review, explanation, and safety
- install and update can share the same scan contract
- easier to benchmark, route-test, and evolve later

Cons:

- requires modest schema expansion
- slightly more backend work up front

### Option 3: Fully agentic flow

Let the model decide when to search, explain, and scan without fixed stages.

Pros:

- flexible long-term direction

Cons:

- poor determinism
- weak testability
- too early for the current product state

## Recommendation

Use Option 2.

The existing `Catalog` code already owns the search and review pipeline, so the cleanest extension is to add one more structured phase for explanation and one more structured phase for install-time safety. This preserves current behavior, keeps the UI simple, and leaves a clean seam for later orchestration work.

## Proposed Architecture

The feature is split into two chains.

### 1. Discovery Chain

This powers the `Find Skills` result list.

Stages:

1. `search`
   - retrieve local installed skills, registry results, and external results
2. `review`
   - apply deterministic heuristics plus Aether model reranking
3. `explain`
   - attach a short recommendation reason to surfaced results

Outputs:

- `main` and `more` result groups as today
- source status for local and external search as today
- an additional explanation field for surfaced results

### 2. Safety Chain

This powers install and update actions.

Stages:

1. `prepare`
   - resolve the concrete install or update target
2. `scan`
   - fetch the skill package material needed for static inspection
   - inspect package content and install scripts
3. `decide`
   - map findings to `low`, `medium`, or `high`
   - produce a short Chinese risk summary
4. `confirm`
   - if risk is `high`, require explicit user confirmation
5. `execute`
   - call the existing install or update path

Outputs:

- normalized scan result
- optional confirmation requirement
- existing install job behavior after confirmation

## Data Model Changes

### Search Result

Extend search results with a short explanation field.

Proposed addition to `SearchResult`:

- `why_recommended?: string`

Meaning:

- one short Chinese sentence
- focused on intent match, not marketing copy
- examples:
  - `直接匹配论文润色意图，且功能范围聚焦在论文修改。`
  - `已安装且与浏览器自动化需求直接匹配。`

### Safety Scan

Add a new shared result shape for install and update preflight.

Proposed shape:

- `risk: "low" | "medium" | "high"`
- `summary: string`
- `confirm_required: boolean`

Internal-only detail may also include structured findings for logs and tests, but the UI contract stays minimal.

## Backend Design

### Discovery

Keep `Catalog.search()` as the main discovery entry point.

Changes:

- after `refine()`, attach `why_recommended` for `main` results and optionally `more` results
- explanation generation should prefer deterministic reasons first:
  - exact installed match
  - exact external match
  - semantic paper-polish style intent match
  - scientific plotting style intent match
- only fall back to model-generated phrasing if deterministic reasoning is weak

This avoids turning explanations into unstable prose.

### Safety

Add a new preflight function in `Catalog`, shared by install and update.

Proposed internal entry points:

- `Catalog.scanInstall(input)`
- `Catalog.scanUpdate(input)`

The two functions should normalize to the same internal scanner.

Scanner scope:

- inspect skill package metadata and file content that will be installed
- inspect install scripts or executable setup steps

Scanner should flag patterns such as:

- suspicious shell behavior
- destructive filesystem commands
- hidden background process setup
- network download-and-execute patterns
- credential or token exfiltration patterns
- obfuscated or heavily encoded script fragments

This is a static rule-based scan, not a model-only decision.

### Route Layer

Keep existing routes intact and add an explicit scan route for preflight.

Proposed route:

- `POST /skill/scan`

Supported actions:

- install external skill
- install registry skill
- update installed skill

The route returns the normalized scan result and any message needed for confirmation.

## Frontend Design

### Search Dialog

`DialogFindSkills` should remain responsible for:

- running search
- showing source statuses
- rendering results
- triggering install or update intent

Additions:

- render `why_recommended` beneath the existing title/summary region for main results
- keep current external timeout and error status behavior

### Install or Update Click Flow

New interaction:

1. user clicks install or update
2. app calls `/skill/scan`
3. if `risk` is `low` or `medium`, continue directly to install or update
4. if `risk` is `high`, show a confirmation dialog with:
   - short risk summary
   - cancel button
   - continue install or continue update button
5. if the user confirms, call the existing install or update route

The confirmation dialog intentionally stays simple. It does not expose raw scan findings in this phase.

## Error Handling

### Discovery

- search failure behavior remains as currently implemented
- explanation generation failure must not drop results
- if explanation fails, omit `why_recommended` and keep existing summary behavior

### Safety

- if preflight scan cannot fetch or inspect the package, treat it as `high` risk with a conservative summary
- the user may still continue after explicit confirmation
- scan failure must never silently bypass the preflight gate

This keeps the failure mode safe without fully blocking the user.

## Testing Strategy

### Backend Unit Tests

- explanation generation for exact installed match
- explanation generation for semantic external match
- scan classification for safe script
- scan classification for suspicious shell patterns
- scan classification for destructive commands
- scan failure maps to `high` with `confirm_required = true`

### Route Tests

- `/skill/search` returns `why_recommended` on surfaced results
- `/skill/scan` returns `low`, `medium`, and `high` cases
- `/skill/scan` on fetch or parse failure returns conservative high-risk output

### UI Tests

- search result card shows recommendation reason
- install click on low-risk target proceeds without extra confirm
- install click on high-risk target opens confirmation dialog
- update click on high-risk target opens the same confirmation dialog
- cancelling the confirmation does not start the job

### Benchmark Impact

Search benchmarks remain focused on retrieval quality.

Add one small benchmark layer for explanation quality:

- exact installed query should produce a direct reason
- paper-polish discovery query should produce an intent-based reason
- scientific-plotting discovery query should produce an intent-based reason

Safety scanning is not part of retrieval benchmark scoring. It should have its own deterministic test matrix.

## Rollout Order

1. add explanation field to search results
2. add deterministic explanation generation
3. add scan schema and route
4. implement static scanner rules
5. wire install preflight
6. wire update preflight
7. add confirmation dialog for high-risk cases
8. add tests and focused UI verification

## Open Risks

- external package material may vary in structure, so the scanner needs a clear normalization step
- false positives are likely early on, so summaries must be conservative and short
- explanation quality can become noisy if it relies too heavily on freeform generation; deterministic reasons should stay primary

## Acceptance Criteria

- `Find Skills` still returns correct local and external results
- surfaced results include a short explanation for why they were recommended
- install and update both trigger static preflight scanning
- high-risk results require explicit confirmation before execution
- scan failures do not bypass confirmation
- existing background install job behavior remains unchanged after confirmation
