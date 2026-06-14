import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { Global } from "@/global"
import { Config } from "@/config/config"

// Isolation mirrors skill-priority.test.ts: override Global.Path.config/data to a
// temp dir and reset the lazy global config + instance state between tests so we
// never read the real ~/.config/opencode.
async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "skill-files-merge-test-"))
  return { path: p, cleanup: () => fs.rm(p, { recursive: true, force: true }) }
}

async function withInstance<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const project = {
    id: ProjectID.fromDirectory(directory),
    worktree: directory,
    sandboxes: [] as string[],
    time: { created: Date.now(), updated: Date.now() },
  }
  return Instance.provide({ directory, worktree: directory, project, fn: () => fn() })
}

describe("config/skills disabled_files layer merge", () => {
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

  test("disabled_files is the union of global and project layers, not project replacing global", async () => {
    const dir = path.join(tmp.path, "proj")
    await fs.mkdir(dir, { recursive: true })

    // Global layer disables A; project layer disables B. Correct semantics is a
    // union (both stay disabled), because these are sets of disabled paths.
    await fs.writeFile(
      path.join(Global.Path.config, "config.json"),
      JSON.stringify({ skills: { disabled_files: ["/abs/A/SKILL.md"] } }),
    )
    await fs.writeFile(
      path.join(dir, "aether.json"),
      JSON.stringify({ skills: { disabled_files: ["/abs/B/SKILL.md"] } }),
    )

    const merged = await withInstance(dir, () => Config.get())
    const files = merged.skills?.disabled_files ?? []
    expect(files).toContain("/abs/A/SKILL.md")
    expect(files).toContain("/abs/B/SKILL.md")
  })

  test("evolution_disabled_files is also a cross-layer union", async () => {
    const dir = path.join(tmp.path, "proj2")
    await fs.mkdir(dir, { recursive: true })

    await fs.writeFile(
      path.join(Global.Path.config, "config.json"),
      JSON.stringify({ skills: { evolution_disabled_files: ["/abs/G/SKILL.md"] } }),
    )
    await fs.writeFile(
      path.join(dir, "aether.json"),
      JSON.stringify({ skills: { evolution_disabled_files: ["/abs/P/SKILL.md"] } }),
    )

    const merged = await withInstance(dir, () => Config.get())
    const files = merged.skills?.evolution_disabled_files ?? []
    expect(files).toContain("/abs/G/SKILL.md")
    expect(files).toContain("/abs/P/SKILL.md")
  })

  test("union dedupes a path disabled in both layers", async () => {
    const dir = path.join(tmp.path, "proj3")
    await fs.mkdir(dir, { recursive: true })

    await fs.writeFile(
      path.join(Global.Path.config, "config.json"),
      JSON.stringify({ skills: { disabled_files: ["/abs/dup/SKILL.md", "/abs/A/SKILL.md"] } }),
    )
    await fs.writeFile(
      path.join(dir, "aether.json"),
      JSON.stringify({ skills: { disabled_files: ["/abs/dup/SKILL.md", "/abs/B/SKILL.md"] } }),
    )

    const merged = await withInstance(dir, () => Config.get())
    const files = merged.skills?.disabled_files ?? []
    expect(files.filter((f) => f === "/abs/dup/SKILL.md")).toHaveLength(1)
    expect(files).toContain("/abs/A/SKILL.md")
    expect(files).toContain("/abs/B/SKILL.md")
  })
})
