import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { Skill } from "./index"

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

  beforeEach(async () => {
    tmp = await makeTmp()
    origHome = process.env.OPENCODE_TEST_HOME
    // Isolate home to avoid picking up real ~/.claude etc.
    process.env.OPENCODE_TEST_HOME = path.join(tmp.path, "home")
    await fs.mkdir(process.env.OPENCODE_TEST_HOME, { recursive: true })
  })

  afterEach(async () => {
    if (origHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = origHome
    await tmp.cleanup()
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
    const home = process.env.OPENCODE_TEST_HOME!

    await writeSkill(
      path.join(home, ".aether", "skill-sessions", projectId, "skills", "analyze"),
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
})
