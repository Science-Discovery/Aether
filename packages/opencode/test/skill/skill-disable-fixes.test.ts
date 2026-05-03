import { afterEach, describe, expect, test, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Skill } from "../../src/skill"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { PROJECT, LEGACY_PROJECT } from "../../src/persist/naming"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  Config.global.reset()
})

// Helpers to save/restore global state
function patchGlobalConfig(dir: string): () => void {
  const prev = (Global.Path as Record<string, string>).config
  ;(Global.Path as Record<string, string>).config = dir
  Config.global.reset()
  return () => {
    ;(Global.Path as Record<string, string>).config = prev
    Config.global.reset()
  }
}

function patchHome(dir: string): () => void {
  const prev = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = dir
  return () => {
    if (prev === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = prev
  }
}

async function writeAetherConfig(configDir: string, data: object) {
  await fs.mkdir(configDir, { recursive: true })
  await Bun.write(path.join(configDir, "aether.json"), JSON.stringify(data))
  Config.global.reset()
}

async function makeSkill(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A test skill\n---\n\nContent.`,
  )
}

// ─── Fix 1: path-based disabled storage ───────────────────────────────────────

describe("Fix 1: path-based disabled storage", () => {
  test("DefaultSkill schema accepts file field", () => {
    const result = Config.DefaultSkill.safeParse({
      name: "foo",
      description: "test",
      content: "content",
      file: "/home/user/.aether/skills/foo",
    })
    expect(result.success).toBe(true)
    expect(result.data?.file).toBe("/home/user/.aether/skills/foo")
  })

  test("listManagedSkills returns file field with absolute skill dir path", async () => {
    await using homeTmp = await tmpdir()
    const restoreHome = patchHome(homeTmp.path)
    try {
      const skillDir = path.join(homeTmp.path, PROJECT, "skills", "my-skill")
      await makeSkill(skillDir, "my-skill")

      const skills = await Config.listManagedSkills()
      const skill = skills.find((s) => s.name === "my-skill")

      expect(skill).toBeDefined()
      expect(skill?.file).toBe(skillDir)
    } finally {
      restoreHome()
    }
  })

  test("listManagedSkills: enabled=false when skill dir path is in disabled list", async () => {
    await using homeTmp = await tmpdir()
    await using configTmp = await tmpdir()
    const restoreHome = patchHome(homeTmp.path)
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      const skillDir = path.join(homeTmp.path, PROJECT, "skills", "my-skill")
      await makeSkill(skillDir, "my-skill")
      await writeAetherConfig(configTmp.path, { skills: { disabled: [skillDir] } })

      const skills = await Config.listManagedSkills()
      const skill = skills.find((s) => s.name === "my-skill")

      expect(skill).toBeDefined()
      expect(skill?.enabled).toBe(false)
    } finally {
      restoreHome()
      restoreConfig()
    }
  })

  test("listManagedSkills: same-name skill from different path stays enabled", async () => {
    await using homeTmp = await tmpdir()
    await using configTmp = await tmpdir()
    const restoreHome = patchHome(homeTmp.path)
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      const skillDir = path.join(homeTmp.path, PROJECT, "skills", "shared-name")
      await makeSkill(skillDir, "shared-name")

      // Disable a DIFFERENT path with the same name (simulates another project's skill)
      const otherPath = "/other/project/.aether/skills/shared-name"
      await writeAetherConfig(configTmp.path, { skills: { disabled: [otherPath] } })

      const skills = await Config.listManagedSkills()
      const skill = skills.find((s) => s.name === "shared-name")

      // Path didn't match → still enabled
      expect(skill).toBeDefined()
      expect(skill?.enabled).toBe(true)
    } finally {
      restoreHome()
      restoreConfig()
    }
  })

  test("toggleSkill stores absolute path (not skill name) in disabled set", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    const clearSpy = spyOn(Skill, "clearSkillsPromptCache").mockResolvedValue(undefined)
    try {
      const skillPath = "/some/project/.aether/skills/my-skill"
      await Config.toggleSkill(skillPath, false)

      Config.global.reset()
      const cfg = await Config.getGlobal()

      expect(cfg.skills?.disabled).toContain(skillPath)
      expect(cfg.skills?.disabled).not.toContain("my-skill")
    } finally {
      restoreConfig()
      clearSpy.mockRestore()
    }
  })

  test("toggleSkill on/off round-trip: re-enabling removes path from disabled set", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    const clearSpy = spyOn(Skill, "clearSkillsPromptCache").mockResolvedValue(undefined)
    try {
      const skillPath = "/some/project/.aether/skills/my-skill"

      await Config.toggleSkill(skillPath, false)
      Config.global.reset()
      const disabled = await Config.getGlobal()
      expect(disabled.skills?.disabled).toContain(skillPath)

      await Config.toggleSkill(skillPath, true)
      Config.global.reset()
      const enabled = await Config.getGlobal()
      expect(enabled.skills?.disabled ?? []).not.toContain(skillPath)
    } finally {
      restoreConfig()
      clearSpy.mockRestore()
    }
  })

  test("disabling .aether skill falls back to .opencode skill with same name", async () => {
    await using projectTmp = await tmpdir({ git: true })
    await using homeTmp = await tmpdir()
    await using configTmp = await tmpdir()
    const restoreHome = patchHome(homeTmp.path)
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      const aetherSkillDir = path.join(projectTmp.path, PROJECT, "skills", "shared-skill")
      const opencodeSkillDir = path.join(projectTmp.path, LEGACY_PROJECT, "skills", "shared-skill")
      await makeSkill(aetherSkillDir, "shared-skill")
      await makeSkill(opencodeSkillDir, "shared-skill")

      // Disable only the .aether version
      await writeAetherConfig(configTmp.path, { skills: { disabled: [aetherSkillDir] } })

      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const all = await Skill.all()
          const found = all.find((s) => s.name === "shared-skill")
          expect(found).toBeDefined()
          expect(found?.location).toContain(LEGACY_PROJECT)
        },
      })
    } finally {
      restoreHome()
      restoreConfig()
    }
  })

  test("loadSkillsData filters disabled skills by path at runtime", async () => {
    await using projectTmp = await tmpdir({ git: true })
    await using homeTmp = await tmpdir()
    await using configTmp = await tmpdir()
    const restoreHome = patchHome(homeTmp.path)
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      const skillDir = path.join(projectTmp.path, PROJECT, "skills", "project-skill")
      await makeSkill(skillDir, "project-skill")

      // Disable by path
      await writeAetherConfig(configTmp.path, { skills: { disabled: [skillDir] } })

      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const all = await Skill.all()
          const found = all.find((s) => s.name === "project-skill")
          expect(found).toBeUndefined()
        },
      })
    } finally {
      restoreHome()
      restoreConfig()
    }
  })
})

// ─── Fix 2: scoped memory invalidation ────────────────────────────────────────

describe("Fix 2: scoped clearSkillsPromptCache", () => {
  test('clearSkillsPromptCache("all") resolves without error', async () => {
    await expect(Skill.clearSkillsPromptCache("all")).resolves.toBeUndefined()
  })

  test("clearSkillsPromptCache(projectDir) resolves without error", async () => {
    await expect(Skill.clearSkillsPromptCache("/some/project")).resolves.toBeUndefined()
  })

  test("toggleSkill passes scope=all for a skill under global ~/.aether/skills/", async () => {
    await using homeTmp = await tmpdir()
    await using configTmp = await tmpdir()
    const restoreHome = patchHome(homeTmp.path)
    const restoreConfig = patchGlobalConfig(configTmp.path)
    const clearSpy = spyOn(Skill, "clearSkillsPromptCache").mockResolvedValue(undefined)
    try {
      const globalSkillPath = path.join(homeTmp.path, PROJECT, "skills", "global-skill")
      await Config.toggleSkill(globalSkillPath, false)

      expect(clearSpy).toHaveBeenCalledWith("all")
    } finally {
      restoreHome()
      restoreConfig()
      clearSpy.mockRestore()
    }
  })

  test("toggleSkill passes project dir for a skill under project/.aether/skills/", async () => {
    await using homeTmp = await tmpdir()
    await using configTmp = await tmpdir()
    await using projectTmp = await tmpdir()
    const restoreHome = patchHome(homeTmp.path)
    const restoreConfig = patchGlobalConfig(configTmp.path)
    const clearSpy = spyOn(Skill, "clearSkillsPromptCache").mockResolvedValue(undefined)
    try {
      const projectSkillPath = path.join(projectTmp.path, PROJECT, "skills", "project-skill")
      await Config.toggleSkill(projectSkillPath, false)

      expect(clearSpy).toHaveBeenCalledWith(projectTmp.path)
    } finally {
      restoreHome()
      restoreConfig()
      clearSpy.mockRestore()
    }
  })
})

// ─── Fix 3: skill_manage disabled check ───────────────────────────────────────

describe("Fix 3: skill_manage disabled name check", () => {
  test("disabled name set is correctly extracted from path list", () => {
    const disabledPaths = [
      "/home/user/.aether/skills/foo",
      "/projects/myapp/.aether/skills/bar-skill",
    ]
    const names = new Set(disabledPaths.map((p) => path.basename(p)))

    expect(names.has("foo")).toBe(true)
    expect(names.has("bar-skill")).toBe(true)
    expect(names.has("baz")).toBe(false)
  })

  test("Config.getGlobal returns disabled paths readable by skill_manage logic", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      const disabledPath = "/some/project/.aether/skills/blocked-skill"
      await writeAetherConfig(configTmp.path, { skills: { disabled: [disabledPath] } })

      const cfg = await Config.getGlobal()
      const disabledNames = new Set((cfg.skills?.disabled ?? []).map((p) => path.basename(p)))

      expect(disabledNames.has("blocked-skill")).toBe(true)
      expect(disabledNames.has("other-skill")).toBe(false)
    } finally {
      restoreConfig()
    }
  })

  test("skill_manage blocks disabled skill: execute throws with clear message", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      const disabledPath = "/some/project/.aether/skills/blocked-skill"
      await writeAetherConfig(configTmp.path, { skills: { disabled: [disabledPath] } })

      // Import and call skill_manage tool directly
      const { SkillManageTool } = await import("../../src/tool/skill-manage")
      const tool = await SkillManageTool.init()

      await expect(
        tool.execute({ action: "edit", name: "blocked-skill", description: "x", content: "y" }, undefined as any),
      ).rejects.toThrow("blocked-skill")

      await expect(
        tool.execute({ action: "create", name: "blocked-skill", description: "x", content: "y" }, undefined as any),
      ).rejects.toThrow("blocked-skill")

      await expect(
        tool.execute({ action: "patch", name: "blocked-skill", old_str: "a", new_str: "b" }, undefined as any),
      ).rejects.toThrow("blocked-skill")
    } finally {
      restoreConfig()
    }
  })

  test("skill_manage allows non-disabled skill to proceed past the disabled check", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      await writeAetherConfig(configTmp.path, { skills: { disabled: ["/some/project/.aether/skills/other-skill"] } })

      const { SkillManageTool } = await import("../../src/tool/skill-manage")
      const tool = await SkillManageTool.init()

      // "allowed-skill" is not in the disabled list — it should not throw for the disabled reason
      // It may throw for other reasons (e.g., skill not found), but not "is currently disabled"
      try {
        await tool.execute({ action: "edit", name: "allowed-skill", description: "x", content: "y" }, undefined as any)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        expect(msg).not.toContain("is currently disabled")
      }
    } finally {
      restoreConfig()
    }
  })
})
