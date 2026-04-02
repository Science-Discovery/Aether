import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { Installation } from "../../src/installation"
import { Database } from "../../src/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta"].includes(Installation.CHANNEL)
      ? path.join(Global.Path.data, "opencode.db")
      : path.join(Global.Path.data, `opencode-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
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
})
