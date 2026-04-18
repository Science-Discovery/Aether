import { describe, expect, test } from "bun:test"
import fs from "fs"
import { rm } from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "../../src/global"
import { Installation } from "../../src/installation"
import { init } from "../../src/storage/db.bun"
import { Database } from "../../src/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta"].includes(Installation.CHANNEL)
      ? path.join(Global.Path.data, "aether.db")
      : path.join(Global.Path.data, `aether-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })

  test("currentPath matches the active database path", () => {
    expect(Database.currentPath()).toBe(Database.Path)
  })

  test("withSources always yields the active database first", () => {
    const list = Database.withSources((source) => ({
      path: source.path,
      current: source.current,
    }))
    expect(list.length).toBeGreaterThan(0)
    expect(list[0]).toEqual({
      path: Database.currentPath(),
      current: true,
    })
  })

  test("knownPaths only returns aether databases", async () => {
    const one = path.join(Global.Path.data, "aether.db")
    const two = path.join(Global.Path.data, "aether-local.db")
    const old = path.join(Global.Path.data, "opencode.db")
    await Promise.all([Bun.write(one, ""), Bun.write(two, ""), Bun.write(old, "")])
    try {
      const list = Database.knownPaths()
      expect(list.includes(one)).toBeTrue()
      expect(list.includes(two)).toBeTrue()
      expect(list.includes(old)).toBeFalse()
      expect(list.every((file) => /^aether.*\.db$/i.test(path.basename(file)))).toBeTrue()
    } finally {
      await Promise.all([rm(one, { force: true }), rm(two, { force: true }), rm(old, { force: true })])
    }
  })

  test("init creates parent dir for file databases", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aether-db-"))
    const file = path.join(root, "deep", "aether.db")
    try {
      const db = init(file)
      db.$client.close()
      expect(await Bun.file(file).exists()).toBeTrue()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
