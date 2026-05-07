# Team Composition Dimension: Modification Plan

Goal: Support role-packs, default_flow orchestration, role-skill-map derivation, and role library validation — enabling multi-agent coordinated workflows beyond the current single-invocation subagent pattern.

## Current State Summary

| Capability                | Current Support                                                                    | Gap                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Multi-agent orchestration | Single Task tool invocation; primary agent manually decides when to call subagents | No pack-based group activation; no default_flow execution ordering; no automatic artifact handoff between roles        |
| Role packs                | None                                                                               | No `role-packs.yaml` loading; no team composition concept                                                              |
| Role-skill-map            | None                                                                               | No derived mapping table; no consistency validation between role YAML `skill_refs` and actual SKILL.md files           |
| Role library validation   | Zod schema validation only                                                         | No cross-reference validation (skill_refs → SKILL.md existence, pack roles → role IDs, role cards ↔ YAML consistency) |
| Gate/review mechanism     | `xxx_exit` tool with `exit_options` for manual mode switching                      | No automatic review gates in workflow DAG; no conditional pass/block decisions                                         |
| Artifact handoff          | Notepad files in `outputDir` (manual, role-specific)                               | No structured artifact registry; no provenance tracking across role handoffs; no handoff contract validation           |

## Architecture Decision: Prompt-Driven Orchestration as Primary Strategy

Prompt-driven orchestration is the **correct primary strategy** for LLM-based agent workflows, not a temporary compromise. The reason is fundamental: LLM agent outputs are natural language, not data structures. Even when a role declares `outputs: [workspace_package, fit_results]`, the actual artifact is a markdown text block, not a JSON object with typed fields. This means:

- **Node execution is always prompt-driven** — regardless of whether a DAG executor exists, each node still runs by injecting context into an LLM and receiving text back. The DAG executor cannot change this fundamental mechanism.
- **Rigid DAG execution is harmful** — a DAG executor that blindly advances to the next node when predecessor output is incomplete or malformed produces worse results than an LLM that notices the problem and adapts.
- **LLM adaptivity is an asset** — the LLM can skip irrelevant steps, request clarification when predecessor artifacts are insufficient, and dynamically add subagents not in the original flow. A programmatic DAG cannot do this.

Therefore, the prompt-driven approach (M9-M11) is the **permanent core execution strategy**. M12-M14 are **optional audit/validation overlays** that observe and record prompt-driven execution, not alternative execution drivers.

### Prompt-Driven Orchestration (Core — M9-M11)

Embed `default_flow` and role topology information into the primary agent's system prompt. The LLM interprets the flow and calls Task tool sequentially, passing artifacts via `message` parameter. This leverages existing Task/mode-switch tools and lets the LLM adapt dynamically.

**Limitation**: No programmatic guarantee that the prescribed flow is followed; no audit trail of whether gate conditions were met; no provenance graph of artifact derivation chains.

### DAG Audit Overlay (Optional — M12-M14)

An optional runtime layer that **observes** prompt-driven execution and provides:

- **Execution audit**: records which roles were activated, in what order, with what timing — enabling post-session verification that the prescribed flow was actually followed.
- **Gate validation**: at designated review nodes, pauses execution and requires explicit human or reviewer-agent approval before proceeding.
- **Provenance tracking**: builds a lineage graph linking final artifacts back to their raw inputs through every intermediate role.

This overlay **does not replace** the prompt-driven execution mechanism. It records and validates what the LLM chose to do. The LLM may deviate from the prescribed flow (e.g., skip a step, add an extra subagent), and the overlay logs these deviations for review rather than preventing them.

**Relationship**: The overlay reuses all prompt-driven components — pack definitions, artifact conventions, system prompt injections. It adds observation hooks into the existing Task tool / mode-switch execution paths, not new execution paths.

---

## Modification Items

### M9: Add `role-packs` config loading

**Type**: Config schema + prompt injection
**Priority**: P2 (first team-composition item)
**Difficulty**: Medium
**Strategy**: A (prompt-driven)

#### Changes

1. **`packages/opencode/src/config/config.ts`** — Add `role_packs` to the top-level config schema:

   ```ts
   role_packs: z.record(
     z.object({
       purpose: z.string().optional(),
       roles: z.record(z.string()).optional().describe("Alias → role_id mapping"),
       default_flow: z
         .array(z.string())
         .optional()
         .describe("Ordered list of role_ids defining the execution sequence"),
       role_source: z.string().optional().describe("YAML file source for this pack's roles"),
     }),
   )
     .optional()
     .describe("Named role pack compositions for team-based workflows.")
   ```

   Also add a YAML loading path for `role-packs.yaml` files under `.aether/` / `.opencode/`.

2. **`packages/opencode/src/session/prompt.ts`** — When a primary agent is activated and a pack is selected (via user preference or session metadata), inject the pack definition into the system prompt:

   ```
   ## Active Role Pack: general-physics-project-pack
   Purpose: Balanced compact team for a typical physics project.
   Team composition:
   - lead: principal-investigator
   - literature: literature-scout
   - hypothesis: hypothesis-and-scope-analyst
   ...
   Recommended flow:
   1. principal-investigator → define research goal and acceptance criteria
   2. literature-scout → build landscape of prior work
   3. hypothesis-and-scope-analyst → formulate falsifiable hypotheses
   ...
   After each step, pass the declared outputs to the next role via the Task tool message parameter.
   ```

3. **Pack selection mechanism**: Add a session preference field for `active_pack`. When a user selects a pack (via UI or command), the session preference updates and the next prompt rebuild includes the pack definition.

---

### M10: Role-skill-map derivation and validation

**Type**: Tooling / validation script
**Priority**: P2
**Difficulty**: Low-Medium
**Strategy**: A (metadata consistency)

#### Changes

1. **Add a validation script** (TypeScript, not Python — aligned with project conventions) at `packages/opencode/src/config/validate-roles.ts`:
   - Scan all loaded agents from `Agent.list()`
   - For each agent with `skillRefs`, verify that every referenced skill exists in `Skill.available()`
   - For each `role_packs` entry, verify that every `roles` value maps to a known `role_id`
   - For each `default_flow` entry, verify it's covered by the pack's `roles` values
   - Report missing references as warnings (not errors — agents should still load)

2. **`packages/opencode/src/agent/agent.ts`** — After agent state initialization, run a lightweight validation:

   ```ts
   // After agents object is fully built
   for (const [name, agent] of Object.entries(agents)) {
     if (agent.skillRefs) {
       for (const skillName of agent.skillRefs) {
         // Skill.get will return undefined if skill doesn't exist
         // Log warning but don't block agent creation
       }
     }
   }
   ```

3. **Derive role-skill-map**: Not stored as a separate file (that's the Python template convention). Instead, it's available implicitly via `Agent.list()` → each agent's `skillRefs`. The `role-skill-map.yaml` concept maps to a runtime query, not a static file.

---

### M11: Artifact handoff in subagent calls

**Type**: Runtime (Task tool message construction)
**Priority**: P2
**Difficulty**: Medium
**Strategy**: A (enhanced message passing)

#### Problem

Current subagent calls pass a free-form `message` string. For pack-based workflows, the calling agent needs to automatically attach the predecessor role's declared outputs (from notepad/artifact files) to the next role's call.

#### Changes

1. **`packages/opencode/src/session/prompt.ts`** — In subtask execution path, when constructing the Task tool message for a role with `inputs` declarations:

   ```ts
   // If the target agent has inputs declared, attempt to attach predecessor artifacts
   if (taskAgent.inputs?.length) {
     const predecessorDir = // find the output_dir of the most recent predecessor in the flow
     for (const inputName of taskAgent.inputs) {
       // Check if predecessor's outputDir contains a file matching this input name
       // If found, append its content to the message
     }
   }
   ```

2. **Notepad convention extension**: The current notepad files (sources/findings/gaps/learnings/report.md) are generic. For role templates, add a convention where each role writes its declared outputs to files in `outputDir` named by output artifact (e.g., `outputDir/literature_map.md`, `outputDir/benchmark_table.md`). This convention is enforced via the `outputs` prompt injection (M4).

3. **Artifact manifest**: When a role completes, it should write an `artifacts.json` manifest in its `outputDir` listing which outputs were produced and their file paths. This is a prompt-level convention (enforced by the output_contract in system prompt), not a runtime mechanism.

---

### M12: Workflow Audit Recorder (Optional Overlay)

**Type**: Observation layer over prompt-driven execution
**Priority**: P3 (optional, when users need session-level flow compliance verification)
**Difficulty**: Medium

#### Concept

A lightweight service that hooks into existing Task tool and mode-switch execution paths to record what actually happened during a pack-based session. This is not a new execution engine — it observes the prompt-driven execution that M9-M11 already provides.

Core responsibilities:

1. **Node activation logging**: When a subagent is invoked via Task tool, record which `role_id` was called, what `inputs` were passed in the message, what `outputs` the subagent declared in its response, and timestamps.
2. **Flow deviation detection**: Compare the recorded activation sequence against the pack's `default_flow`. Log deviations (steps skipped, extra steps added, order changed) as observations, not errors.
3. **Execution state persistence**: Store the audit log in a `WorkflowAudit` SQLite table, enabling post-session queries like "did the literature-scout step actually run before hypothesis-and-scope-analyst?".

Implementation approach:

- Add hooks in `packages/opencode/src/session/prompt.ts` at the subtask execution point (~line 300-400) to log before/after each Task tool invocation when a pack is active.
- Add hooks in mode-switch (`packages/opencode/src/tool/mode-switch.ts`) to log enter/exit events.
- No change to the LLM's decision-making process — it still decides which subagent to call based on prompt context.

**Deferred until M9-M11 are validated and users request flow compliance auditing.**

---

### M13: Review Gate Observer (Optional Overlay)

**Type**: Observation + human checkpoint over prompt-driven execution
**Priority**: P3 (optional, when users need mandatory human approval at critical workflow nodes)
**Difficulty**: Medium

#### Concept

Built on top of M12's audit recorder, add **mandatory pause points** at designated review nodes in the pack's `default_flow`. When the audit recorder detects that the LLM has reached a review-designated step (e.g., "before statistical inference", "before publication"), it:

1. **Pauses further subagent calls** from the primary agent at this gate point
2. **Presents the predecessor's outputs** to the user (via the Question tool) with a pass/conditional-pass/block choice
3. **Records the gate decision** in the audit log
4. **Resumes execution** only if the decision is "pass" or "conditional pass" with resolved conditions

This is a **soft enforcement layer** — it doesn't change how individual nodes execute (still prompt-driven), but it inserts human checkpoints at critical junctures. The LLM cannot skip these gates because the audit recorder intercepts Task tool calls that target post-gate roles before the gate is cleared.

Implementation approach:

- Define gate nodes in the pack config: `review_gates: [{ after: "data-qc-preprocessing-agent", reviewer: "physics-reviewer" }]`
- In `prompt.ts` subtask execution, check if the target role is past an uncleared gate → if so, block the call and present the gate question to the user
- Gate decisions stored in `WorkflowAudit` table alongside node activation logs

**Deferred until M12 audit recorder is implemented and users request mandatory human checkpoints.**

---

### M14: Provenance Tracking (Optional Overlay)

**Type**: Observation + lineage graph over prompt-driven execution
**Priority**: P3 (optional, when users need artifact traceability across role handoffs)
**Difficulty**: High

#### Concept

An `ArtifactProvenance` service that builds on M12's audit logs and M11's artifact conventions to provide:

1. **Immutable artifact IDs**: Each file written to a role's `outputDir` gets a content-hash-based ID
2. **Derived-from relationships**: When a role reads predecessor artifacts (via M11's handoff mechanism), record the input artifact IDs alongside the output artifact IDs — producing a derivation edge
3. **Lineage graph**: From these edges, build a directed graph from raw inputs to final claims, queryable for "what contributed to this result?"
4. **Audit replay**: For any final artifact, trace the full derivation chain and identify which roles, prompts, and predecessor artifacts shaped it

This is a **post-hoc analysis layer** — it doesn't change execution behavior, but it enables retrospective traceability. Provenance data is derived from M12's audit logs + file content hashes, not from new runtime mechanisms.

Implementation approach:

- On each artifact file write (within `outputDir`), compute a SHA-256 content hash and store it in a `Provenance` SQLite table with `{artifact_id, role_id, session_id, timestamp, file_path}`
- When M11's handoff mechanism attaches predecessor files to a subagent message, also record the input artifact IDs in the provenance table
- Expose a query API: `Provenance.lineage(artifactId)` → returns the full derivation chain

**Deferred until M12 audit recorder and M11 artifact handoff are validated and users request traceability.**

---

## Execution Order

| Step | Item                                     | Depends On                               | Role                   |
| ---- | ---------------------------------------- | ---------------------------------------- | ---------------------- |
| 9    | M9: role-packs config + prompt injection | Single-agent plan (all M1-M8)            | Core execution         |
| 10   | M10: role-skill-map validation           | M2 (skill_refs in Agent.Info)            | Core execution         |
| 11   | M11: Artifact handoff in subagent calls  | M4 (inputs/outputs), M5 (context_policy) | Core execution         |
| 12   | M12: Workflow audit recorder             | M9, M11 validated                        | Optional audit overlay |
| 13   | M13: Review gate observer                | M12                                      | Optional audit overlay |
| 14   | M14: Provenance tracking                 | M11, M12                                 | Optional audit overlay |

Steps 9-11 (core execution) can begin after the single-agent plan is complete. Steps 12-14 (optional overlays) are independent projects that can be added when users need audit, gate enforcement, or traceability — they observe and validate prompt-driven execution, not replace it.

## Validation Criteria

After M9-M11:

1. A `role-packs.yaml` placed in `.aether/` loads correctly and appears in config
2. Selecting a pack injects the team composition and default_flow into the primary agent's system prompt
3. The primary agent can call subagents in the prescribed flow order, passing predecessor artifacts
4. Validation script reports missing skill_refs, unknown role_ids in packs, and flow inconsistencies
5. Existing single-agent behavior is unchanged when no pack is active

After M12-M14 (optional overlays): 6. Audit recorder logs every subagent activation with role_id, inputs, outputs, timing 7. Flow deviation detection reports steps skipped or reordered vs. prescribed default_flow 8. Review gates pause execution at designated nodes and require human approval 9. Provenance graph traces any final artifact back to raw inputs through derivation edges
