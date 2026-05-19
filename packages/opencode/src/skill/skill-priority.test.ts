import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { Skill } from "./index"
import { Global } from "@/global"
import { Config } from "@/config/config"
import { Spawner } from "@/skill-evolution/spawner"

// Write a minimal SKILL.md for testing
async function writeSkill(dir: string, name: string, description: string) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nSkill content.\n`,
  )
}

// Create a temporary directory with cleanup
async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "skill-priority-test-"))
  return {
    path: p,
    cleanup: () => fs.rm(p, { recursive: true, force: true }),
  }
}

// Run fn inside an Instance context with explicit worktree so loadSkills sees them as separate
async function withInstance<T>(directory: string, worktree: string, fn: () => Promise<T>): Promise<T> {
  const project = {
    id: ProjectID.fromDirectory(directory),
    worktree,
    sandboxes: [] as string[],
    time: { created: Date.now(), updated: Date.now() },
  }
  return Instance.provide({ directory, worktree, project, fn: () => fn() })
}

describe("skill/loadSkills priority ordering", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let origHome: string | undefined
  let origConfig: string

  beforeEach(async () => {
    tmp = await makeTmp()
    origHome = process.env.OPENCODE_TEST_HOME
    origConfig = Global.Path.config
    // Isolate home to avoid picking up real ~/.claude etc.
    process.env.OPENCODE_TEST_HOME = path.join(tmp.path, "home")
    await fs.mkdir(process.env.OPENCODE_TEST_HOME, { recursive: true })
    ;(Global.Path as { config: string }).config = path.join(tmp.path, "config")
    Config.global.reset()
  })

  afterEach(async () => {
    if (origHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = origHome
    ;(Global.Path as { config: string }).config = origConfig
    Config.global.reset()
    await tmp.cleanup()
  })

  test("global skill beats config root skill", async () => {
    const home = process.env.OPENCODE_TEST_HOME!
    const worktree = path.join(tmp.path, "proj-config-global")
    await fs.mkdir(worktree, { recursive: true })

    await writeSkill(path.join(Global.Path.config, "skills", "lint"), "lint", "config")
    await writeSkill(path.join(home, ".agents", "skills", "lint"), "lint", "global")

    const skill = await withInstance(worktree, worktree, () => Skill.get("lint"))
    expect(skill?.description).toBe("global")
  })

  test("inner directory skill beats outer (worktree) skill — last-wins reversed scan", async () => {
    const worktree = path.join(tmp.path, "worktree")
    const inner = path.join(worktree, "subdir")
    await fs.mkdir(inner, { recursive: true })

    // Outer skill at worktree level
    await writeSkill(path.join(worktree, ".claude", "skills", "greet"), "greet", "outer")
    // Inner skill at working-directory level (should win)
    await writeSkill(path.join(inner, ".claude", "skills", "greet"), "greet", "inner")

    const skill = await withInstance(inner, worktree, () => Skill.get("greet"))
    expect(skill?.description).toBe("inner")
  })

  test("skill-sessions skill is overridden by project skill", async () => {
    const worktree = path.join(tmp.path, "project")
    await fs.mkdir(worktree, { recursive: true })

    const projectId = String(ProjectID.fromDirectory(worktree))
    const home = process.env.OPENCODE_TEST_HOME!

    // AI review-created skill (lowest priority)
    await writeSkill(
      path.join(home, ".aether", "skill-sessions", projectId, "skills", "deploy"),
      "deploy",
      "session",
    )
    // User skill in project (should win)
    await writeSkill(path.join(worktree, ".claude", "skills", "deploy"), "deploy", "project")

    const skill = await withInstance(worktree, worktree, () => Skill.get("deploy"))
    expect(skill?.description).toBe("project")
  })

  test("skill-sessions skill is loaded when no project skill exists", async () => {
    const worktree = path.join(tmp.path, "project2")
    await fs.mkdir(worktree, { recursive: true })

    const projectId = String(ProjectID.fromDirectory(worktree))

    await writeSkill(
      path.join(Spawner.skillSessionsDir(Spawner.skillFolderName(worktree, projectId)), "analyze"),
      "analyze",
      "session-only",
    )

    const skill = await withInstance(worktree, worktree, () => Skill.get("analyze"))
    expect(skill?.description).toBe("session-only")
  })

  test("project skill beats global skill", async () => {
    const home = process.env.OPENCODE_TEST_HOME!
    const worktree = path.join(tmp.path, "proj3")
    await fs.mkdir(worktree, { recursive: true })

    // Global skill
    await writeSkill(path.join(home, ".claude", "skills", "lint"), "lint", "global")
    // Project skill (should win)
    await writeSkill(path.join(worktree, ".claude", "skills", "lint"), "lint", "project")

    const skill = await withInstance(worktree, worktree, () => Skill.get("lint"))
    expect(skill?.description).toBe("project")
  })

  test("project .claude skill beats global .aether skill", async () => {
    const home = process.env.OPENCODE_TEST_HOME!
    const worktree = path.join(tmp.path, "proj-aether-vs-claude")
    await fs.mkdir(worktree, { recursive: true })

    // Global ~/.aether/skills/build/ (should lose to project)
    await writeSkill(path.join(home, ".aether", "skills", "build"), "build", "global-aether")
    // Project .claude/skills/build/ (should win — project > global)
    await writeSkill(path.join(worktree, ".claude", "skills", "build"), "build", "project-claude")

    const skill = await withInstance(worktree, worktree, () => Skill.get("build"))
    expect(skill?.description).toBe("project-claude")
  })

  test("project .aether skill beats project .claude skill (shadow wins)", async () => {
    const worktree = path.join(tmp.path, "proj-shadow")
    await fs.mkdir(worktree, { recursive: true })

    // .claude/skills/ — original source
    await writeSkill(path.join(worktree, ".claude", "skills", "format"), "format", "original")
    // .aether/skills/ — shadow/evolved version (should win — .aether > .claude within same project)
    await writeSkill(path.join(worktree, ".aether", "skills", "format"), "format", "shadow")

    const skill = await withInstance(worktree, worktree, () => Skill.get("format"))
    expect(skill?.description).toBe("shadow")
  })

  test("project .aether skill beats project .opencode skill", async () => {
    const worktree = path.join(tmp.path, "proj-aether-opencode")
    await fs.mkdir(worktree, { recursive: true })

    await writeSkill(path.join(worktree, ".opencode", "skills", "format"), "format", "opencode")
    await writeSkill(path.join(worktree, ".aether", "skills", "format"), "format", "aether")

    const skill = await withInstance(worktree, worktree, () => Skill.get("format"))
    expect(skill?.description).toBe("aether")
  })

  test("inner .agents skill beats outer .aether skill", async () => {
    const worktree = path.join(tmp.path, "proj-inner-outer")
    const inner = path.join(worktree, "pkg")
    await fs.mkdir(inner, { recursive: true })

    await writeSkill(path.join(worktree, ".aether", "skills", "build"), "build", "outer-aether")
    await writeSkill(path.join(inner, ".agents", "skills", "build"), "build", "inner-agents")

    const skill = await withInstance(inner, worktree, () => Skill.get("build"))
    expect(skill?.description).toBe("inner-agents")
  })

  test("global .aether skill beats global .claude skill", async () => {
    const home = process.env.OPENCODE_TEST_HOME!
    const worktree = path.join(tmp.path, "proj-global-order")
    await fs.mkdir(worktree, { recursive: true })

    // ~/.claude/skills/ — lower global priority
    await writeSkill(path.join(home, ".claude", "skills", "check"), "check", "global-claude")
    // ~/.aether/skills/ — higher global priority (.aether > .claude)
    await writeSkill(path.join(home, ".aether", "skills", "check"), "check", "global-aether")

    const skill = await withInstance(worktree, worktree, () => Skill.get("check"))
    expect(skill?.description).toBe("global-aether")
  })
})
