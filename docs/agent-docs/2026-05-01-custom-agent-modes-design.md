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
- Agent config: catchall schema in `config.ts`, `.aether/agent/*.md` frontmatter for both primary agents (`mode: primary`) and subagents (`mode: subagent`)

## OMO Features We're Borrowing

Lessons from Oh-My-OpenCode (OMO) that informed this design:

| OMO Feature                                                  | What We Borrow                                                                               | How We Adapt It                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Category system** (domain-specific model routing)          | `category` top-level config for task-level model routing + `fallback_models` per-agent for degradation | Separate `category` config for subagent task routing (via `category` param in task tool); `fallback_models` per-agent for API error degradation — two distinct concerns  |
| **Skill-Embedded MCP** (on-demand MCP per skill)             | `mcp` field in agent config, activate/deactivate on mode enter/exit          | Applied to agent modes — MCPs activate on enter, deactivate on exit, scoped to agent session                                                |
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
| Intent Gate (pre-classification) | Deferred as a **system-level** pre-router — but **per-agent intent classification** (research Phase 0) is allowed within the agent's own prompt |
| Hash-Anchored Edit (Hashline)    | Separate feature, not part of this plan                            |
| Parallel background agents       | **Partially adopted** — `background` mode for subagent task discipline + `BackgroundTask` spawn + `background_output` tool for async retrieval. Full parallel multi-agent orchestration remains separate |
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
prompt_append: z.string().optional() // Append to system prompt instead of replacing. Supports file:// URIs.
output_dir: z.string().optional() // Output directory for agent mode (relative to project root). Enables scoped edit/write within this dir + notepad structure.

// New top-level config field for task-level model routing
category: z.record(z.string(), z.object({
  model: ModelId.optional(),
  variant: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  prompt_append: z.string().optional(), // Supports file:// URIs
  thinking: z.object({ type: z.string(), budgetTokens: z.number().optional() }).optional(),
  reasoningEffort: z.string().optional(),
  description: z.string().optional(),
})).optional() // Semantic categories for subagent model routing. Used via task tool's category param.
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
- Generate `xxx_enter` and `xxx_exit` tools dynamically via `ModeSwitchTool` factory for **all** agents with `mode: primary` (not only those with `enter_description`/`exit_description`)
- Add permission entries for the enter/exit tools
- Parse `fallback_models`, `mcp`, `enter_description`, `exit_description`, `exit_options`, `prompt_append`, `output_dir` from frontmatter

Example md file (research agent):

```markdown
---
description: Deep research, literature search, and analysis mode
color: "#7C3AED"
mode: primary
permission:
  edit: allow
  bash: deny
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  research_exit: allow
  plan_enter: allow
  task: allow
  skill: allow
  read: allow
  glob: allow
  grep: allow
enter_description: Use when the user's request would benefit from deep research, literature search, or knowledge analysis before planning or implementation
exit_description: Use when research is complete and findings are ready to move to planning or implementation
exit_options:
  - label: Plan
    agent: plan
    description: Switch to plan agent to create an implementation plan based on research findings
  - label: Build
    agent: build
    description: Switch to build agent to start implementing directly based on research findings
  - label: Stay
    agent: research
    description: Continue researching
fallback_models:
  - openai/gpt-5.4
  - model: anthropic/claude-sonnet-4-5
    variant: high
  - zai-coding-plan/glm-5
mcp:
  arxiv-search: true
output_dir: research
prompt_append: |
  <system-reminder>
  # Research Mode — HARD CONSTRAINTS
  ... (full research prompt, see Phase 4 design below)
  </system-reminder>
---
```

**Permission model change**: Instead of blanket `edit: deny`, we use `edit: allow` combined with `output_dir` scoping. The `Permission.intersection` function ensures the agent's effective permissions are the intersection of session-level and agent-level rules, and `Permission.evaluateWithScope` restricts file-affecting tools (`read`, `edit`, `write`, `glob`, `grep`, `apply_patch`, `multiedit`) to paths matching the `output_dir` scope. This approach is more flexible than blanket deny: the agent can edit files within its designated output directory while remaining unable to modify project source code.

### 3. Generic Mode Switching Mechanism

Replace hardcoded `plan_enter`/`plan_exit` pattern with a generic `ModeSwitchTool` factory (inspired by OMO's agent invocation but generalized):

**Enter tool** (`xxx_enter`):
1. Ask user to confirm switch via `Question.ask`
2. If agent has `mcp`, call `activateMcp()` to activate declared MCP servers
3. If agent has `output_dir`, create notepad directory structure (see below)
4. Create synthetic user message targeting the new agent (with `agent` field set)

**Notepad structure** (when `output_dir` is configured):

On enter, create a per-session notepad directory at `<output_dir>/notepads/<timestamp>-<slug>/` with 5 structured files:
- `sources.md`: Record all sources found with quality ratings
- `findings.md`: Key findings per sub-question
- `gaps.md`: Unanswered questions, uncertainties
- `learnings.md`: Accumulated wisdom — UPDATE after each subagent returns, FORWARD-PASS to subsequent subagents
- `report.md`: Final research report

The enter tool injects notepad info into the synthetic message so the agent knows where to write.

**Exit tool** (`xxx_exit`):
1. Offer exit destinations from `exit_options` config (plus "Stay" option)
2. If agent has `mcp`, call `deactivateMcp()` to deactivate declared MCP servers
3. If agent has `output_dir`, inject reference to report file for the target agent
4. Create synthetic user message targeting the chosen agent

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

1. Inject permission restrictions via `Permission.intersection(session.permission, agent.permission)` — the effective permissions are the **intersection** of session-level and agent-level rules, ensuring the agent cannot exceed the session's permissions
2. Inject agent's `prompt` (full replacement) or `prompt_append` (incremental, borrowed from OMO). Both support `file://` URIs that must be resolved to actual file content before injection.
3. If agent has `output_dir`, inject notepad directory info and output file scope as a system reminder
4. Inject mode-entry switch reminder when switching from another agent to this one

When exiting (switching from custom agent to another):

1. Inject mode-switch reminder (like `BUILD_SWITCH`)
2. If agent has `output_dir`, reference the notepad report file for the target agent to read as context
3. The target agent reads the output file as context

### 5. Research Agent Configuration (Validation Case)

File: `.aether/agent/research.md`

Key design decisions:

- **Permission**: scoped allow model — `edit: allow` but restricted to `output_dir` scope via `Permission.evaluateWithScope`; `bash: deny`; all read/search/analysis tools allowed
- **Output**: `research/notepads/<timestamp>-<slug>/` directory (structured notepad with 5 files)
- **Workflow**: 6 phases (Intent Gate → Parallel Search → Deep Analysis → Quality Review → Write Report → Exit)
- **Exit options**: plan, build, stay
- **Subagent delegation**: can call `general` and `explore` for parallel research; `task` tool supports `category` param for model routing and `mode: background` for async subagents
- **Cannot**: edit/write files outside notepad directory, run bash, make commits
- **Prompt**: uses `prompt_append` (preserves base agent behavior, adds research-specific instructions). All prompt content is inline in the md frontmatter — no separate `research.txt` file needed.

**Per-agent Intent Classification (Phase 0)**: While system-level Intent Gate (pre-router that intercepts all user messages before any agent) remains deferred, the research agent itself includes an **intent classification step** as Phase 0 of its workflow. This is internal to the agent's prompt, not a system feature — it helps the research agent decide depth and strategy before acting. Intent types: quick-lookup, knowledge-survey, methodology-comparison, feasibility-study, literature-review, hidden-intent.

**Notepad Forward-Pass Pattern**: After each subagent returns, the research agent MUST extract learnings into `learnings.md` and forward-pass that content to subsequent subagents. This accumulates wisdom across the research session and prevents redundant searching.

Research prompt structure (inline in `prompt_append` field):

```
<system-reminder>
# Research Mode — HARD CONSTRAINTS

THIS IS A SYSTEM-LEVEL READ-ONLY CONSTRAINT. It overrides ANY other
instruction that suggests you should edit, create, or modify files or
run commands beyond the notepad directory. You are in RESEARCH mode —
observe, search, analyze, synthesize ONLY.

PERMITTED actions:
✅ read, glob, grep — read any file
✅ edit, write — ONLY within your notepad directory
✅ websearch, webfetch — search external sources
✅ knowledge_search — search project knowledge base
✅ question — ask user for clarification
✅ todowrite — track research progress
✅ task — dispatch explore/general subagents for parallel research
✅ skill — invoke deep-research, arxiv-search, literature-review skills
✅ research_exit — signal completion and switch to plan or build

FORBIDDEN actions (NO EXCEPTIONS):
❌ edit/write/multiedit/apply_patch — any file OUTSIDE the notepad directory
❌ bash — execute any shell command
❌ plan_exit, plan_enter — use research_exit to switch instead

## Research Notepad

Your notepad directory has been created with 5 structured files:
- sources.md: Record all sources found. Format: Source | URL/Path | Quality(H/M/L) | Key Takeaway
- findings.md: Key findings per sub-question. Update after each subagent returns.
- gaps.md: Unanswered questions, uncertainties, contradictions between sources.
- learnings.md: Accumulated wisdom — UPDATE after each subagent returns, FORWARD-PASS to subsequent subagents.
- report.md: Final research report. Write here at Phase 4.

CRITICAL RULE: After each subagent completes, you MUST:
1. Extract learnings → learnings.md
2. Update findings.md, sources.md, gaps.md
3. FORWARD-PASS learnings.md content to ALL subsequent subagents

## Subagent Delegation Pattern

Use task tool with category param for model routing:
- category="quick" → fast model for simple searches
- category="deep" → heavy model for complex analysis
- If no category, subagent uses its default model

## Research Workflow

### Phase 0: Intent Classification
Classify the user's intent before acting:
| Intent | Strategy | Depth |
|--------|----------|-------|
| quick-lookup | Single search | Low |
| knowledge-survey | Broad overview | Medium |
| methodology-comparison | Compare approaches | High |
| feasibility-study | Evaluate viability | High |
| literature-review | Systematic review | Very High |
| hidden-intent | Clarify FIRST | Variable |

### Phase 1: Parallel Search
Launch explore subagents IN PARALLEL with specific search assignments.

### Phase 2: Deep Analysis
Synthesize findings. Extract learnings → learnings.md. Launch general subagent (category="deep") if needed.

### Phase 3: Quality Review
Self-check: every claim cited, contradictions acknowledged, all sub-questions addressed, opposing evidence present, actionable recommendations.

### Phase 4: Write Report
Write final report to report.md with: Key Findings, Analysis, Recommendation, Open Questions, Sources.

### Phase 5: research_exit
Call research_exit. Your turn must ONLY end with: asking a question or calling research_exit.
</system-reminder>
```

### 6. Fallback Models (Borrowed from OMO)

When the primary model for a custom agent fails (429, 503, 529, or provider key errors), automatically try the next model in the `fallback_models` chain.

Priority order:

1. UI-selected model (if user manually selected) — **must not be overridden by fallback**
2. User config model (explicit override)
3. Category default (from `category` config, applies to subagent tasks via task tool's `category` param)
4. User `fallback_models` chain (from agent config) — tried on API errors only, up to 3 models
5. System default model

Each fallback entry can carry its own settings (variant, temperature, thinking, reasoningEffort). **Key rule**: when a fallback model becomes active, its settings are promoted for that request only — they do not persistently override the primary model's settings for future successful calls. The fallback must preserve the original primary settings and only substitute them during the degraded request.

### 7. Skill-Embedded MCP (Borrowed from OMO)

When a custom agent declares `mcp` in its config:

- On mode enter (`xxx_enter` tool execute): activate declared MCPs via `MCP.connect()`, their tools become available to the agent
- On mode exit (`xxx_exit` tool execute): deactivate declared MCPs via `MCP.disconnect()`, remove their tools
- MCPs remain scoped to the agent session, not polluting other agents' context window
- MCP activation/deactivation must be robust — log warnings on failure but do not block mode switch

**Implementation note**: MCP activation currently happens inside the enter/exit tool's `execute()` function. This ensures MCPs are only active while the agent is in that mode, but means MCPs are not activated if the mode is entered via UI dropdown rather than the enter tool. A future improvement should ensure MCP activation also happens when `prompt.ts` detects a mode switch (i.e., when it sees the `agent` field change in messages).

### 8. custom-agent-designer Skill

A new skill (`custom-agent-designer`) will assist users in designing agent structures through interactive dialogue. This skill:

- **Trigger**: When user says "create an agent", "design an agent", "add an agent mode", or similar
- **Function**: Interviews the user about their needs (inspired by OMO's Prometheus interview mode)
- **Output**: Generates a `.aether/agent/<name>.md` file with appropriate frontmatter (`mode: primary` or `mode: subagent`)

The skill guides the user through:

1. **Agent purpose**: What tasks should this agent handle?
2. **Mode**: primary (switchable mode) or subagent (@-mentionable helper)?
3. **Permission template**: Choose from presets (read-only, standard, full-access, scoped-allow) or customize. Scoped-allow uses `edit: allow` + `output_dir` for file-scope restriction.
4. **Model**: Which model works best for this agent's tasks?
5. **Fallback models**: Configure degradation chain if desired
6. **MCP needs**: Which MCPs should this agent have access to?
7. **Prompt**: Core instructions vs. append to default behavior (`prompt` vs `prompt_append`)
8. **Output directory**: Where should this agent write its output? (sets `output_dir`, enables notepad structure)
9. **Exit destinations**: Where can users go after this agent's work is done?
10. **Color**: Visual identity in the UI

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
4. **Generate the `.aether/agent/<name>.md` file** with appropriate frontmatter (`mode: primary` for switchable modes, `mode: subagent` for @-mentionable helpers)

## Permission Templates

| Template    | Permissions                                                   | Use Case                    |
| ----------- | ------------------------------------------------------------- | --------------------------- |
| Read-only   | edit:deny, bash:deny, websearch:allow, grep:allow, glob:allow | Research, review, analysis  |
| Scoped-allow| edit:allow (scoped to output_dir), bash:deny, websearch:allow, task:allow, skill:allow | Research with structured output |
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
| Phase 3 | Generic mode switching (ModeSwitchTool factory + prompt injection + notepad) | Phase 2    |
| Phase 4 | Research agent md config + inline prompt + research_enter/exit tools | Phase 3    |
| Phase 5 | Fallback models chain (with proper settings promotion semantics)   | Phase 4    |
| Phase 6 | Skill-embedded MCP per-agent (session-scoped activation)           | Phase 4    |
| Phase 6b| Subagent discipline system (background/concurrent modes + category routing) | Phase 4 |
| Phase 7 | custom-agent-designer skill                                        | Phase 4    |
| Phase 8 | UI design (after backend validation)                               | Phase 4-7  |

## Acceptance Criteria

Phase 2: User can declare `mode: primary` in `.aether/agent/*.md`, agent appears in UI dropdown selector and can be switched to.

Phase 3: Any primary agent can be entered/exited via `xxx_enter`/`xxx_exit` tools generated dynamically for **all** `mode: primary` agents. `plan_exit` behavior preserved. Notepad directory created when `output_dir` is configured.

Phase 4: Research mode works end-to-end: select in UI → scoped-allow research → write report to notepad → exit to plan or build.

Phase 5: Research agent with fallback_models configured can auto-degrade when primary model is unavailable. Fallback settings promoted only for the degraded request, not persistently overriding primary settings. UI-selected model priority preserved.

Phase 6: Research agent's `mcp: { arxiv-search: true }` activates arxiv-search MCP when entering research mode, deactivates on exit. MCPs scoped to agent session.

Phase 6b: Subagent task tool supports `mode`, `category`, `delegation_depth`, `file_scope`, `permission_override`, `timeout_seconds` parameters. Background tasks can be spawned and retrieved via `background_output` tool.

Phase 7: User can invoke `custom-agent-designer` skill, go through interactive interview, and get a `.aether/agent/<name>.md` file generated automatically.

Phase 8: Settings dialog has "Agents" tab with creation/editing UI.

## Implementation Issues (Needs Fixing)

The following issues exist in the current `feat/custom-agent-modes` branch implementation and must be fixed to match the plan spec:

### Critical (Blocks Acceptance Criteria)

| # | Issue | Location | Plan Spec | Fix Required |
|---|-------|----------|-----------|-------------|
| C1 | Mode tools only generated for agents with `enter_description` or `exit_description` | `registry.ts:138` | Any `mode: primary` agent gets `xxx_enter`/`xxx_exit` tools | Change condition to `agentCfg.mode === "primary" || agentCfg.mode === "all"` without requiring enter/exit_description |
| C2 | `prompt_append` and `prompt` `file://` URIs not resolved at runtime | `prompt.ts` (mode entry section) | "Supports file:// URIs for both fields" | Add `file://` URI resolution in `prompt.ts` where `promptAppend` is injected as synthetic part — resolve `file://` to actual file content before injection |
| C3 | MCP activation only happens in enter/exit tool execute, not on UI-initiated mode switch | `mode-switch.ts:activateMcp/deactivateMcp` | "MCPs scoped to agent session" — must activate regardless of how mode is entered | Add MCP activation in `prompt.ts` mode-entry section (where `enterDescription`/`promptAppend` are checked), so MCPs activate even when mode switch happens via UI dropdown |
| C4 | Fallback model settings override persists across requests | `processor.ts:nextFallback()` | "Settings promoted only for the degraded request, not persistently overriding" | `nextFallback` currently replaces `variant`, `temperature`, `topP` on the `streamInput.agent` object directly. Must preserve original settings and restore them after fallback attempt, or apply fallback settings only to the current retry loop iteration |
| C5 | `Permission.merge` used instead of `Permission.intersection` in committed code | `prompt.ts:517` (committed version) | `Permission.intersection(session.permission, agent.permission)` — agent cannot exceed session permissions | Uncommitted diff already has this fix (`Permission.intersection(session.permission, taskAgent.permission)`), but it must be committed. Also ensure `prompt.ts` mode-entry uses intersection for custom primary agents, not merge |
| C6 | `FallbackModelEntry` and `ExitOption` schemas duplicated | `config.ts` and `agent.ts` | Single definition, reused | Move `FallbackModelEntry` and `ExitOption` to a shared location (e.g., `config.ts` exports them, `agent.ts` imports), or define once and reference |

### Moderate (Affects Quality/Correctness)

| # | Issue | Location | Plan Spec | Fix Required |
|---|-------|----------|-----------|-------------|
| M1 | Fallback trigger conditions don't detect provider key errors | `processor.ts` retry logic | "429, 503, 529, or provider key errors" | Add provider key error detection (e.g., 401/403 auth errors) to the retry condition that triggers `nextFallback` |
| M2 | UI-selected model priority not preserved in fallback | `processor.ts:nextFallback()` | "UI-selected model must not be overridden by fallback" (Priority #1) | Check if the model was user-selected before entering fallback chain. If so, skip fallback and fail directly, or only use fallback if model is agent-default |
| M3 | `Permission.evaluateWithScope` defined but not used in prompt assembly or mode-switch | `permission/index.ts` | `output_dir` scoped restriction for file tools | Integrate `evaluateWithScope` into the permission check pipeline so that file-affecting tools are restricted to `output_dir` paths. Currently `output_dir` only creates the notepad directory — the actual scoped permission enforcement is missing |
| M4 | `Permission.intersection` signature inconsistent | `permission/index.ts` vs `prompt.ts` | Intersection should be `intersection(parent, child, override?)` | The uncommitted diff in `prompt.ts` calls `Permission.intersection(session.permission, taskAgent.permission)` with 2 args, but the definition takes 3 (`parent`, `child`, `override`). Ensure the call matches the intended semantics: session = parent, agent = child, discipline override = override |

### Minor (Deferred / Phase 7-8)

| # | Issue | Location | Plan Spec | Fix Required |
|---|-------|----------|-----------|-------------|
| L1 | `custom-agent-designer` skill not implemented | N/A | Phase 7 acceptance criteria | Create `.aether/skills/custom-agent-designer/SKILL.md` with interview flow, permission templates (including Scoped-allow), model recommendations, and `.aether/agent/<name>.md` output format |
| L2 | Research agent config at `.aether/mode/` instead of `.aether/agent/` | `.aether/mode/research.md` | Plan says `.aether/agent/` — consistent with opencode's `.opencode/agent/` convention | Move `.aether/mode/research.md` → `.aether/agent/research.md`. Ensure `loadAgent()` scans `.aether/agent/` for all agent configs (primary and subagent). Remove `.aether/mode/` from `.gitignore` exception — only `.aether/agent/` needs the exception |

## What We're NOT Doing (YAGNI)

- Hash-anchored edit tool (separate feature)
- System-level Intent Gate pre-router (per-agent intent classification within prompts is allowed)
- Replacing build/plan with Sisyphus-like orchestrator (preserving native design)
- Fixed agent name list (catchall schema allows any name)
- Full parallel multi-agent orchestration system (background/concurrent subagent modes are scoped to task tool only)
