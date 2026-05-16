import { afterEach, describe, expect, test } from "bun:test"
import { WatcherHint } from "../../src/project/watcher-hint"
import { Filesystem } from "../../src/util/filesystem"

const dir = (value: string) => Filesystem.resolve(value)

describe("WatcherHint", () => {
  afterEach(() => {
    WatcherHint.clear()
  })

  test("derives watched directories from expanded dirs and open file parents", () => {
    WatcherHint.set("a", {
      directory: "/tmp/app",
      files: ["src/main.ts", "README.md"],
      dirs: ["src/components", "docs"],
    })

    expect(WatcherHint.get("a")).toEqual({
      directory: dir("/tmp/app"),
      files: ["README.md", "src/main.ts"],
      dirs: ["docs", "src/components"],
      watched: [dir("/tmp/app"), dir("/tmp/app/docs"), dir("/tmp/app/src"), dir("/tmp/app/src/components")],
    })
  })

  test("keeps the root directory when the hint explicitly opens it", () => {
    WatcherHint.set("a", {
      directory: "/tmp/app",
      files: [],
      dirs: [""],
    })

    expect(WatcherHint.get("a")).toEqual({
      directory: dir("/tmp/app"),
      files: [],
      dirs: [""],
      watched: [dir("/tmp/app")],
    })
  })

  test("merges watched directories across leases in the same workspace", () => {
    WatcherHint.set("a", {
      directory: "/tmp/app",
      files: ["src/main.ts"],
      dirs: ["src/components"],
    })
    WatcherHint.set("b", {
      directory: "/tmp/app",
      files: ["test/main.test.ts"],
      dirs: ["docs"],
    })
    WatcherHint.set("c", {
      directory: "/tmp/other",
      files: ["src/other.ts"],
      dirs: ["src"],
    })

    expect(WatcherHint.watch("/tmp/app")).toEqual([
      dir("/tmp/app/docs"),
      dir("/tmp/app/src"),
      dir("/tmp/app/src/components"),
      dir("/tmp/app/test"),
    ])
  })

  test("touch keeps the last snapshot and drop removes the lease", () => {
    WatcherHint.set("a", {
      directory: "/tmp/app",
      files: ["src/main.ts"],
      dirs: [],
    })

    expect(WatcherHint.touch("a")).toEqual([dir("/tmp/app/src")])
    WatcherHint.drop("a")
    expect(WatcherHint.get("a")).toBeUndefined()
    expect(WatcherHint.watch("/tmp/app")).toEqual([])
  })
})
