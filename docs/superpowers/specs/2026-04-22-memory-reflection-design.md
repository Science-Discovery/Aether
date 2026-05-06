# Memory Reflection Implementation Spec

Date: 2026-04-22
Current status: implemented in `feat/memory-inbox-scope-dev`.

This document records the current implementation contract for Aether memory reflection. Historical design alternatives and deprecated scoped memory files are intentionally omitted here; see `docs/memory-system.zh-CN.md` for user-facing behavior.

## Goal

Reflection consolidates short-term session memory and pending inbox memory into durable memory without reading old session transcripts.

It writes durable outputs to:

- `memory/daily/YYYY-MM-DD/MEMORY.md`
- `memory/user/USER.md`
- `memory/reflection/run/<run_id>.json`

It never rewrites:

- `memory/session/<session_id>/MEMORY.md`

## Runtime Layers

- L1 active memory: the system prompt fragment actually injected into the current session. It contains a capped `USER.md` baseline plus searched/recalled active entries.
- L2 prepared pool: a per-session searchable pool loaded from disk. `memory_search` and automatic recall read this pool.
- L3 disk store: the source files under Aether's memory directory.

## Disk Layout

```text
memory/user/USER.md
memory/inbox/MEMORY.md
memory/daily/YYYY-MM-DD/MEMORY.md
memory/session/<session_id>/MEMORY.md
memory/reflection/run/<run_id>.json
```

Deprecated and not read by the current pool:

```text
memory/scope/<scopeKey>/MEMORY.md
memory/scope/<scopeKey>/ABSTRACT.md
```

## Entry Format

All durable `USER.md` and daily memory entries use:

```text
kind[source]: content
kind[source]: scope(...): content
```

Allowed `kind` values:

- `fact`
- `preference`
- `task`

Allowed `source` values:

- `USER.md`: `explicit | inferred`
- daily memory: `explicit` only

Supported scopes:

- no scope or `scope(global)`: visible everywhere
- `scope(project-...)`: visible only in the matching project scope
- `scope(workspace-...)`: visible only in the matching workspace scope
- `scope(session-...)`: visible only in the matching session

## Write Path

`memory_write` always writes to current session short-term memory first.

Durable-looking notes may also be mirrored to `memory/inbox/MEMORY.md` so a new session can find them through `memory_search` before reflection runs. The inbox is guarded by a write lock to avoid cross-session read-modify-write loss.

`memory_write` does not directly edit `USER.md` or daily memory.

## Search And Injection

At session start, the memory system prepares the L2 pool from:

```text
USER.md
pending inbox
recent 30 active daily memory files
current session short-term memory
```

The full pool is not injected. Only these enter L1:

- capped stable `USER.md` baseline
- `memory_search` hits
- automatic recall hits
- current-session write hits

`memory_search` splits common separators and treats any keyword hit as a candidate. Hits are pinned into L1 for the rest of the session.

`memory_reload` rebuilds L2 and clears L1 active memory.

## Reflection Triggers

Manual tool calls:

```ts
memory_reflect({
  scope?: "current_session" | "current_scope" | "global"
  dry_run?: boolean
})
```

Defaults:

- manual: `scope=current_session`, `dry_run=false`
- cron: `scope=global`, `dry_run=false`

Cron calls the same reflection pipeline through the direct action `memory_reflect`.

## Reflection Candidate Selection

Session files:

- `current_session`: only `memory/session/<session_id>/MEMORY.md`
- `current_scope`: today's session files belonging to the current project/workspace scope
- `global`: all today's session files

Inbox entries:

- `current_session`: only entries explicitly scoped as `scope(session-<session_id>)`
- `current_scope`: entries visible in the current project/workspace/session scope
- `global`: all inbox entries

Unscoped and `scope(global)` inbox entries are intentionally left to global reflection when running `current_session`. This prevents one session from consuming another session's same-text pending memory.

If no candidate session entries and no matching inbox entries exist, reflection writes a skipped run log and does not call the LLM.

## LLM Output

The reflection model returns structured data:

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

Prompt policy requires the model to:

- merge duplicates before writing
- prefer explicit over inferred
- prefer narrower scoped memory over conflicting global memory
- replace or remove existing profile entries instead of adding conflicting duplicates
- preserve non-conflicting details in partial conflicts

## Local Post-Processing

The backend validates every output field before writing.

Daily memory:

- serializes every LLM daily item as `kind[explicit]: content`
- writes a flat `# MEMORY` bullet list
- preserves existing entries
- deduplicates equivalent entries with scope-aware keys

`USER.md`:

- applies validated add/replace/remove patches
- deduplicates equivalent entries with scope-aware keys
- upgrades equivalent inferred entries to explicit when an explicit patch appears

Inbox:

- removes reflected inbox entries after successful non-dry-run reflection
- invalidates prepared snapshots after inbox cleanup
- prunes stale inbox entries from existing L1 active memory

Dry run:

- writes a run log
- does not edit daily memory, `USER.md`, or inbox

## Built-In Cron

Server recovery ensures this editable job exists:

```json
{
  "id": "builtin-memory-reflection-daily",
  "name": "Daily memory reflection",
  "mode": "direct",
  "schedule_type": "cron",
  "schedule_value": "0 3 * * *",
  "payload": {
    "action": "memory_reflect",
    "scope": "global",
    "dry_run": false,
    "trigger": "cron"
  }
}
```

If the job already exists, recovery preserves user-edited schedule, timezone, mode, name, and payload. It only synchronizes the runtime enabled state with `memory.enabled`.

If Aether was closed at the scheduled time, the next server startup checks this built-in job. If it is overdue, enabled, and not running, Aether queues one background scheduled reflection. This catch-up behavior applies only to `builtin-memory-reflection-daily`; ordinary cron jobs keep the existing startup protection and wait for the scheduler tick.

The cron direct action executes reflection inside `Instance.provide` using `Global.Path.data` unless the payload explicitly supplies a directory. This keeps the global built-in job from inheriting arbitrary server startup cwd project config.

## Configuration

Current fields:

```ts
memory: {
  enabled: boolean
  memory_reflection_model?: {
    providerID: string
    modelID: string
  }
}
```

When `memory.enabled=false`:

- no memory context is injected
- automatic recall is disabled
- memory tools return disabled or empty behavior
- built-in daily reflection is disabled

Legacy fields are removed from config during cleanup:

```text
memory_reflection_enabled
user_profile_enabled
user_profile_include_inferred
memory_management_model
user_profile_history_extract_enabled
user_profile_history_extract_limit
```

## Tool Surface

Agent tools:

- `memory_write`: write current-session short-term memory; durable-looking notes may mirror to inbox.
- `memory_search`: search L2 and pin hits into L1.
- `memory_reload`: rebuild L2 and clear L1.
- `memory_reflect`: run manual reflection.
- `memory_read`: explicit memory-management reads only.
- `memory_list`: explicit memory-management listing only.

Generic file tools are blocked from reading Aether memory storage. Agents should use `memory_search` for recall instead of `read`, `glob`, `grep`, or shell commands over memory files.

## HTTP Surface

`GET /memory` returns:

- `settings`
- `user`
- `inbox`
- `memory`
- `daily`
- optional `active` when `session_id` query is supplied

The generated SDK exposes `Memory.get({ session_id })` for typed access to active L1 memory.

## Verification

Focused commands:

```bash
cd packages/opencode && bun test test/memory/memory-system.test.ts
cd packages/opencode && bun test test/cron/cron.test.ts
cd packages/opencode && bun run typecheck
cd packages/app && bun run typecheck
cd packages/app && bun run ./script/vitest.ts run --config ./vitest.config.ts src/components/settings-memory.vitest.tsx
```

Full backend command:

```bash
cd packages/opencode && bun test --timeout 30000
```

Current known non-goals:

- no embedding or vector search
- no old session transcript search/read path
- no scoped long-term `MEMORY.md` or `ABSTRACT.md`
- no dedicated reflection-history UI
