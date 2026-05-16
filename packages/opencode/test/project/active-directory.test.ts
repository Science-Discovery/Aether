import { afterEach, describe, expect, test } from "bun:test"
import { ActiveDirectory } from "../../src/project/active-directory"
import { Filesystem } from "../../src/util/filesystem"

const dir = (value: string) => Filesystem.resolve(value)

describe("ActiveDirectory", () => {
  afterEach(() => {
    ActiveDirectory.clear()
  })

  test("keeps the most recently touched lease active", () => {
    ActiveDirectory.set("a", "/tmp/a")
    expect(ActiveDirectory.get()).toBe(dir("/tmp/a"))

    ActiveDirectory.set("b", "/tmp/b")
    expect(ActiveDirectory.get()).toBe(dir("/tmp/b"))

    ActiveDirectory.touch("a")
    expect(ActiveDirectory.get()).toBe(dir("/tmp/a"))
  })

  test("falls back when the newest lease is dropped", () => {
    ActiveDirectory.set("a", "/tmp/a")
    ActiveDirectory.set("b", "/tmp/b")
    expect(ActiveDirectory.get()).toBe(dir("/tmp/b"))

    ActiveDirectory.drop("b")
    expect(ActiveDirectory.get()).toBe(dir("/tmp/a"))

    ActiveDirectory.drop("a")
    expect(ActiveDirectory.get()).toBeUndefined()
  })

  test("tracks multiple leased directories at once", () => {
    ActiveDirectory.set("a", "/tmp/a")
    ActiveDirectory.set("b", "/tmp/b")

    expect(ActiveDirectory.has("/tmp/a")).toBe(true)
    expect(ActiveDirectory.has("/tmp/b")).toBe(true)
    expect(ActiveDirectory.count("/tmp/a")).toBe(1)
    expect(ActiveDirectory.count("/tmp/b")).toBe(1)
    expect(ActiveDirectory.list().sort()).toEqual([dir("/tmp/a"), dir("/tmp/b")].sort())
  })

  test("moves a lease between directories", () => {
    ActiveDirectory.set("a", "/tmp/a")
    ActiveDirectory.set("a", "/tmp/b")

    expect(ActiveDirectory.has("/tmp/a")).toBe(false)
    expect(ActiveDirectory.has("/tmp/b")).toBe(true)
    expect(ActiveDirectory.count("/tmp/b")).toBe(1)
  })
})
