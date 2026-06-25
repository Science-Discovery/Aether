import { describe, expect, test, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { ConfigPaths } from "../../src/config/paths"
import { Global } from "../../src/global"
import { PROJECT } from "../../src/persist/naming"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await fs.rm(path.join(Global.Path.home, PROJECT), { recursive: true, force: true }).catch(() => {})
})

describe("ConfigPaths.directories — search order", () => {
  test("directory order: global config → home dirs → binary dirs → project dirs → config dir", async () => {
    const cwd = process.cwd()
    const dirs = await ConfigPaths.directories(cwd, cwd)

    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs[0]).toContain("aether")
  })

  test("project dirs appear after home dirs (reordered priority)", async () => {
    // Seed .aether under the (isolated, per-process test) home dir so a home
    // root is actually present, then a real project .aether so the project
    // root is found. Without both, the ordering assertion is a silent no-op.
    const home = path.join(Global.Path.home, PROJECT)
    await fs.mkdir(home, { recursive: true })
    await using tmp = await tmpdir({
      init: async (d) => {
        await fs.mkdir(path.join(d, PROJECT), { recursive: true })
      },
    })

    const dirs = await ConfigPaths.directories(tmp.path, tmp.path)
    const homeIdx = dirs.findIndex((d) => d === home)
    const projectIdx = dirs.findIndex((d) => d === path.join(tmp.path, PROJECT))

    expect(homeIdx).toBeGreaterThanOrEqual(0)
    expect(projectIdx).toBeGreaterThanOrEqual(0)
    expect(homeIdx).toBeLessThan(projectIdx)
  })

  test("Global.Path.config is always first", async () => {
    const cwd = process.cwd()
    const dirs = await ConfigPaths.directories(cwd, cwd)
    expect(dirs[0]).toBe(Global.Path.config)
  })

  test("no duplicate directories in result", async () => {
    const cwd = process.cwd()
    const dirs = await ConfigPaths.directories(cwd, cwd)
    expect(new Set(dirs).size).toBe(dirs.length)
  })
})
