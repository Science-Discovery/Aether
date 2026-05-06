import { afterEach, test, expect, describe } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import { ToolRegistry } from "../../src/tool/registry"

function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

describe("research agent", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("research agent loaded from .aether/agent/research.md", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research, literature search, and analysis mode
color: "#7C3AED"
mode: primary
permission:
  edit: deny
  bash: deny
  websearch: allow
  knowledge_search: allow
  question: allow
enter_description: Use when the user needs deep research
exit_description: Use when research is complete
exit_options:
  - label: Plan
    agent: plan
    description: Switch to plan agent
  - label: Build
    agent: build
    description: Switch to build agent
fallback_models:
  - openai/gpt-5.4
  - model: anthropic/claude-sonnet-4-5
    variant: high
output_dir: research
---

You are a research specialist.`,
        )
        return agentDir
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await Agent.list()
        const names = agents.map((a) => a.name)
        expect(names).toContain("research")

        const research = await Agent.get("research")
        expect(research).toBeDefined()
        expect(research?.mode).toBe("primary")
        expect(research?.color).toBe("#7C3AED")
        expect(research?.description).toContain("Deep research")
      },
    })
  })

  test("research agent has correct permissions", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research mode
color: "#7C3AED"
mode: primary
permission:
  edit: deny
  bash: deny
  websearch: allow
  knowledge_search: allow
  question: allow
  research_exit: allow
  task: allow
---

Research specialist.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research).toBeDefined()
        expect(evalPerm(research, "edit")).toBe("deny")
        expect(evalPerm(research, "bash")).toBe("deny")
        expect(evalPerm(research, "websearch")).toBe("allow")
        expect(evalPerm(research, "knowledge_search")).toBe("allow")
        expect(evalPerm(research, "question")).toBe("allow")
        expect(evalPerm(research, "task")).toBe("allow")
      },
    })
  })

  test("research agent has enter/exit descriptions and exit options", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research mode
mode: primary
enter_description: Use for deep research
exit_description: Use when research is complete
exit_options:
  - label: Plan
    agent: plan
    description: Switch to plan
  - label: Build
    agent: build
    description: Switch to build
output_dir: research
---

Research specialist.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.enterDescription).toBe("Use for deep research")
        expect(research?.exitDescription).toBe("Use when research is complete")
        expect(research?.exitOptions).toHaveLength(2)
        expect(research?.exitOptions?.[0]?.label).toBe("Plan")
        expect(research?.exitOptions?.[0]?.agent).toBe("plan")
        expect(research?.exitOptions?.[1]?.label).toBe("Build")
        expect(research?.exitOptions?.[1]?.agent).toBe("build")
      },
    })
  })

  test("research agent has fallback_models", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research mode
mode: primary
fallback_models:
  - openai/gpt-5.4
  - model: anthropic/claude-sonnet-4-5
    variant: high
---

Research specialist.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.fallbackModels).toHaveLength(2)
        expect(research?.fallbackModels?.[0]).toBe("openai/gpt-5.4")
        const second = research?.fallbackModels?.[1] as { model: string; variant: string }
        expect(second.model).toBe("anthropic/claude-sonnet-4-5")
        expect(second.variant).toBe("high")
      },
    })
  })

  test("research agent has promptAppend", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research mode
mode: primary
prompt_append: You are a research specialist.
---

Base prompt content.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.promptAppend).toContain("research specialist")
      },
    })
  })

  test("research agent has outputDir", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research mode
mode: primary
output_dir: research
---

Research specialist.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.outputDir).toBe("research")
      },
    })
  })

  test("research agent has MCP config", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research mode
mode: primary
mcp:
  arxiv-search: true
  semantic-scholar: true
---

Research specialist.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        expect(research?.mcp).toBeDefined()
        expect(research?.mcp?.["arxiv-search"]).toBe(true)
        expect(research?.mcp?.["semantic-scholar"]).toBe(true)
      },
    })
  })
})

describe("mode-switch tools registration", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("research_enter and research_exit tools registered for agent with enter/exit descriptions", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "mode")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "research.md"),
          `---
description: Deep research mode
mode: primary
enter_description: Use for deep research
exit_description: Use when research is complete
exit_options:
  - label: Build
    agent: build
    description: Switch to build
---

Research specialist.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const toolIds = await ToolRegistry.ids()
        expect(toolIds).toContain("research_enter")
        expect(toolIds).toContain("research_exit")
      },
    })
  })

  test("mode: primary agent gets enter/exit tools even without enter/exit descriptions", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const agentDir = path.join(dir, ".aether", "agent")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "notes.md"),
          `---
description: Quick notes
mode: primary
---

Notes agent.`,
        )
        return undefined
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const toolIds = await ToolRegistry.ids()
        expect(toolIds).toContain("notes_enter")
        expect(toolIds).toContain("notes_exit")
      },
    })
  })
})

describe("multi-model harness", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("agents with different models can coexist", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: { model: "anthropic/claude-sonnet-4-5" },
          research: {
            model: "anthropic/claude-opus-4-5",
            description: "Deep research mode",
            mode: "primary",
            enter_description: "Use for deep research",
            exit_description: "Use when research is complete",
            fallback_models: ["openai/gpt-5.4", { model: "anthropic/claude-sonnet-4-5", variant: "high" }],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const research = await Agent.get("research")

        expect(build?.model?.modelID?.toString()).toContain("claude-sonnet-4-5")
        expect(research?.model?.modelID?.toString()).toContain("claude-opus-4-5")

        expect(research?.fallbackModels).toHaveLength(2)
        expect(research?.fallbackModels?.[0]).toBe("openai/gpt-5.4")
        const fb2 = research?.fallbackModels?.[1] as { model: string; variant: string }
        expect(fb2.model).toBe("anthropic/claude-sonnet-4-5")
        expect(fb2.variant).toBe("high")
      },
    })
  })

  test("fallback chain supports mixed string and object entries", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: {
            description: "Research mode",
            mode: "primary",
            fallback_models: [
              "openai/gpt-5.4",
              { model: "anthropic/claude-sonnet-4-5", temperature: 0.3, variant: "high" },
              { model: "zai-coding-plan/glm-5", reasoningEffort: "medium", maxTokens: 8192 },
            ],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        const chain = research?.fallbackModels ?? []
        expect(chain).toHaveLength(3)

        expect(chain[0]).toBe("openai/gpt-5.4")

        const entry1 = chain[1] as { model: string; temperature: number; variant: string }
        expect(entry1.model).toBe("anthropic/claude-sonnet-4-5")
        expect(entry1.temperature).toBe(0.3)
        expect(entry1.variant).toBe("high")

        const entry2 = chain[2] as { model: string; reasoningEffort: string; maxTokens: number }
        expect(entry2.model).toBe("zai-coding-plan/glm-5")
        expect(entry2.reasoningEffort).toBe("medium")
        expect(entry2.maxTokens).toBe(8192)
      },
    })
  })

  test("subagents with different models for multi-model orchestration", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: {
            description: "Research mode",
            mode: "primary",
            model: "anthropic/claude-opus-4-5",
            enter_description: "Use for research",
            exit_description: "Exit research",
            permission: { edit: "deny", bash: "deny", task: "allow" },
          },
          "research-explore": {
            description: "Fast literature scanning subagent for research",
            mode: "subagent",
            model: "anthropic/claude-haiku-4-5",
            permission: { edit: "deny", bash: "deny", websearch: "allow" },
          },
          "research-analyze": {
            description: "Deep analysis subagent for research",
            mode: "subagent",
            model: "openai/gpt-5.4",
            variant: "high",
            permission: { edit: "deny", bash: "deny" },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        const explore = await Agent.get("research-explore")
        const analyze = await Agent.get("research-analyze")

        expect(research?.mode).toBe("primary")
        expect(research?.model?.modelID?.toString()).toContain("claude-opus-4-5")

        expect(explore?.mode).toBe("subagent")
        expect(explore?.model?.modelID?.toString()).toContain("claude-haiku-4-5")

        expect(analyze?.mode).toBe("subagent")
        expect(analyze?.model?.modelID?.toString()).toContain("gpt-5.4")
        expect(analyze?.variant).toBe("high")
      },
    })
  })

  test("fallback_models chain preserves per-entry settings", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          research: {
            description: "Research mode",
            mode: "primary",
            fallback_models: [
              "openai/gpt-5.4",
              { model: "anthropic/claude-sonnet-4-5", temperature: 0.3, variant: "high", top_p: 0.9 },
              { model: "zai-coding-plan/glm-5", reasoningEffort: "medium", maxTokens: 8192 },
            ],
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        const chain = research?.fallbackModels ?? []
        expect(chain).toHaveLength(3)

        expect(chain[0]).toBe("openai/gpt-5.4")

        const entry1 = chain[1] as { model: string; temperature: number; variant: string; top_p: number }
        expect(entry1.model).toBe("anthropic/claude-sonnet-4-5")
        expect(entry1.temperature).toBe(0.3)
        expect(entry1.variant).toBe("high")
        expect(entry1.top_p).toBe(0.9)

        const entry2 = chain[2] as { model: string; reasoningEffort: string; maxTokens: number }
        expect(entry2.model).toBe("zai-coding-plan/glm-5")
        expect(entry2.reasoningEffort).toBe("medium")
        expect(entry2.maxTokens).toBe(8192)
      },
    })
  })
})
