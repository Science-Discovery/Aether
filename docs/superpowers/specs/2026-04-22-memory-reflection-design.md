# Memory Reflection Design

Date: 2026-04-22

Status update: 2026-05-02. The implemented system adds `memory/inbox/MEMORY.md` as a pending cross-session layer. Durable-looking `memory_write` entries are still written to the current session file first, but may also be mirrored to inbox so new sessions can recall them immediately before daily reflection runs. Scope-specific conflicts are handled with inline `scope(project-...)`, `scope(workspace-...)`, or `scope(session-...)` prefixes instead of resurrecting deprecated scoped long-term files.

Startup catch-up update: if Aether is closed at the scheduled daily reflection time, the next server startup checks the built-in memory reflection job state. When the job is overdue, enabled, and not running, Aether queues one background scheduled reflection immediately after cron recovery. This catch-up is intentionally limited to `builtin-memory-reflection-daily`; ordinary cron jobs keep the existing startup recovery protection and wait for the scheduler tick.

Conflict-resolution update: reflection prompts now explicitly instruct the LLM to resolve duplicates and conflicts before writing durable memory. Explicit entries override inferred entries, narrower scoped entries override conflicting global entries, and partial conflicts should be merged by replacing only the contradicted facet. Local post-processing also deduplicates equivalent daily entries and prevents equivalent `USER.md` entries from being duplicated across `explicit`/`inferred` sources.

## Purpose

Memory reflection turns short-term session memory and pending inbox memory into durable, searchable long-term memory without rewriting the short-term source files. It also keeps `USER.md` current as the global user memory file.

The design intentionally avoids scoped project/workspace `MEMORY.md` as a long-term target. Long-term memory becomes global and date-based, while session memory remains append-only short-term input.

## Current Context

The current memory system has three runtime layers:

- L1 active memory: the prompt content directly injected into the current session. Stable `USER.md` profile entries are included as a small capped baseline; inbox/daily/session memory is injected only after search or automatic recall.
- L2 prepared pool: the session-local searchable memory pool used by `memory_search` and automatic recall.
- L3 disk store: files under the Aether data memory directory.

Current short-term writes go to:

```text
memory/session/<session_id>/MEMORY.md
```

The new reflection pipeline consumes this short-term memory and writes durable outputs elsewhere.

## Storage Model

Reflection uses these paths:

```text
memory/session/<session_id>/MEMORY.md
memory/inbox/MEMORY.md
memory/daily/YYYY-MM-DD/MEMORY.md
memory/user/USER.md
memory/reflection/run/<run_id>.json
```

`memory/session/<session_id>/MEMORY.md` remains untouched by reflection. It is not archived, deleted, sidecar-marked, or rewritten.

`memory/inbox/MEMORY.md` stores pending cross-session memory before daily reflection. Reflection consumes matching inbox entries and clears them after a successful non-dry-run reflection.

`memory/daily/YYYY-MM-DD/MEMORY.md` is the global daily long-term memory file. The implemented file is a flat `# MEMORY` bullet list; each successful non-dry-run reflection merges new validated entries into that list and deduplicates equivalent entries.

`memory/user/USER.md` is the global user memory file. Reflection updates it through validated patches.

The following scoped long-term memory paths are deprecated and no longer read or written by the new system:

```text
memory/scope/<scopeKey>/MEMORY.md
memory/scope/<scopeKey>/ABSTRACT.md
```

## Entry Format

All new memory entries use one unified format:

```text
kind[source]: content
```

Allowed kinds:

```text
fact
preference
task
```

`USER.md` allows:

```text
explicit
inferred
```

Daily memory allows only:

```text
explicit
```

Examples:

```text
fact[explicit]: Aether memory uses an L1/L2/L3 cache architecture.
preference[inferred]: User prefers interactive design confirmation before implementation.
task[explicit]: Implement memory reflection with a global daily cron job.
```

Old USER kinds are not compatible with the new format:

```text
style
workflow
constraint
capability
```

These concepts should be represented as `preference`, `fact`, or `task`.

## Reflection Triggers

There are two supported triggers:

- Manual: the user or agent calls `memory_reflect`.
- Cron: the built-in daily global cron calls `memory_reflect`.

Both triggers use the same backend LLM reflection pipeline.

The `memory_reflect` tool accepts:

```ts
{
  scope?: "current_session" | "current_scope" | "global"
  dry_run?: boolean
  trigger?: "manual" | "cron"
}
```

Defaults:

```text
manual trigger: scope = current_session
cron trigger:   scope = global
dry_run:        false
```

`scope` controls which session short-term memory files and pending inbox entries are considered as candidates. Output remains global:

```text
memory/daily/YYYY-MM-DD/MEMORY.md
memory/user/USER.md
```

## Built-In Daily Cron

Server startup ensures a hard-coded global cron job exists:

```text
id: builtin-memory-reflection-daily
name: Daily memory reflection
enabled: true
mode: direct
schedule_type: cron
schedule_value: 0 3 * * *
timezone: local
payload.action: memory_reflect
payload.scope: global
payload.dry_run: false
payload.trigger: cron
```

If the job already exists, startup must not overwrite user-edited name, schedule, timezone, mode, or payload. It may only synchronize `enabled` with `memory.enabled`.

`memory.enabled=false` disables this cron job but does not delete it.

`memory.enabled=true` re-enables this cron job.

Manually disabling the cron job does not turn off `memory.enabled`.

## Configuration

The memory config is simplified to:

```ts
memory: {
  enabled: boolean
  memory_reflection_model?: {
    providerID: string
    modelID: string
  }
}
```

`session_search` and `session_read` are intentionally not part of the memory tool surface. The model should recall durable context from memory files only, not from old session message bodies.

Removed memory config fields:

```text
user_profile_enabled
user_profile_include_inferred
memory_reflection_enabled
```

The config loader should remove these legacy fields from user config files. They are not mapped to new fields because their old meanings are not equivalent to `memory.enabled` or the new cron-controlled reflection behavior.

When `memory.enabled=false`:

- Do not inject memory context.
- Do not run automatic recall.
- `memory_search`, `memory_write`, and `memory_reflect` return disabled.
- Do not read USER, daily memory, scoped memory, or session memory into the L2 pool.
- Disable the built-in daily reflection cron job.

## Candidate Selection

Daily reflection scans all session memory files and pending inbox memory:

```text
memory/session/*/MEMORY.md
memory/inbox/MEMORY.md
```

The backend checks file metadata such as mtime and hash for session files, and only passes files modified today to the LLM. Pending inbox entries are included directly by scope filtering.

If no session candidate files were modified today and no inbox entries match the scope:

- Do not call the LLM.
- Write a reflection run log with status `skipped`.

Manual reflection scopes:

- `current_session`: current session short-term memory file + inbox entries with `scope(session-<id>)`. Unscoped and `scope(global)` inbox entries are intentionally left for global reflection so one session cannot accidentally consume another session's same-text pending memory.
- `current_scope`: session memory files associated with the current effective project/workspace scope + inbox entries visible in the same scope.
- `global`: all session memory files modified today + all inbox entries.

## LLM Reflection Output

The LLM must return structured JSON:

```ts
type ReflectionResult = {
  daily_memory: Array<{
    kind: "fact" | "preference" | "task"
    content: string
  }>
  user_patches: Array<
    | {
        op: "add"
        kind: "fact" | "preference" | "task"
        source: "explicit" | "inferred"
        content: string
      }
    | {
        op: "replace"
        match: string
        kind: "fact" | "preference" | "task"
        source: "explicit" | "inferred"
        content: string
      }
    | {
        op: "remove"
        match: string
        reason: string
      }
  >
  summary: string
}
```

Daily entries are serialized as explicit entries only:

```text
fact[explicit]: ...
preference[explicit]: ...
task[explicit]: ...
```

USER patches are serialized as:

```text
kind[source]: content
```

The backend validates every kind, source, operation, and content field before writing. Invalid patches are rejected and recorded in the run log.

## Application Rules

For daily memory:

- Merge validated new entries into `memory/daily/YYYY-MM-DD/MEMORY.md`.
- Preserve existing entries and deduplicate equivalent content.
- Keep run metadata in `memory/reflection/run/<run_id>.json`, not in the daily memory file.

Example:

```md
# MEMORY
- fact[explicit]: Aether memory reflection uses a global daily cron.
- preference[explicit]: User wants short-term memory left untouched.
- task[explicit]: Implement daily memory files and USER patches.
```

For `USER.md`:

- `add` appends a validated entry unless an equivalent entry already exists.
- `replace` finds an entry by substring match and replaces it with the validated entry.
- `remove` finds an entry by substring match and removes it.
- Ambiguous `replace` or `remove` matches should be rejected rather than guessed.

For `dry_run=true`:

- Do not write daily memory.
- Do not modify `USER.md`.
- Still write a run log containing the proposed result.

## L2 Pool Integration

When building a new session L2 prepared pool, read:

```text
memory/user/USER.md
memory/inbox/MEMORY.md
memory/session/<session_id>/MEMORY.md
memory/daily/<recent 30 active dates>/MEMORY.md
```

Do not read:

```text
memory/scope/<scopeKey>/MEMORY.md
memory/scope/<scopeKey>/ABSTRACT.md
```

“Recent 30 active dates” means the most recent 30 dates that actually have a daily memory file. Empty calendar days do not count.

## UI

Settings > Memory should show:

- Active session memory (L1), including active entries and prompt preview.
- Pending inbox memory waiting for reflection.
- USER memory grouped by `fact`, `preference`, and `task`, with source labels.
- Daily memory for the most recent 30 active dates, grouped by date in reverse chronological order.

The old scoped MEMORY store card should be removed.

The old “include inferred profile” and “reflection enabled” controls should be removed. Memory availability is controlled by `memory.enabled`. Automatic reflection is controlled by the built-in cron job’s enabled state.

## Cron Integration

Register `memory_reflect` as a cron direct action, and run it inside `Instance.provide`:

```ts
registerDirectAction("memory_reflect", async (payload) => {
  return Instance.provide({
    directory: typeof payload.directory === "string" ? payload.directory : Global.Path.data,
    init: InstanceBootstrap,
    fn: () =>
      Memory.reflect({
        trigger: "cron",
        scope: payload.scope ?? "global",
        dry_run: payload.dry_run ?? false,
      }),
  })
})
```

The cron system should not know memory internals beyond this direct action interface.

## Run Log

Each reflection run writes:

```text
memory/reflection/run/<run_id>.json
```

The log should include:

```ts
{
  run_id: string
  trigger: "manual" | "cron"
  scope: "current_session" | "current_scope" | "global"
  dry_run: boolean
  started_at: number
  finished_at: number
  status: "success" | "failed" | "skipped"
  scanned_files: string[]
  candidate_files: string[]
  model?: {
    providerID: string
    modelID: string
  }
  result?: ReflectionResult
  applied?: {
    daily_memory_entries: number
    user_patches: number
  }
  errors: string[]
  summary: string
}
```

## Error Handling

If `memory.enabled=false`, reflection returns disabled and does not call the LLM.

If no candidate files exist, reflection writes a skipped run log and returns skipped.

If model resolution fails, reflection writes a failed run log and returns the error.

If the LLM returns invalid JSON or invalid entries, reflection records validation errors. Valid patches may be applied only if partial application is explicitly safe; otherwise v1 should fail the run before writing.

If writing daily memory or USER fails, reflection writes a failed run log. The implementation should prefer write order that avoids partially applying `USER.md` after daily memory fails.

## Testing Strategy

Backend tests:

- `memory.enabled=false` disables memory prompt, tools, and default reflection cron.
- Startup creates `builtin-memory-reflection-daily` only if absent.
- Existing built-in cron schedule/payload/name are not overwritten.
- Cron direct action calls the same reflection pipeline.
- Reflection skips LLM when no session memory was modified today.
- Reflection merges daily memory entries in the unified format.
- Reflection applies validated USER patches.
- Invalid USER patch kind/source is rejected.
- L2 pool reads recent 30 active daily files and does not read scoped MEMORY.

Frontend tests:

- Settings > Memory displays active L1 memory.
- USER entries are grouped by `fact`, `preference`, and `task`.
- Daily memory displays recent 30 active dates.
- Removed controls are no longer rendered.

## Non-Goals

V1 does not:

- Rewrite short-term session memory.
- Archive short-term session memory.
- Maintain short-term sidecar state.
- Rewrite scoped project/workspace MEMORY.
- Use embeddings or vector search.
- Build a dedicated reflection history UI beyond data needed for future UI.

## Spec Self-Review

- Placeholder scan: no TBD/TODO placeholders remain.
- Consistency check: storage, config, cron, tool, and UI sections all use the same global daily memory design.
- Scope check: this is one implementation project, with clear backend, cron, L2, and UI slices.
- Ambiguity check: old USER/scoped MEMORY compatibility is intentionally not supported; this is explicit above.
