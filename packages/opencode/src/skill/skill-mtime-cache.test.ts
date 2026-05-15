import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { Skill } from "./index"

async function writeSkill(dir: string, name: string, description: string) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nContent.\n`,
  )
}

async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "skill-mtime-test-"))
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

// Bump a file's mtime by rewriting it with the same content.
async function touch(filePath: string) {
  const content = await fs.readFile(filePath, "utf-8")
  await fs.writeFile(filePath, content, "utf-8")
}

describe("skill mtime cache invalidation", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let origHome: string | undefined

  beforeEach(async () => {
    tmp = await makeTmp()
    origHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = path.join(tmp.path, "home")
    await fs.mkdir(process.env.OPENCODE_TEST_HOME, { recursive: true })
  })

  afterEach(async () => {
    if (origHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = origHome
    await tmp.cleanup()
  })

  test("initial load populates cache and returns skill", async () => {
    const worktree = path.join(tmp.path, "project")
    await writeSkill(path.join(worktree, ".claude", "skills", "greet"), "greet", "initial")

    const skill = await withInstance(worktree, worktree, () => Skill.get("greet"))
    expect(skill?.description).toBe("initial")
  })

  test("repeated call within same instance returns cached result without reload", async () => {
    const worktree = path.join(tmp.path, "project2")
    await writeSkill(path.join(worktree, ".claude", "skills", "ping"), "ping", "v1")

    await withInstance(worktree, worktree, async () => {
      const first = await Skill.get("ping")
      expect(first?.description).toBe("v1")
      // Second call with unchanged file — still v1
      const second = await Skill.get("ping")
      expect(second?.description).toBe("v1")
    })
  })

  test("editing SKILL.md is detected on next call via mtime snapshot", async () => {
    const worktree = path.join(tmp.path, "project3")
    const skillDir = path.join(worktree, ".claude", "skills", "build")
    await writeSkill(skillDir, "build", "original")

    // First call — loads skill and writes snapshot
    const v1 = await withInstance(worktree, worktree, () => Skill.get("build"))
    expect(v1?.description).toBe("original")

    // Edit SKILL.md externally (new content + updated mtime)
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: build\ndescription: updated\n---\nNew content.\n`,
    )

    // Next call from a fresh instance context — must pick up the edit
    const v2 = await withInstance(worktree, worktree, () => Skill.get("build"))
    expect(v2?.description).toBe("updated")
  })

  test("touching SKILL.md (mtime bump, same content) triggers cache invalidation", async () => {
    const worktree = path.join(tmp.path, "project4")
    const skillDir = path.join(worktree, ".claude", "skills", "lint")
    await writeSkill(skillDir, "lint", "stable")

    const v1 = await withInstance(worktree, worktree, () => Skill.get("lint"))
    expect(v1?.description).toBe("stable")

    // Wait 10ms to guarantee a different mtime
    await new Promise((r) => setTimeout(r, 10))
    await touch(path.join(skillDir, "SKILL.md"))

    // Should reload (mtime changed) and still return same description
    const v2 = await withInstance(worktree, worktree, () => Skill.get("lint"))
    expect(v2?.description).toBe("stable")
  })

  test("deleting SKILL.md is detected — skill disappears from list", async () => {
    const worktree = path.join(tmp.path, "project5")
    const skillDir = path.join(worktree, ".claude", "skills", "remove-me")
    await writeSkill(skillDir, "remove-me", "transient")

    const before = await withInstance(worktree, worktree, () => Skill.get("remove-me"))
    expect(before).toBeDefined()

    await fs.rm(skillDir, { recursive: true, force: true })

    const after = await withInstance(worktree, worktree, () => Skill.get("remove-me"))
    expect(after).toBeUndefined()
  })

  test("adding a new SKILL.md is detected on next call", async () => {
    const worktree = path.join(tmp.path, "project6")
    await fs.mkdir(worktree, { recursive: true })

    // First call — no skills
    const empty = await withInstance(worktree, worktree, () => Skill.all())
    expect(empty).toHaveLength(0)

    // Add a new skill externally
    await writeSkill(path.join(worktree, ".claude", "skills", "fresh"), "fresh", "brand-new")

    // Next call should detect the new file and load it
    const found = await withInstance(worktree, worktree, () => Skill.get("fresh"))
    expect(found?.description).toBe("brand-new")
  })
})
