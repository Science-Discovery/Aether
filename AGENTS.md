- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Local Memory Work Records

These files are project-local working records for the Aether memory-system redesign. They are local-only by default and should not be pushed unless the user explicitly asks.

- If present, for recent memory-system changes, read `memory-improvement-log.zh-CN.md` first; `memory-improvement-log.en.md` is the English companion for AI handoff.
- If present, for unresolved memory-system questions, read `memory-open-questions.zh-CN.md` first; `memory-open-questions.en.md` is the English companion.
- If present, for implementation handoff batches, read `memory-work/README.zh-CN.md` or `memory-work/README.en.md`, then open the relevant timestamped subdirectory under `memory-work/`.
- Do not duplicate cross-batch overview files inside `memory-work/`; root-level `memory-improvement-log.*.md` and `memory-open-questions.*.md` are the overview layer.
- When the user asks what can be handled next, inspect `memory-open-questions.zh-CN.md` and the latest `memory-work/*/open-questions.zh-CN.md` files.
- When the user asks what changed recently, inspect `memory-improvement-log.zh-CN.md` and the latest relevant `memory-work/*/implementation.zh-CN.md` files.
- When recording decisions or handoff material, update both Chinese and English files in the same batch.
- Keep `memory-work/` organized by timestamped implementation batch directories, each with `plan.*.md`, `implementation.*.md`, `handoff-prompt.*.md`, and `open-questions.*.md`.
- Before writing a plan, implementation file, or handoff prompt, make boundaries explicit: confirmed scope, non-goals, unresolved questions, success criteria, validation commands, and files allowed to change.
- Do not leave ambiguous behavior for a future AI to invent. If a detail is not decided, record it as an open question or exclude it from the current batch.
- Handoff prompts must be executable and conservative: state what to read, what to implement, what not to implement, what tests to add, and what records to update after implementation.
- After changing implementation files, planning files, local records, or handoff prompts, perform a self-check against the relevant `AGENTS.md`, `memory-work/README.*.md`, current batch files, and open-question files. Fix clear noncompliance immediately; ask the user only for unclear product or workflow decisions.
- Before giving a prompt to the user, re-read the final prompt and confirm it does not leave implementation boundaries, success criteria, validation, record updates, or allowed changed files ambiguous.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.
