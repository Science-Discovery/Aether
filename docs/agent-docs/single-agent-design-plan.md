# Single-Agent Design Dimension: Modification Plan

Goal: Extend `Config.Agent` schema and runtime loading to fully support the role template's per-agent definition capabilities, enabling the `custom-agent-designer` skill to produce agents that can be loaded without manual conversion.

## Current State Summary

| Capability             | Current Support                                                               | Gap                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Agent config schema    | `Config.Agent` (Zod) with ~20 fields                                          | Missing `base_agent`, `skill_refs`, `inputs`, `outputs`, `context_policy`, `domain`, `optional_extension` |
| Agent loading paths    | JSON/YAML config `agent` field + `.opencode/agents/*.md` frontmatter          | No YAML role library loading (`.aether/roles/*.yaml`)                                                     |
| Skill injection        | Broadcast discovery: all non-denied skills listed in `<available_skills>` tag | No whitelist injection (`skill_refs`) that auto-embeds SKILL.md procedure content into prompt             |
| Permission inheritance | Hardcoded `defaults` in `agent.ts`, merged with `user` config                 | No `base_agent` field to declare which native agent to inherit from; no config-level `agent_defaults`     |
| Role card format       | `.md` with frontmatter → `Config.Agent`                                       | No YAML→Config.Agent converter; role card markdown is a derived format not a primary input                |

## Modification Items

### M1: Add `base_agent` field to `Config.Agent`

**Type**: Schema + runtime
**Priority**: P0 (DX, reduces config duplication)
**Difficulty**: Low

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add to `Config.Agent` Zod schema:

   ```ts
   base_agent: z.string()
     .optional()
     .describe(
       "Name of native agent to inherit permission, model, temperature, and other defaults from. Valid values: build, plan, general, explore.",
     )
   ```

2. **`packages/opencode/src/agent/agent.ts`** — In the `InstanceState.make` closure, after creating the agent item from config, resolve `base_agent`:

   ```ts
   // After line ~248: if (!item) item = agents[key] = { ... }
   if (value.base_agent && agents[value.base_agent]) {
     const base = agents[value.base_agent]
     // Inherit fields that are not explicitly set in config
     if (!value.model) item.model = base.model
     if (!value.temperature && item.temperature === undefined) item.temperature = base.temperature
     if (!value.top_p && item.topP === undefined) item.topP = base.topP
     if (!value.permission) item.permission = base.permission
     if (!value.steps && item.steps === undefined) item.steps = base.steps
     if (!value.prompt && item.prompt === undefined) item.prompt = base.prompt
     if (!value.color && item.color === undefined) item.color = base.color
     if (!value.fallback_models && item.fallbackModels === undefined) item.fallbackModels = base.fallbackModels
   }
   ```

   Note: Already-set config fields take precedence (current merge logic preserves this).

3. **`packages/opencode/src/agent/agent.ts`** — Add `base_agent` to `Agent.Info` Zod schema:

   ```ts
   baseAgent: z.string().optional(),
   ```

4. **YAML role template mapping**: When converting role YAML to `Config.Agent`, set `base_agent` from the role's `base_agent` field (currently always `"general"`).

---

### M2: Add `skill_refs` field with auto-injection

**Type**: Schema + runtime + prompt
**Priority**: P0 (core for role template fidelity)
**Difficulty**: Medium

#### Problem

Current skill injection is broadcast: `SystemPrompt.skills()` lists all non-denied skills as `<available_skills>` with only name+description. For role templates with 2-4 specific `skill_refs`, this produces low signal-to-noise (40+ skills listed). The SKILL.md procedure content (Inputs, Procedure 5-8 steps, Validation, Outputs, Do not) that defines the role's workflow behavior is not injected into the prompt—it must be fetched on-demand via the Skill tool.

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add to `Config.Agent`:

   ```ts
   skill_refs: z.array(z.string())
     .optional()
     .describe(
       "Whitelist of skill names to auto-inject into this agent's system prompt. If set, only these skills appear in the prompt with full content.",
     )
   ```

2. **`packages/opencode/src/agent/agent.ts`** — Add to `Agent.Info`:

   ```ts
   skillRefs: z.array(z.string()).optional(),
   ```

3. **`packages/opencode/src/agent/agent.ts`** — In config merge loop, add:

   ```ts
   item.skillRefs = value.skill_refs ?? item.skillRefs
   ```

4. **`packages/opencode/src/session/system.ts`** — Modify `skills()` function:
   - If `agent.skillRefs` is set and non-empty, only load those skills (via `Skill.get(name)`), and inject their **full content** (not just name+description) into the prompt.
   - If `agent.skillRefs` is empty/undefined, fall back to current broadcast behavior.

   ```ts
   export async function skills(agent: Agent.Info, availableTools?: Set<string>, availableToolsets?: Set<string>) {
     if (Permission.disabled(["skill"], agent.permission).has("skill")) return

     if (agent.skillRefs?.length) {
       // Whitelist mode: inject only referenced skills with full content
       const loaded = await Promise.all(agent.skillRefs.map((name) => Skill.get(name)))
       const found = loaded.filter((s): s is Skill.Info => s !== undefined)
       const missing = agent.skillRefs.filter((name) => !loaded.find((s) => s?.name === name))
       return [
         "## Skills (mandatory)",
         "You MUST follow these skills' instructions for every task they cover.",
         ...found.map((s) =>
           [
             `### Skill: ${s.name}`,
             s.content, // full SKILL.md body: When to use / Inputs / Procedure / Validation / Outputs / Do not
           ].join("\n"),
         ),
         ...(missing.length ? [`Note: skills ${missing.join(", ")} were referenced but not found.`] : []),
       ].join("\n")
     }

     // Broadcast mode (unchanged)
     const all = await Skill.available(agent)
     // ... existing logic ...
   }
   ```

5. **Prompt structure change**: In whitelist mode, the injected skill content replaces the `<available_skills>` tag entirely. The Skill tool still remains available for on-demand loading of non-referenced skills if needed.

---

### M3: Add YAML role library loading path

**Type**: Config loading
**Priority**: P0 (role template primary input format)
**Difficulty**: Medium

#### Problem

Current agent loading only supports:

- JSON/YAML config file's `agent` field (flat key→Config.Agent mapping)
- `.opencode/agents/*.md` frontmatter files

Role templates use a different structure:

- `physics-research-roles.yaml`: nested YAML with `version`, `defaults`, `roles` (domain-keyed arrays of role objects)
- Role cards in `roles/general/**/*.md` are **derived** (auto-generated from YAML)

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Extend `loadAgent()` to also scan YAML role library files:

   ```ts
   // In loadAgent(), add scan for role library YAML files
   for (const item of await Glob.scan("{agent,agents}/*.yaml", {
     cwd: dir,
     absolute: true,
     dot: true,
     symlink: true,
   })) {
     const yamlContent = await yamlParse(item)
     if (!yamlContent.roles) continue // skip non-role-library YAML

     // Apply defaults from yamlContent.defaults to each role
     const defaults = yamlContent.defaults ?? {}

     for (const [domain, roleList] of Object.entries(yamlContent.roles as Record<string, any[]>)) {
       for (const role of roleList) {
         const config = {
           name: role.role_id,
           description: role.purpose,
           prompt: role.prompt ?? "", // may come from role card .md
           mode: role.mode ?? "subagent",
           base_agent: role.base_agent ?? defaults.base_agent,
           skill_refs: role.skill_refs,
           permission: defaults.permissions,
           domain: domain,
           optional_extension: role.optional_extension ?? false,
           ...role, // any other fields
         }
         const parsed = Agent.safeParse(config)
         if (parsed.success) {
           result[config.name] = parsed.data
         }
       }
     }
   }
   ```

2. **`packages/opencode/src/config/config.ts`** — Handle role card .md files alongside YAML:
   When a role has no `prompt` in YAML (common), load the corresponding role card `.md` file and use its body as `prompt`. The role card path follows convention: `roles/{namespace}/{domain}/{role_id}.md`.

3. **Config directory scan order**: Add `.aether/` to the existing scan pattern alongside `.opencode/`:
   ```
   {agent,agents}/**/*.md  →  .aether/agents/, .opencode/agents/
   {agent,agents}/*.yaml   →  .aether/roles/, .opencode/roles/
   ```
   The `buildSources`-like pattern should include `.aether/` directories at same priority as `.opencode/`.

---

### M4: Add `inputs` / `outputs` / `output_contract` declaration fields

**Type**: Schema + prompt injection (no runtime validation)
**Priority**: P1
**Difficulty**: Low

#### Design Decision

These are **prompt-level declarations**, not runtime artifact validators. They inform the LLM what it should receive and produce, and are injected into the system prompt as behavioral constraints.

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add to `Config.Agent`:

   ```ts
   inputs: z.array(z.string()).optional().describe("Artifact names this agent expects to receive."),
   outputs: z.array(z.string()).optional().describe("Artifact names this agent is responsible for producing."),
   output_contract: z.object({
     required_fields: z.array(z.string()).optional(),
   }).optional().describe("Structured output contract: which fields must appear in the agent's final response."),
   ```

2. **`packages/opencode/src/agent/agent.ts`** — Add to `Agent.Info`:

   ```ts
   inputs: z.array(z.string()).optional(),
   outputs: z.array(z.string()).optional(),
   outputContract: z.object({ requiredFields: z.array(z.string()).optional() }).optional(),
   ```

3. **`packages/opencode/src/agent/agent.ts`** — Config merge:

   ```ts
   item.inputs = value.inputs ?? item.inputs
   item.outputs = value.outputs ?? item.outputs
   item.outputContract = value.output_contract ?? item.outputContract
   ```

4. **`packages/opencode/src/session/prompt.ts`** — In `buildSystemPrompt()`, after agent prompt, inject:
   ```ts
   if (agent.inputs?.length) {
     sections.push(
       `## Expected Inputs\nYou will receive these artifacts: ${agent.inputs.join(", ")}. If any are missing, request them before proceeding.`,
     )
   }
   if (agent.outputs?.length) {
     sections.push(
       `## Required Outputs\nYou must produce these artifacts: ${agent.outputs.join(", ")}. Do not skip any.`,
     )
   }
   if (agent.outputContract?.requiredFields?.length) {
     sections.push(
       `## Output Contract\nYour final response must include these fields: ${agent.outputContract.requiredFields.join(", ")}.`,
     )
   }
   ```

---

### M5: Add `context_policy` field

**Type**: Schema + subagent call behavior
**Priority**: P1
**Difficulty**: Low-Medium

#### Analysis

Current subagent behavior already defaults to `pass_full_history: false` (subagent only receives the `message` parameter). The practical additions are:

- `pass_artifacts`: auto-attach relevant notepad/artifact files to Task tool message
- `pass_user_constraints`: auto-inject session-level user constraints into subagent message

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add to `Config.Agent`:

   ```ts
   context_policy: z.object({
     pass_full_history: z.boolean().optional().default(false),
     pass_artifacts: z.boolean().optional().default(true),
     pass_user_constraints: z.boolean().optional().default(true),
     pass_relevant_evidence: z.boolean().optional().default(true),
   })
     .optional()
     .describe("Controls what context is passed to/from this agent when called as subagent.")
   ```

2. **`packages/opencode/src/agent/agent.ts`** — Add to `Agent.Info`:

   ```ts
   contextPolicy: z.object({
     passFullHistory: z.boolean().optional(),
     passArtifacts: z.boolean().optional(),
     passUserConstraints: z.boolean().optional(),
     passRelevantEvidence: z.boolean().optional(),
   }).optional(),
   ```

3. **`packages/opencode/src/session/prompt.ts`** — In subtask execution path (~line 300-400), when constructing the `message` for Task tool:
   - If `bgAgent.contextPolicy?.passArtifacts` is true, auto-attach the agent's `outputDir` notepad file contents (if they exist) to the message.
   - If `bgAgent.contextPolicy?.passUserConstraints` is true, extract session-level constraints (from session metadata or user preferences) and prepend them to the message.
   - `passFullHistory: true` would require passing the full conversation history to the subagent context window (significant architectural change, defer to later).

---

### M6: Add config-level `agent_defaults`

**Type**: Config schema
**Priority**: P1
**Difficulty**: Low

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add a top-level `agent_defaults` field to the config schema:

   ```ts
   agent_defaults: z.object({
     permission: Permission.optional(),
     context_policy: z
       .object({
         pass_full_history: z.boolean().optional().default(false),
         pass_artifacts: z.boolean().optional().default(true),
         pass_user_constraints: z.boolean().optional().default(true),
         pass_relevant_evidence: z.boolean().optional().default(true),
       })
       .optional(),
     output_contract: z
       .object({
         required_fields: z.array(z.string()).optional(),
       })
       .optional(),
   })
     .optional()
     .describe("Global defaults applied to all agents before per-agent overrides.")
   ```

2. **`packages/opencode/src/agent/agent.ts`** — In agent construction, apply `cfg.agent_defaults` as the first merge layer before per-agent config:

   ```ts
   // Change the default permission for new agents from hardcoded defaults
   // to: defaults → agent_defaults → per-agent config
   const agentDefaults = cfg.agent_defaults ?? {}
   const basePermission = agentDefaults.permission
     ? Permission.merge(defaults, Permission.fromConfig(agentDefaults.permission), user)
     : Permission.merge(defaults, user)

   // For new agents (no existing native agent):
   item = agents[key] = {
     name: key,
     mode: "all",
     permission: basePermission,
     options: {},
     native: false,
     contextPolicy: agentDefaults.context_policy,
     outputContract: agentDefaults.output_contract,
   }
   ```

---

### M7: Add `domain` and `optional_extension` fields

**Type**: Schema (metadata only, no runtime behavior change)
**Priority**: P2
**Difficulty**: Low

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add to `Config.Agent`:

   ```ts
   domain: z.string().optional().describe("Functional domain grouping for this agent (e.g., coordination, theory_strategy, data_and_statistics)."),
   optional_extension: z.boolean().optional().default(false).describe("Whether this agent is an optional domain-specific extension rather than a default agent."),
   ```

2. **`packages/opencode/src/agent/agent.ts`** — Add to `Agent.Info`:

   ```ts
   domain: z.string().optional(),
   optionalExtension: z.boolean().optional(),
   ```

3. **`packages/opencode/src/agent/agent.ts`** — Config merge:
   ```ts
   item.domain = value.domain ?? item.domain
   item.optionalExtension = value.optional_extension ?? item.optionalExtension
   ```

These fields are metadata for organization, filtering, and display. They have no runtime behavioral effect beyond potentially filtering which agents appear in @autocomplete (e.g., `optional_extension: true` + `hidden: true` for rarely-needed specialists).

---

### M8: Add `responsibility_boundary` and `role_design_basis` fields

**Type**: Schema (prompt-level, no runtime behavior)
**Priority**: P2
**Difficulty**: Low

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add to `Config.Agent`:

   ```ts
   responsibility_boundary: z.string().optional().describe("Declares what this agent owns and what it must not absorb from adjacent roles."),
   role_design_basis: z.array(z.string()).optional().describe("Design溯源 labels documenting which archetypes/policies shaped this agent."),
   ```

2. **`packages/opencode/src/agent/agent.ts`** — Add to `Agent.Info`:

   ```ts
   responsibilityBoundary: z.string().optional(),
   roleDesignBasis: z.array(z.string()).optional(),
   ```

3. **`packages/opencode/src/session/prompt.ts`** — Inject into system prompt:
   ```ts
   if (agent.responsibilityBoundary) {
     sections.push(`## Responsibility Boundary\n${agent.responsibilityBoundary}`)
   }
   ```

`roleDesignBasis` is purely metadata for traceability and does not need prompt injection.

---

## Execution Order

| Step | Item                                            | Depends On                                                    |
| ---- | ----------------------------------------------- | ------------------------------------------------------------- |
| 1    | M1: `base_agent`                                | None                                                          |
| 2    | M6: `agent_defaults`                            | None                                                          |
| 3    | M4: `inputs/outputs/output_contract`            | None                                                          |
| 4    | M2: `skill_refs`                                | None (but test with M3 for YAML loading)                      |
| 5    | M5: `context_policy`                            | M6 (agent_defaults provides default context_policy)           |
| 6    | M3: YAML role library loading                   | M1, M2, M4, M5, M6, M7 (needs all new fields in Config.Agent) |
| 7    | M7: `domain/optional_extension`                 | None                                                          |
| 8    | M8: `responsibility_boundary/role_design_basis` | None                                                          |

Steps 1-5 can be done in parallel since they modify different schema fields. Step 6 (YAML loading) must come last in the single-agent phase because it needs all new fields to be in `Config.Agent` first.

## Validation Criteria

After all modifications:

1. `bun typecheck` in `packages/opencode` passes
2. Existing tests pass (no behavioral regressions for agents without new fields)
3. A YAML role library file (e.g., `physics-research-roles.yaml`) can be placed in `.aether/roles/` and its roles appear in `Agent.list()`
4. An agent with `skill_refs: ["research-question-framing", "literature-landscape-scan"]` only sees those two skills in its system prompt with full procedure content
5. An agent with `base_agent: "general"` inherits general's permission/model defaults
6. An agent with `inputs/outputs` has those declarations injected into its system prompt
