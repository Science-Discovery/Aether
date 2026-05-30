import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { Skill } from "./index"
import { Global } from "@/global"
import { Config } from "@/config/config"

// Same isolation harness as skill-disable.test.ts.
async function writeSkill(dir: string, name: string, description: string) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nSkill content.\n`,
  )
}

async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "skill-set-flag-test-"))
  return { path: p, cleanup: () => fs.rm(p, { recursive: true, force: true }) }
}

async function withInstance<T>(directory: string, worktree: string, fn: () => Promise<T>): Promise<T> {
  const project = {
    id: ProjectID.fromDirectory(directory),
    worktree,
    sandboxes: [] as string[],
    time: { created: Date.now(), updated: Date.now() },
  }
  return Instance.provide({ directory, worktree, project, fn: () => fn() })
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}"))
}

describe("Skill.setSkillFileFlag — writes to the layer matching the skill's scope", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let origHome: string | undefined
  let origConfig: string
  let origData: string

  beforeEach(async () => {
    tmp = await makeTmp()
    origHome = process.env.OPENCODE_TEST_HOME
    origConfig = Global.Path.config
    origData = Global.Path.data
    process.env.OPENCODE_TEST_HOME = path.join(tmp.path, "home")
    await fs.mkdir(process.env.OPENCODE_TEST_HOME, { recursive: true })
    ;(Global.Path as { config: string }).config = path.join(tmp.path, "config")
    ;(Global.Path as { data: string }).data = path.join(tmp.path, "data")
    await fs.mkdir(Global.Path.config, { recursive: true })
    Config.global.reset()
  })

  afterEach(async () => {
    if (origHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = origHome
    ;(Global.Path as { config: string }).config = origConfig
    ;(Global.Path as { data: string }).data = origData
    Config.global.reset()
    await tmp.cleanup()
  })

  test("disabling a global-scope skill writes its path to the GLOBAL config, not the project config", async () => {
    const home = process.env.OPENCODE_TEST_HOME!
    const worktree = path.join(tmp.path, "proj")
    await fs.mkdir(worktree, { recursive: true })

    const gDir = path.join(home, ".aether", "skills", "globalskill")
    await writeSkill(gDir, "globalskill", "a global skill")
    const gFile = path.join(gDir, "SKILL.md")

    await withInstance(worktree, worktree, () => Skill.setSkillFileFlag(gFile, "disabled_files", true))

    const globalCfg = await readJson(path.join(Global.Path.config, "aether.json"))
    const projectCfg = await readJson(path.join(worktree, "aether.json"))
    expect(globalCfg.skills?.disabled_files ?? []).toContain(gFile)
    expect(projectCfg.skills?.disabled_files ?? []).not.toContain(gFile)
  })

  test("disabling a project-scope skill writes its path to the PROJECT aether.json", async () => {
    const worktree = path.join(tmp.path, "proj2")
    await fs.mkdir(worktree, { recursive: true })

    const pDir = path.join(worktree, ".aether", "skills", "projskill")
    await writeSkill(pDir, "projskill", "a project skill")
    const pFile = path.join(pDir, "SKILL.md")

    await withInstance(worktree, worktree, () => Skill.setSkillFileFlag(pFile, "disabled_files", true))

    const projectCfg = await readJson(path.join(worktree, "aether.json"))
    const globalCfg = await readJson(path.join(Global.Path.config, "aether.json"))
    expect(projectCfg.skills?.disabled_files ?? []).toContain(pFile)
    expect(globalCfg.skills?.disabled_files ?? []).not.toContain(pFile)
  })

  test("the same function handles evolution_disabled_files via the field arg", async () => {
    const worktree = path.join(tmp.path, "proj3")
    await fs.mkdir(worktree, { recursive: true })

    const pDir = path.join(worktree, ".aether", "skills", "evoskill")
    await writeSkill(pDir, "evoskill", "a project skill")
    const pFile = path.join(pDir, "SKILL.md")

    await withInstance(worktree, worktree, () =>
      Skill.setSkillFileFlag(pFile, "evolution_disabled_files", true),
    )

    const projectCfg = await readJson(path.join(worktree, "aether.json"))
    expect(projectCfg.skills?.evolution_disabled_files ?? []).toContain(pFile)
    expect(projectCfg.skills?.disabled_files ?? []).not.toContain(pFile)
  })

  test("on=false removes the path; an unrelated already-disabled path is preserved", async () => {
    const worktree = path.join(tmp.path, "proj4")
    await fs.mkdir(worktree, { recursive: true })

    const pDir = path.join(worktree, ".aether", "skills", "toggleoff")
    await writeSkill(pDir, "toggleoff", "a project skill")
    const pFile = path.join(pDir, "SKILL.md")

    // Pre-seed the project config with our skill + an unrelated disabled path.
    await fs.writeFile(
      path.join(worktree, "aether.json"),
      JSON.stringify({ skills: { disabled_files: [pFile, "/other/SKILL.md"] } }),
    )

    await withInstance(worktree, worktree, () => Skill.setSkillFileFlag(pFile, "disabled_files", false))

    const projectCfg = await readJson(path.join(worktree, "aether.json"))
    expect(projectCfg.skills?.disabled_files ?? []).not.toContain(pFile)
    expect(projectCfg.skills?.disabled_files ?? []).toContain("/other/SKILL.md")
  })
})
