import { afterEach, test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { SkillManageTool } from "../../src/tool/skill-manage"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import path from "path"
import fs from "fs/promises"

afterEach(async () => {
  await Instance.disposeAll()
})

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test_shadow"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

async function writeSkill(skillDir: string, name: string, description: string, body: string) {
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  )
}

async function exists(p: string) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

test(".aether/ overrides .claude/ when same skill name exists", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(path.join(dir, ".claude", "skills", "shared"), "shared", "from claude", "claude body")
      await writeSkill(path.join(dir, ".aether", "skills", "shared"), "shared", "from aether", "aether body")
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skill = await Skill.get("shared")
        expect(skill).toBeDefined()
        expect(skill!.description).toBe("from aether")
        expect(skill!.location).toContain(path.join(".aether", "skills", "shared"))
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("patch on .claude/ skill creates shadow in .aether/, leaves original intact", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(
        path.join(dir, ".claude", "skills", "evolve-me"),
        "evolve-me",
        "original",
        "Hello from claude",
      )
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const before = await Skill.get("evolve-me")
        expect(before!.location).toContain(path.join(".claude", "skills", "evolve-me"))

        const tool = await SkillManageTool.init()
        await tool.execute(
          {
            action: "patch",
            name: "evolve-me",
            old_str: "Hello from claude",
            new_str: "Hello from aether",
          },
          baseCtx as Tool.Context,
        )

        const aetherFile = path.join(tmp.path, ".aether", "skills", "evolve-me", "SKILL.md")
        const claudeFile = path.join(tmp.path, ".claude", "skills", "evolve-me", "SKILL.md")
        expect(await exists(aetherFile)).toBe(true)
        expect(await exists(claudeFile)).toBe(true)

        const aetherContent = await fs.readFile(aetherFile, "utf8")
        const claudeContent = await fs.readFile(claudeFile, "utf8")
        expect(aetherContent).toContain("Hello from aether")
        expect(claudeContent).toContain("Hello from claude")
        expect(claudeContent).not.toContain("Hello from aether")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("second patch on already-evolved skill modifies in place, no duplicate copy", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(path.join(dir, ".claude", "skills", "twice"), "twice", "v0", "step zero")
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillManageTool.init()
        await tool.execute(
          { action: "patch", name: "twice", old_str: "step zero", new_str: "step one" },
          baseCtx as Tool.Context,
        )
        await tool.execute(
          { action: "patch", name: "twice", old_str: "step one", new_str: "step two" },
          baseCtx as Tool.Context,
        )

        const aetherFile = path.join(tmp.path, ".aether", "skills", "twice", "SKILL.md")
        const content = await fs.readFile(aetherFile, "utf8")
        expect(content).toContain("step two")
        expect(content).not.toContain("step zero")
        expect(content).not.toContain("step one")

        const claudeFile = path.join(tmp.path, ".claude", "skills", "twice", "SKILL.md")
        expect(await fs.readFile(claudeFile, "utf8")).toContain("step zero")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("patch creates version snapshot inside .aether/<name>/.versions/", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(path.join(dir, ".claude", "skills", "snap-me"), "snap-me", "d", "v0 body")
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillManageTool.init()
        await tool.execute(
          { action: "patch", name: "snap-me", old_str: "v0 body", new_str: "v1 body" },
          baseCtx as Tool.Context,
        )
        await tool.execute(
          { action: "patch", name: "snap-me", old_str: "v1 body", new_str: "v2 body" },
          baseCtx as Tool.Context,
        )

        const versionsDir = path.join(tmp.path, ".aether", "skills", "snap-me", ".versions")
        expect(await exists(versionsDir)).toBe(true)
        const entries = await fs.readdir(versionsDir)
        const bundles = entries.filter((e) => e.endsWith(".bundle.json"))
        expect(bundles.length).toBe(2)
        expect(bundles.some((b) => b.includes("_patch_"))).toBe(true)

        const claudeVersions = path.join(tmp.path, ".claude", "skills", "snap-me", ".versions")
        expect(await exists(claudeVersions)).toBe(false)
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("delete on un-evolved skill errors with helpful message", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(path.join(dir, ".claude", "skills", "nope"), "nope", "d", "body")
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillManageTool.init()
        await expect(
          tool.execute({ action: "delete", name: "nope" }, baseCtx as Tool.Context),
        ).rejects.toThrow(/not been evolved/)

        const claudeFile = path.join(tmp.path, ".claude", "skills", "nope", "SKILL.md")
        expect(await exists(claudeFile)).toBe(true)
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("delete on evolved skill removes only the .aether/ copy", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await writeSkill(path.join(dir, ".claude", "skills", "revertable"), "revertable", "d", "original body")
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await SkillManageTool.init()
        await tool.execute(
          { action: "patch", name: "revertable", old_str: "original body", new_str: "evolved body" },
          baseCtx as Tool.Context,
        )

        const aetherDir = path.join(tmp.path, ".aether", "skills", "revertable")
        expect(await exists(aetherDir)).toBe(true)

        await tool.execute({ action: "delete", name: "revertable" }, baseCtx as Tool.Context)

        expect(await exists(aetherDir)).toBe(false)
        const claudeFile = path.join(tmp.path, ".claude", "skills", "revertable", "SKILL.md")
        expect(await fs.readFile(claudeFile, "utf8")).toContain("original body")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})
