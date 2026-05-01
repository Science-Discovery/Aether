# Custom Agent Modes Design

## Summary

Enable users to define custom primary agent modes (like `research`) via `.opencode/agent/*.md` configuration files, without modifying source code. Research mode is the first validation case.

## Motivation

Aether currently supports `build` and `plan` as hardcoded primary agents. Users can define subagents via `.opencode/agent/*.md`, but cannot create new primary modes. This limits the system to a binary workflow: plan (read-only) → build (full access).

Adding a `research` mode (deep literature search, analysis, detailed research plans) and enabling user-defined primary agents requires a generalized mode-switching infrastructure.

## Current Architecture

- `build`: primary, full permissions, `plan_enter` tool
- `plan`: primary, read-only + `.aether/plans/*.md` write, `plan_exit` tool
- `general`: subagent, multi-step tasks
- `explore`: subagent, fast codebase search
- Hardcoded in `agent.ts` with `native: true`
- Mode switching: `plan_enter`/`plan_exit` as dedicated tools, prompt injection in `prompt.ts`

## Design

### 1. Agent Schema Extension

Extend `Config.Agent` schema to support primary agent creation from config/md files:

```ts
// New fields added to Agent schema
fallback_models: z.array(z.union([z.string(), FallbackModelEntry])).optional()
mcp: z.record(z.string(), z.boolean()).optional()
enter_description: z.string().optional() // Description for mode_enter tool
exit_description: z.string().optional() // Description for mode_exit tool
exit_options: z.array(ExitOption).optional() // Custom exit destinations
```

`FallbackModelEntry`:

```ts
z.object({
  model: z.string(),
  variant: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  thinking: z.object({ type: z.string(), budgetTokens: z.number().optional() }).optional(),
  reasoningEffort: z.string().optional(),
  maxTokens: z.number().optional(),
})
```

`ExitOption`:

```ts
z.object({
  label: z.string(),
  agent: z.string(), // Target agent name
  description: z.string(),
})
```

### 2. Primary Agent Registration from MD Files

Currently `.opencode/agent/*.md` frontmatter only supports `mode: subagent`. Extend `loadAgent()` to:

- Accept `mode: primary` or `mode: all` from frontmatter
- Register primary agents into the `agents` dict with full switching capabilities
- Generate `xxx_enter` and `xxx_exit` tools dynamically
- Add permission entries for the enter/exit tools

Example md file:

```markdown
---
description: Deep research, literature search, and analysis mode
color: "#7C3AED"
mode: primary
permission:
  edit: deny
  bash: deny
  websearch: allow
  knowledge_search: allow
  question: allow
enter_description: Use when the user's request would benefit from deep research and literature search before planning or implementation
exit_description: Use when research is complete and ready to move to planning or implementation
exit_options:
  - label: Plan
    agent: plan
    description: Switch to plan agent to create an implementation plan
  - label: Build
    agent: build
    description: Switch to build agent to start implementing
fallback_models:
  - openai/gpt-5.4
  - model: kimi-for-coding/k2p5
    variant: high
mcp:
  arxiv-search: true
prompt_append: |
  You are a research specialist...
---
```

### 3. Generic Mode Switching Mechanism

Replace hardcoded `plan_enter`/`plan_exit` pattern with a generic `ModeSwitchTool` factory:

```ts
// For each primary agent with enter/exit descriptions,
// dynamically create two tools:
function createModeTools(agentName: string, config: AgentConfig) {
  const enterTool = Tool.define(`${agentName}_enter`, {
    description: config.enter_description,
    parameters: z.object({}),
    // Ask user to confirm switch, inject permission prompt
  })

  const exitTool = Tool.define(`${agentName}_exit`, {
    description: config.exit_description,
    parameters: z.object({}),
    // Ask user which destination, create synthetic message for target agent
  })

  return { enterTool, exitTool }
}
```

This replaces the need to write a dedicated `.ts` file for each mode's enter/exit.

For `plan`, the existing `PlanExitTool` remains but its internals migrate to the generic pattern. `PlanEnterTool` (currently commented out) can be revived via the generic mechanism.

### 4. Prompt Injection for Custom Modes

Extend `prompt.ts` mode-switching logic:

When entering a custom primary agent:

1. Inject permission restrictions (from agent config)
2. Inject agent's `prompt` or `prompt_append`
3. Inject mode-specific system reminder (if `prompt_file` exists in `session/prompt/`)
4. Inject file write permissions for mode-specific output directory (e.g., `.aether/research/*.md`)

When exiting (switching from custom agent to build):

1. Inject `BUILD_SWITCH`-style reminder
2. Reference the output file (research report / plan file)

### 5. Research Agent Configuration (Validation Case)

File: `.opencode/agent/research.md`

Key design decisions:

- **Permission**: read-only + websearch + knowledge_search + question + todowrite
- **Output**: `.aether/research/*.md` (only writable file path)
- **Workflow**: 5 phases (Intent → Parallel Search → Analysis → Report → Exit)
- **Exit options**: plan, build, stay
- **Subagent delegation**: can call `general` and `explore` for parallel research
- **Cannot**: edit code, run bash, make commits

### 6. Fallback Models

When the primary model for a custom agent fails (429, 503, 529), automatically try the next model in the `fallback_models` chain. Each fallback entry can have its own variant, temperature, thinking config.

Priority: UI-selected model → user config model → fallback chain → system default.

### 7. Skill-Embedded MCP

When a custom agent declares `mcp` in its config:

- On mode enter: activate declared MCPs, add their tools to agent's available tools
- On mode exit: deactivate, remove tools
- MCPs remain scoped to the agent session, not polluting build agent's context

## Phase Plan

| Phase   | Scope                                                              | Dependency |
| ------- | ------------------------------------------------------------------ | ---------- |
| Phase 1 | Branch creation from `upstream/dev`                                | -          |
| Phase 2 | Agent schema extension + primary agent registration from md        | Phase 1    |
| Phase 3 | Generic mode switching (ModeSwitchTool factory + prompt injection) | Phase 2    |
| Phase 4 | Research agent md config + research_exit tool + prompt files       | Phase 3    |
| Phase 5 | Fallback models chain                                              | Phase 4    |
| Phase 6 | Skill-embedded MCP per-agent                                       | Phase 4    |
| Phase 7 | UI design (after backend validation)                               | Phase 4-6  |

## Acceptance Criteria

Phase 2: User can declare `mode: primary` in `.opencode/agent/*.md`, agent appears in UI dropdown selector and can be switched to.

Phase 3: Any primary agent can be entered/exited via `xxx_enter`/`xxx_exit` tools generated dynamically. `plan_exit` behavior preserved.

Phase 4: Research mode works end-to-end: select in UI → read-only research → write report to `.aether/research/*.md` → exit to plan or build.

Phase 5: Research agent with fallback_models configured can auto-degrade when primary model is unavailable.

Phase 6: Research agent's `mcp: { arxiv-search: true }` activates arxiv-search MCP only during research mode.

## What We're NOT Doing (YAGNI)

- UI for agent creation (deferred to Phase 7)
- Hash-anchored edit tool (separate feature, not part of this plan)
- Parallel background agent system (separate feature)
- Intent Gate pre-classification (separate feature)
- Replacing build/plan with Sisyphus-like orchestrator (preserving native design)
