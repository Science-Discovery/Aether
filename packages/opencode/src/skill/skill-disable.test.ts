import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { Skill } from "./index"
import { Global } from "@/global"
import { Config } from "@/config/config"

// Isolation copied verbatim from skill-priority.test.ts: the loader reads
// Global.Path.home = OPENCODE_TEST_HOME || os.homedir(), so we must set the env
// var (not HOME), and override Global.Path.config/data + reset the lazy global
// config so we never touch the real ~/.config or ~/.claude.
async function writeSkill(dir: string, name: string, description: string) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nSkill content.\n`,
  )
}

async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "skill-disable-test-"))
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

describe("skill/loadSkills disable by file path", () => {
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

  test("a skill whose SKILL.md path is in disabled_files is not loaded; others still load", async () => {
    const worktree = path.join(tmp.path, "proj")
    await fs.mkdir(worktree, { recursive: true })

    const fooDir = path.join(worktree, ".aether", "skills", "foo")
    await writeSkill(fooDir, "foo", "the foo skill")
    await writeSkill(path.join(worktree, ".aether", "skills", "bar"), "bar", "the bar skill")

    // Disable foo by its absolute SKILL.md path via the project config (aether.json,
    // the filename the layered loader actually reads).
    await fs.writeFile(
      path.join(worktree, "aether.json"),
      JSON.stringify({ skills: { disabled_files: [path.join(fooDir, "SKILL.md")] } }),
    )

    const names = await withInstance(worktree, worktree, async () =>
      (await Skill.all()).map((s) => s.name),
    )
    expect(names).not.toContain("foo")
    expect(names).toContain("bar")
  })

  test("disabled_files still matches when the worktree path contains a symlink", async () => {
    // Cross-platform regression: the skill scan canonicalizes its directory via
    // Filesystem.resolve (realpath, which collapses symlinks), so skill.location
    // is symlink-resolved. disabled_files matching must canonicalize the same way,
    // or the two paths for the same file diverge. On macOS /var -> /private/var
    // (and Windows casing) trigger this; here we force the same divergence with an
    // explicit symlink so it reproduces on Linux too.
    const realRoot = path.join(tmp.path, "real")
    await fs.mkdir(realRoot, { recursive: true })
    const linkRoot = path.join(tmp.path, "link")
    await fs.symlink(realRoot, linkRoot)

    // worktree path goes THROUGH the symlink; files land under realRoot.
    const worktree = path.join(linkRoot, "proj")
    const fooDir = path.join(worktree, ".aether", "skills", "foo")
    await writeSkill(fooDir, "foo", "the foo skill")
    await writeSkill(path.join(worktree, ".aether", "skills", "bar"), "bar", "the bar skill")

    // disabled_files records the un-resolved (symlink) path — as a real config would.
    await fs.writeFile(
      path.join(worktree, "aether.json"),
      JSON.stringify({ skills: { disabled_files: [path.join(fooDir, "SKILL.md")] } }),
    )

    const names = await withInstance(worktree, worktree, async () =>
      (await Skill.all()).map((s) => s.name),
    )
    expect(names).not.toContain("foo")
    expect(names).toContain("bar")
  })

  test("disabling by path only matches that exact path — a same-named skill elsewhere survives", async () => {
    const worktree = path.join(tmp.path, "proj2")
    const inner = path.join(worktree, "pkg")
    await fs.mkdir(inner, { recursive: true })

    // Two skills named "build": outer (worktree) and inner (pkg). Disable only the
    // outer one by its path. The inner one wins priority anyway, but the point of
    // this test is that the disable is path-precise, not name-based.
    const outerDir = path.join(worktree, ".aether", "skills", "build")
    const innerDir = path.join(inner, ".aether", "skills", "build")
    await writeSkill(outerDir, "build", "outer build")
    await writeSkill(innerDir, "build", "inner build")

    await fs.writeFile(
      path.join(worktree, "aether.json"),
      JSON.stringify({ skills: { disabled_files: [path.join(outerDir, "SKILL.md")] } }),
    )

    // Disabling the outer path must NOT remove the (differently-pathed) inner skill.
    const build = await withInstance(inner, worktree, () => Skill.get("build"))
    expect(build?.description).toBe("inner build")
  })

  test("no disabled_files configured loads every skill (default = all on)", async () => {
    const worktree = path.join(tmp.path, "proj3")
    await fs.mkdir(worktree, { recursive: true })
    await writeSkill(path.join(worktree, ".aether", "skills", "keep"), "keep", "keep me")

    const names = await withInstance(worktree, worktree, async () =>
      (await Skill.all()).map((s) => s.name),
    )
    expect(names).toContain("keep")
  })
})
