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

describe("Skill cache invalidation + setSkillFileFlag", () => {
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

  // A1: after invalidate(), the next Skill.all() must re-read config and drop a
  // skill newly listed in aether.json's disabled_files. We mutate aether.json
  // DIRECTLY (not via setSkillFileFlag) so the skill cache is NOT auto-refreshed,
  // and we pick disabled_files specifically because isFresh() only watches
  // SKILL.md mtimes — it will NOT auto-detect this change. That isolates the
  // effect of invalidate() itself (without it, the stale cache still shows demo).
  test("invalidate() makes Skill.all() pick up a config-only change isFresh ignores", async () => {
    const worktree = path.join(tmp.path, "proj-inv")
    const sDir = path.join(worktree, ".aether", "skills", "demo")
    await writeSkill(sDir, "demo", "a demo skill")
    const sFile = path.join(sDir, "SKILL.md")

    await withInstance(worktree, worktree, async () => {
      // Build the cache: demo is present.
      expect((await Skill.all()).map((s) => s.name)).toContain("demo")

      // Mutate config on disk, then refresh ONLY the config cache. This isolates
      // the skill cache as the single variable: isFresh() watches SKILL.md mtimes,
      // not aether.json, so the skill cache stays stale until invalidate().
      await fs.writeFile(
        path.join(worktree, "aether.json"),
        JSON.stringify({ skills: { disabled_files: [path.resolve(sFile)] } }),
      )
      Config.state.reset()
      // Config is fresh but the skill cache is stale → demo still shows.
      expect((await Skill.all()).map((s) => s.name)).toContain("demo")

      // Force a rebuild; now the config change takes effect.
      await Skill.invalidate()
      expect((await Skill.all()).map((s) => s.name)).not.toContain("demo")
    })
  })

  // A2: disabling a PROJECT skill must take effect live — Skill.all() should drop
  // it immediately after setSkillFileFlag, WITHOUT a separate Instance.dispose().
  // The project branch writes aether.json but (before the fix) refreshes no cache,
  // and isFresh() can't see an aether.json-only change, so the skill stays cached.
  test("disabling a project skill makes Skill.all() drop it immediately (no dispose)", async () => {
    const worktree = path.join(tmp.path, "proj-a2")
    const pDir = path.join(worktree, ".aether", "skills", "p1")
    await writeSkill(pDir, "p1", "a project skill")
    const pFile = path.join(pDir, "SKILL.md")

    await withInstance(worktree, worktree, async () => {
      // Build the cache: p1 present.
      expect((await Skill.all()).map((s) => s.name)).toContain("p1")

      // Toggle disable via the production code path (project scope).
      await Skill.setSkillFileFlag(pFile, "disabled_files", true)

      // Must take effect live, without anyone calling Instance.dispose().
      expect((await Skill.all()).map((s) => s.name)).not.toContain("p1")
    })
  })

  // A3: stop-evolution must be visible to the review/guard read path, which reads
  // Config.get() (project cache) in the main instance context — see
  // review-agent.ts (MainConfig.get) and the guard snapshot. So after the toggle,
  // Config.get().skills.evolution_disabled_files must contain the path live.
  test("stop-evolution is visible via Config.get() immediately (review/guard read path)", async () => {
    const worktree = path.join(tmp.path, "proj-a3")
    const pDir = path.join(worktree, ".aether", "skills", "e1")
    await writeSkill(pDir, "e1", "a project skill")
    const pFile = path.join(pDir, "SKILL.md")

    await withInstance(worktree, worktree, async () => {
      // Prime the project config cache (so a stale cache would hide the change).
      const before = (await Config.get()).skills?.evolution_disabled_files ?? []
      expect(before.map((p) => path.resolve(p))).not.toContain(path.resolve(pFile))

      await Skill.setSkillFileFlag(pFile, "evolution_disabled_files", true)

      const after = (await Config.get()).skills?.evolution_disabled_files ?? []
      expect(after.map((p) => path.resolve(p))).toContain(path.resolve(pFile))
    })
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

  // A4: disabling a GLOBAL skill must also take effect live via the targeted
  // refresh — NOT via Instance.dispose() (the flash source we're removing).
  test("disabling a global skill makes Skill.all() drop it immediately (no dispose)", async () => {
    const home = process.env.OPENCODE_TEST_HOME!
    const worktree = path.join(tmp.path, "proj-a4")
    await fs.mkdir(worktree, { recursive: true })

    const gDir = path.join(home, ".aether", "skills", "g1")
    await writeSkill(gDir, "g1", "a global skill")
    const gFile = path.join(gDir, "SKILL.md")

    await withInstance(worktree, worktree, async () => {
      expect((await Skill.all()).map((s) => s.name)).toContain("g1")
      await Skill.setSkillFileFlag(gFile, "disabled_files", true)
      expect((await Skill.all()).map((s) => s.name)).not.toContain("g1")
    })
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
