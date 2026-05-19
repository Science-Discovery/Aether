import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { PROJECT } from "../../src/persist/naming"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util/log"
import path from "path"

Log.init({ print: false })

describe("InstanceBootstrap creates .aether directory", () => {
  test("creates .aether in the opened directory, not git root", async () => {
    await using tmp = await tmpdir({ git: true })

    const aetherDir = path.join(tmp.path, PROJECT)
    expect(await fs.stat(aetherDir).catch(() => null)).toBeNull()

    await Instance.provide({ directory: tmp.path, init: InstanceBootstrap, fn: async () => {} })

    expect(await fs.stat(aetherDir).then(() => true).catch(() => false)).toBe(true)
  })

  test("creates .aether in git subdirectory without leaking to git root", async () => {
    await using tmp = await tmpdir({ git: true, init: async (dir) => {
      const sub = path.join(dir, "packages", "my-pkg")
      await fs.mkdir(sub, { recursive: true })
      return sub
    }})

    const subAether = path.join(tmp.extra, PROJECT)
    const rootAether = path.join(tmp.path, PROJECT)
    expect(await fs.stat(subAether).catch(() => null)).toBeNull()
    expect(await fs.stat(rootAether).catch(() => null)).toBeNull()

    await Instance.provide({ directory: tmp.extra, init: InstanceBootstrap, fn: async () => {} })

    expect(await fs.stat(subAether).then(() => true).catch(() => false)).toBe(true)
    expect(await fs.stat(rootAether).then(() => true).catch(() => false)).toBe(false)
  })

  test("creates .aether in non-git directory", async () => {
    await using tmp = await tmpdir()

    const aetherDir = path.join(tmp.path, PROJECT)
    expect(await fs.stat(aetherDir).catch(() => null)).toBeNull()

    await Instance.provide({ directory: tmp.path, init: InstanceBootstrap, fn: async () => {} })

    expect(await fs.stat(aetherDir).then(() => true).catch(() => false)).toBe(true)
  })

  test("does not fail when .aether already exists", async () => {
    await using tmp = await tmpdir({ git: true })

    const aetherDir = path.join(tmp.path, PROJECT)
    await fs.mkdir(aetherDir, { recursive: true })
    expect(await fs.stat(aetherDir).then(() => true).catch(() => false)).toBe(true)

    await Instance.provide({ directory: tmp.path, init: InstanceBootstrap, fn: async () => {} })

    expect(await fs.stat(aetherDir).then(() => true).catch(() => false)).toBe(true)
  })
})