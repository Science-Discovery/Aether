import { afterEach, describe, expect, test, spyOn, mock } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { snapshot, listVersions } from "../../src/tool/skill-versions"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  Config.global.reset()
})

function patchGlobalConfig(dir: string): () => void {
  const prev = (Global.Path as Record<string, string>).config
  ;(Global.Path as Record<string, string>).config = dir
  Config.global.reset()
  return () => {
    ;(Global.Path as Record<string, string>).config = prev
    Config.global.reset()
  }
}

async function writeGlobalConfig(configDir: string, data: object) {
  await fs.mkdir(configDir, { recursive: true })
  await Bun.write(path.join(configDir, "aether.json"), JSON.stringify(data))
  Config.global.reset()
}

// ── 1. updateSkillsConfig 不触发 disposeAll ────────────────────────────────────

describe("updateSkillsConfig: no dispose", () => {
  test("does not call Instance.disposeAll when updating creation_nudge_interval", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      await writeGlobalConfig(configTmp.path, {})
      const spy = spyOn(Instance, "disposeAll").mockResolvedValue(undefined as any)
      await Config.updateSkillsConfig({ skills: { creation_nudge_interval: 5 } } as any)
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    } finally {
      restoreConfig()
    }
  })

  test("does not call Instance.disposeAll when updating max_versions", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      await writeGlobalConfig(configTmp.path, {})
      const spy = spyOn(Instance, "disposeAll").mockResolvedValue(undefined as any)
      await Config.updateSkillsConfig({ skills: { max_versions: 10 } } as any)
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    } finally {
      restoreConfig()
    }
  })
})

// ── 2. getGlobal() 立即反映新值 ────────────────────────────────────────────────

describe("updateSkillsConfig: getGlobal reflects new value immediately", () => {
  test("creation_nudge_interval is readable via getGlobal after update", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      await writeGlobalConfig(configTmp.path, { skills: { creation_nudge_interval: 10 } })
      const before = await Config.getGlobal()
      expect(before.skills?.creation_nudge_interval).toBe(10)

      await Config.updateSkillsConfig({ skills: { creation_nudge_interval: 3 } } as any)

      const after = await Config.getGlobal()
      expect(after.skills?.creation_nudge_interval).toBe(3)
    } finally {
      restoreConfig()
    }
  })

  test("max_versions is readable via getGlobal after update", async () => {
    await using configTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      await writeGlobalConfig(configTmp.path, { skills: { max_versions: 100 } })

      await Config.updateSkillsConfig({ skills: { max_versions: 10 } } as any)

      const after = await Config.getGlobal()
      expect(after.skills?.max_versions).toBe(10)
    } finally {
      restoreConfig()
    }
  })
})

// ── 3. 版本裁剪即时使用新 max_versions ────────────────────────────────────────

describe("prune: respects max_versions updated via updateSkillsConfig", () => {
  test("prune keeps correct count after max_versions is lowered", async () => {
    await using configTmp = await tmpdir()
    await using skillTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      // 先写 30 个版本（max=100 默认不裁剪）
      await writeGlobalConfig(configTmp.path, { skills: { max_versions: 100 } })
      const skillDir = skillTmp.path
      await fs.mkdir(path.join(skillDir, "SKILL.md").replace(/SKILL\.md$/, ""), { recursive: true })
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: test\ndescription: test\n---\nContent.")
      for (let i = 0; i < 30; i++) {
        await snapshot(skillDir, "edit")
      }
      const beforePrune = await listVersions(skillDir)
      expect(beforePrune.length).toBe(30)

      // 更新 max_versions 为 10，不 dispose
      await Config.updateSkillsConfig({ skills: { max_versions: 10 } } as any)

      // 再写一次触发 prune
      await snapshot(skillDir, "edit")
      const afterPrune = await listVersions(skillDir)
      expect(afterPrune.length).toBe(10)
    } finally {
      restoreConfig()
    }
  })

  test("prune does not remove versions when max_versions is raised", async () => {
    await using configTmp = await tmpdir()
    await using skillTmp = await tmpdir()
    const restoreConfig = patchGlobalConfig(configTmp.path)
    try {
      await writeGlobalConfig(configTmp.path, { skills: { max_versions: 5 } })
      const skillDir = skillTmp.path
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: test\ndescription: test\n---\nContent.")
      for (let i = 0; i < 5; i++) {
        await snapshot(skillDir, "edit")
      }
      expect((await listVersions(skillDir)).length).toBe(5)

      // 调高上限
      await Config.updateSkillsConfig({ skills: { max_versions: 20 } } as any)
      await snapshot(skillDir, "edit")

      // 应该是 6 个，不触发裁剪
      expect((await listVersions(skillDir)).length).toBe(6)
    } finally {
      restoreConfig()
    }
  })
})
