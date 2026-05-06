# Parallel Agents Demo

This file demonstrates the new parallel agent capabilities in Aether. The implementation covers three execution modes and a comprehensive discipline system for sub-agent control.

## Key Features Implemented

1. **Permission.intersection()** — Sub-agent permissions are capped by parent permissions (security fix)
2. **Delegation depth** — Prevents infinite delegation chains with a depth counter
3. **Three execution modes** — serial, concurrent, background
4. **Background execution** — Spawn tasks that run independently; retrieve results via `background_output` tool
5. **Dynamic permission overrides** — Per-task permission adjustment capped by parent
6. **File scope** — Restrict sub-agent file access to specific glob patterns
7. **max_steps, timeout_seconds, return_format** — Behavior boundary controls

## Usage Examples

### Example 1: Parallel Search (Concurrent Mode)

When the LLM makes 3 task tool calls in a single response, the AI SDK already executes them concurrently via `Promise.all`. The `mode` parameter helps the system understand the intent:

```
// LLM calls these 3 task tools in one turn:
task({ description: "Search auth", prompt: "Find the authentication implementation", subagent_type: "explore", mode: "concurrent" })
task({ description: "Search API", prompt: "Find the API route definitions", subagent_type: "explore", mode: "concurrent" })
task({ description: "Search DB", prompt: "Find the database schema definitions", subagent_type: "explore", mode: "concurrent" })

// All 3 execute concurrently — no serial waiting
// Main agent receives all results at once and can synthesize
```

### Example 2: Background Task (Background Mode)

Spawn a long-running search task and continue working:

```
task({
  description: "Deep search",
  prompt: "Comprehensive analysis of the error handling patterns across the entire codebase",
  subagent_type: "explore",
  mode: "background",
  timeout_seconds: 120,
})

// Main agent continues immediately
// Later, when ready:
background_output({ task_id: "<returned-task-id>" })
```

### Example 3: Restricted Sub-Agent (Discipline Controls)

Launch a sub-agent with strict constraints:

```
task({
  description: "Fix auth bug",
  prompt: "Fix the JWT validation bug in src/auth/validate.ts",
  subagent_type: "general",
  mode: "serial",
  permission_override: { edit: ["allow", "src/auth/**"] },
  file_scope: ["src/auth/**", "test/auth/**"],
  max_steps: 5,
  delegation_depth: 0,
})
// Sub-agent can only edit files in src/auth/** and read test/auth/**
// Max 5 steps, cannot delegate further
```

### Example 4: Autonomous Sub-Agent (Deep Delegation)

```
task({
  description: "Refactor module",
  prompt: "Refactor the payment module to use the new transaction model",
  subagent_type: "general",
  mode: "serial",
  permission_override: { edit: ["allow"], bash: ["allow"] },
  delegation_depth: 1,
  max_steps: 20,
})
// Sub-agent can edit any file, run bash, and delegate one more layer
// Its children will have delegation_depth: 0 (cannot delegate further)
```

## Architecture Summary

### Files Changed

| File                        | Change                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `permission/index.ts`       | Added `intersection()`, `fromOverride()`, `evaluateWithScope()`, `FILE_TOOLS`              |
| `tool/task.ts`              | Added discipline parameters, intersection-based permission, mode branching                 |
| `tool/background-output.ts` | New: background_output tool                                                                |
| `tool/registry.ts`          | Registered BackgroundOutputTool                                                            |
| `session/discipline.ts`     | New: Discipline schema + fromOverride()                                                    |
| `session/background.ts`     | New: BackgroundTask namespace (spawn/output/status)                                        |
| `session/message-v2.ts`     | SubtaskPart extended with `discipline` field                                               |
| `session/index.ts`          | Info extended with delegationDepth, maxSteps, fileScope; create/createNext updated         |
| `session/session.sql.ts`    | DB columns added: delegation_depth, max_steps, file_scope                                  |
| `session/prompt.ts`         | Loop handles background SubtaskParts; maxSteps uses session.maxSteps; PromptInput extended |

### How Parallel Execution Works

1. **LLM-initiated task calls**: The AI SDK already executes multiple tool calls in one response concurrently via `Promise.all`. Each `task` tool call creates an independent child session and runs `SessionPrompt.prompt()` independently.

2. **Command-driven SubtaskParts**: When commands create SubtaskParts, the loop now spawns background SubtaskParts immediately (without blocking) and processes foreground subtasks normally.

3. **Background mode**: The `BackgroundTask.spawn()` function creates a child session and runs `SessionPrompt.prompt()` asynchronously, storing results in an in-memory buffer pool. The `background_output` tool retrieves results when the main agent is ready.

### Permission Security Model

```
Parent deny X → Sub-agent MUST deny X (intersection cap)
Parent allow X → Sub-agent MAY deny X (stricter is ok)
Sub-agent NEVER gains permissions the parent lacks
```

This replaces the previous `merge()` (flat concatenation) which allowed sub-agents to gain permissions the parent didn't have.
