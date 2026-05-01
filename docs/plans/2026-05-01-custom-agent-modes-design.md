# Custom Agent Modes Design

## Summary

Enable users to define custom primary agent modes (like `research`) via `.aether/agent/*.md` configuration files, without modifying source code. Research mode is the first validation case. A dedicated skill (`custom-agent-designer`) will assist users in designing agent structures through interactive dialogue.

## Motivation

Aether currently supports `build` and `plan` as hardcoded primary agents. Users can define subagents via `.aether/agent/*.md`, but cannot create new primary modes. This limits the system to a binary workflow: plan (read-only) → build (full access).

Adding a `research` mode (deep literature search, analysis, detailed research plans) and enabling user-defined primary agents requires a generalized mode-switching infrastructure.

## Current Architecture

- `build`: primary, full permissions, `plan_enter` tool
- `plan`: primary, read-only + `.aether/plans/*.md` write, `plan_exit` tool
- `general`: subagent, multi-step tasks
- `explore`: subagent, fast codebase search
- Hardcoded in `agent.ts` with `native: true`
- Mode switching: `plan_enter`/`plan_exit` as dedicated tools, prompt injection in `prompt.ts`
- Agent config: catchall schema in `config.ts`, `.aether/agent/*.md` frontmatter for subagents

## OMO Features We're Borrowing

Lessons from Oh-My-OpenCode (OMO) that informed this design:

| OMO Feature                                                  | What We Borrow                                                                               | How We Adapt It                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Category system** (domain-specific model routing)          | `fallback_models` with per-entry variant/temperature/thinking                                | Not a separate category layer — embedded directly in agent config, since Aether agents are freely named (catchall schema)  |
| **Skill-Embedded MCP** (on-demand MCP per skill)             | `mcp` field in agent config, activate/deactivate on mode switch                              | Applied to agent modes instead of skills — MCPs scoped to the agent session                                                |
| **Permission templates** (Oracle=read-only, Explore=no-edit) | `permission` field in agent md frontmatter                                                   | Users define custom permission sets; no hardcoded templates, but the design enables preset patterns                        |
| **prompt_append vs prompt replacement**                      | Both `prompt` (full replacement) and `prompt_append` (incremental) supported in agent config | Same as OMO, but also supports `file://` URIs for both fields                                                              |
| **fallback_models mixed array**                              | `fallback_models` accepts strings + objects with per-model settings                          | Identical design; each fallback entry can have its own variant, thinking, temperature                                      |
| **Mode enter/exit tools** (plan_enter/plan_exit)             | Generic `ModeSwitchTool` factory generating `xxx_enter`/`xxx_exit`                           | OMO hardcodes Sisyphus entry; we make it configurable per agent via `enter_description`/`exit_description`/`exit_options`  |
| **Custom categories with description**                       | `enter_description` shown in tool description for LLM to decide when to switch               | Instead of "category shown in task() prompt", we use "description shown in enter tool" — same purpose, different mechanism |

**What we deliberately don't borrow from OMO:**

| OMO Feature                      | Why Not                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| Fixed 11 agent names             | Aether's catchall schema allows any agent name; md file defines it |
| Sisyphus replaces build          | Aether preserves native build/plan as default modes                |
| Intent Gate (pre-classification) | Deferred — separate feature, not part of this plan                 |
| Hash-Anchored Edit (Hashline)    | Separate feature, not part of this plan                            |
| Parallel background agents       | Separate feature, not part of this plan                            |
| Ralph Loop / Todo Enforcer       | Separate feature, not part of this plan                            |

## Design

### 1. Agent Schema Extension

Extend `Config.Agent` schema to support primary agent creation from config/md files:

```ts
// New fields added to Agent schema in config.ts
fallback_models: z.array(z.union([z.string(), FallbackModelEntry])).optional()
mcp: z.record(z.string(), z.boolean()).optional()
enter_description: z.string().optional() // Shown as xxx_enter tool description
exit_description: z.string().optional() // Shown as xxx_exit tool description
exit_options: z.array(ExitOption).optional() // Destinations offered on exit
```

`FallbackModelEntry` (borrowed from OMO's mixed array design):

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

Currently `.aether/agent/*.md` frontmatter only supports `mode: subagent`. Extend `loadAgent()` to:

- Accept `mode: primary` or `mode: all` from frontmatter
- Register primary agents into the `agents` dict with full switching capabilities
- Generate `xxx_enter` and `xxx_exit` tools dynamically via `ModeSwitchTool` factory
- Add permission entries for the enter/exit tools
- Parse `fallback_models`, `mcp`, `enter_description`, `exit_description`, `exit_options` from frontmatter

Example md file (research agent):

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
  todowrite: allow
  research_exit: allow
  plan_enter: allow
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

Replace hardcoded `plan_enter`/`plan_exit` pattern with a generic `ModeSwitchTool` factory (inspired by OMO's agent invocation but generalized):

```ts
function createModeTools(agentName: string, config: AgentConfig) {
  const enterTool = Tool.define(`${agentName}_enter`, {
    description: config.enter_description ?? `Switch to ${agentName} agent`,
    parameters: z.object({}),
    async execute(_params, ctx) {
      // Ask user to confirm switch
      const answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: [{
          question: `Would you like to switch to the ${agentName} agent?`,
          header: `${agentName} mode`,
          options: [
            { label: "Yes", description: config.description ?? `Switch to ${agentName} agent` },
            { label: "No", description: "Stay with current agent" },
          ],
        }],
      })
      if (answers[0]?.[0] === "No") throw new Question.RejectedError()
      // Create synthetic user message targeting the new agent
      const model = await getLastModel(ctx.sessionID)
      const userMsg = { id: MessageID.ascending(), sessionID: ctx.sessionID, role: "user", time: { created: Date.now() }, agent: agentName, model }
      await Session.updateMessage(userMsg)
      await Session.updatePart({ ... synthetic text ... })
      return { title: `Switching to ${agentName}`, output: `Wait for further instructions.`, metadata: {} }
    },
  })

  const exitTool = Tool.define(`${agentName}_exit`, {
    description: config.exit_description ?? `Exit ${agentName} mode`,
    parameters: z.object({}),
    async execute(_params, ctx) {
      // Offer exit destinations from config.exit_options
      const options = config.exit_options ?? [
        { label: "Build", agent: "build", description: "Switch to build agent" },
      ]
      const answers = await Question.ask({ ... })
      // Create synthetic message targeting chosen agent
      return { title: `Exiting ${agentName}`, output: `Wait for further instructions.`, metadata: {} }
    },
  })

  return { enterTool, exitTool }
}
```

For `plan`, the existing `PlanExitTool` remains functional but internally uses the same pattern. `PlanEnterTool` (currently commented out) can be revived via this generic mechanism.

### 4. Prompt Injection for Custom Modes

Extend `prompt.ts` mode-switching logic to support any primary agent:

When entering a custom primary agent:

1. Inject permission restrictions (from agent config's `permission` field)
2. Inject agent's `prompt` (full replacement) or `prompt_append` (incremental, borrowed from OMO)
3. Inject mode-specific system reminder from `session/prompt/<agent>.txt` if it exists
4. Inject file write permissions for mode-specific output directory (e.g., `.aether/research/*.md`)

When exiting (switching from custom agent to another):

1. Inject mode-switch reminder (like `BUILD_SWITCH`)
2. Reference the output file if one exists (research report / plan file)
3. The target agent reads the output file as context

### 5. Research Agent Configuration (Validation Case)

File: `.aether/agent/research.md`

Key design decisions:

- **Permission**: read-only + websearch + knowledge_search + question + todowrite
- **Output**: `.aether/research/*.md` (only writable file path, same pattern as plan's `.aether/plans/*.md`)
- **Workflow**: 5 phases (Intent → Parallel Search → Analysis → Report → Exit)
- **Exit options**: plan, build, stay
- **Subagent delegation**: can call `general` and `explore` for parallel research
- **Cannot**: edit code, run bash, make commits
- **Prompt**: uses `prompt_append` (preserves base agent behavior, adds research-specific instructions)

Prompt file: `packages/opencode/src/session/prompt/research.txt`

```
<system-reminder>
# Research Mode - System Reminder

CRITICAL: Research mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes (with the exception of the research
output file mentioned below). You may ONLY observe, search, analyze, and research.

## Responsibility

Your current responsibility is to conduct deep research, literature search, and
knowledge analysis. Produce a detailed research report saved to the designated output
file.

## Research Workflow

### Phase 1: Intent Clarification
Use the question tool to confirm what the user truly needs. Distinguish between:
- Pure knowledge retrieval → focus on search
- Methodology comparison → focus on analysis
- Project feasibility study → research + plan recommendation

### Phase 2: Parallel Search
Launch up to 3 explore subagents IN PARALLEL to search:
- Codebase patterns and existing implementations
- External literature and documentation (via websearch, knowledge_search)
- Related open-source projects and best practices

### Phase 3: Deep Analysis
Synthesize findings from Phase 2. Identify patterns, trade-offs, and gaps.
Launch general subagent for deeper reasoning if needed.

### Phase 4: Write Report
Write your research report to the designated output file. Include:
- Key findings with citations
- Analysis of trade-offs and alternatives
- Recommended approach with justification
- Links to relevant files, papers, and resources

### Phase 5: research_exit
Call research_exit to indicate completion. Offer to switch to plan or build.
</system-reminder>
```

### 6. Fallback Models (Borrowed from OMO)

When the primary model for a custom agent fails (429, 503, 529, or provider key errors), automatically try the next model in the `fallback_models` chain.

Priority order (same as OMO):

1. UI-selected model (if user manually selected)
2. User config model (explicit override)
3. Category default → Not applicable (Aether has no separate category layer)
4. User `fallback_models` chain (from agent config)
5. System default model

Each fallback entry can carry its own settings (variant, temperature, thinking, reasoningEffort). When a fallback model becomes active, those settings are promoted — they don't override the primary model's settings when it's working.

### 7. Skill-Embedded MCP (Borrowed from OMO)

When a custom agent declares `mcp` in its config:

- On mode enter: activate declared MCPs, add their tools to agent's available tools
- On mode exit: deactivate, remove tools
- MCPs remain scoped to the agent session, not polluting other agents' context window

This borrows OMO's core insight: global MCPs bloat the context window. Per-agent MCP activation keeps the context clean.

### 8. custom-agent-designer Skill

A new skill (`custom-agent-designer`) will assist users in designing agent structures through interactive dialogue. This skill:

- **Trigger**: When user says "create an agent", "design an agent", "add an agent mode", or similar
- **Function**: Interviews the user about their needs (inspired by OMO's Prometheus interview mode)
- **Output**: Generates a `.aether/agent/<name>.md` file with appropriate frontmatter

The skill guides the user through:

1. **Agent purpose**: What tasks should this agent handle?
2. **Mode**: primary (switchable mode) or subagent (@-mentionable helper)?
3. **Permission template**: Choose from presets (read-only, standard, full-access) or customize
4. **Model**: Which model works best for this agent's tasks?
5. **Fallback models**: Configure degradation chain if desired
6. **MCP needs**: Which MCPs should this agent have access to?
7. **Prompt**: Core instructions vs. append to default behavior
8. **Exit destinations**: Where can users go after this agent's work is done?
9. **Color**: Visual identity in the UI

Skill file: `.aether/skills/custom-agent-designer/SKILL.md`

```markdown
---
name: custom-agent-designer
description: Interactive agent design assistant. Use when user wants to create or design a new agent role or mode.
---

You are an expert AI agent architect. Your job is to help users design custom
agent configurations for the Aether system.

## Process

1. **Interview the user** about their needs — ask one question at a time
2. **Recommend permission templates** based on the agent's purpose
3. **Suggest appropriate models** for the task type
4. **Generate the `.aether/agent/<name>.md` file** with complete frontmatter

## Permission Templates

| Template    | Permissions                                                   | Use Case                    |
| ----------- | ------------------------------------------------------------- | --------------------------- |
| Read-only   | edit:deny, bash:deny, websearch:allow, grep:allow, glob:allow | Research, review, analysis  |
| Standard    | edit:allow, bash:ask, websearch:allow                         | General development tasks   |
| Full-access | All tools: allow                                              | Default build-like behavior |
| Safe        | edit:ask, bash:ask, everything else: allow                    | Cautious execution          |

## Model Recommendations

| Task Type      | Recommended Model          | Reason            |
| -------------- | -------------------------- | ----------------- |
| Fast search    | claude-haiku-4-5           | Speed and cost    |
| General work   | claude-sonnet-4-5          | Balance           |
| Deep reasoning | claude-opus-4-5 or gpt-5.4 | Quality           |
| Visual/UI      | gemini-3-pro               | Multimodal        |
| Research       | claude-opus-4-5            | Thorough analysis |

## Exit Options Pattern

For primary agents, define where users can go next:

- Research → Plan (create implementation plan) or Build (start implementing)
- Review → Build (implement fixes) or Plan (plan changes first)
- Analysis → Plan or Build

## Output Format

Write the final `.aether/agent/<name>.md` file. Use `prompt_append` by default
(preserves base agent behavior). Only use `prompt` (full replacement) when the
agent needs completely different behavior from the default.
```

## Phase Plan

| Phase   | Scope                                                              | Dependency |
| ------- | ------------------------------------------------------------------ | ---------- |
| Phase 1 | Branch creation from `upstream/dev`                                | -          |
| Phase 2 | Agent schema extension + primary agent registration from md        | Phase 1    |
| Phase 3 | Generic mode switching (ModeSwitchTool factory + prompt injection) | Phase 2    |
| Phase 4 | Research agent md config + prompt files + research_exit tool       | Phase 3    |
| Phase 5 | Fallback models chain                                              | Phase 4    |
| Phase 6 | Skill-embedded MCP per-agent                                       | Phase 4    |
| Phase 7 | custom-agent-designer skill                                        | Phase 4    |
| Phase 8 | UI design (after backend validation)                               | Phase 4-7  |

## Acceptance Criteria

Phase 2: User can declare `mode: primary` in `.aether/agent/*.md`, agent appears in UI dropdown selector and can be switched to.

Phase 3: Any primary agent can be entered/exited via `xxx_enter`/`xxx_exit` tools generated dynamically. `plan_exit` behavior preserved.

Phase 4: Research mode works end-to-end: select in UI → read-only research → write report to `.aether/research/*.md` → exit to plan or build.

Phase 5: Research agent with fallback_models configured can auto-degrade when primary model is unavailable.

Phase 6: Research agent's `mcp: { arxiv-search: true }` activates arxiv-search MCP only during research mode.

Phase 7: User can invoke `custom-agent-designer` skill, go through interactive interview, and get a `.aether/agent/<name>.md` file generated automatically.

Phase 8: Settings dialog has "Agents" tab with creation/editing UI.

## What We're NOT Doing (YAGNI)

- Hash-anchored edit tool (separate feature)
- Parallel background agent system (separate feature)
- Intent Gate pre-classification (separate feature)
- Replacing build/plan with Sisyphus-like orchestrator (preserving native design)
- Category as a separate config layer (embedded in agent config instead)
- Fixed agent name list (catchall schema allows any name)
