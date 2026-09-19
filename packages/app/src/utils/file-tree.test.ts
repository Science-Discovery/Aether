import { describe, expect, test } from "bun:test"
import { affectedTabs, parentDir } from "./file-tree"

const pathFromTab = (tab: string) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined)

describe("parentDir", () => {
  test("returns the posix parent", () => {
    expect(parentDir("packages/app/src/entry.tsx")).toBe("packages/app/src")
    expect(parentDir("packages/app")).toBe("packages")
  })

  test("returns the windows parent", () => {
    expect(parentDir("packages\\app\\src\\entry.tsx")).toBe("packages\\app\\src")
    expect(parentDir("packages\\app")).toBe("packages")
  })

  test("returns empty for root-level paths", () => {
    expect(parentDir("README.md")).toBe("")
    expect(parentDir("C:\\README.md")).toBe("C:")
  })
})

describe("affectedTabs", () => {
  const tabs = ["file://src/a.ts", "file://src/deep/b.ts", "file://README.md", "review", "file://"]

  test("matches only the exact file", () => {
    expect(affectedTabs(tabs, pathFromTab, { path: "src/a.ts", type: "file" })).toEqual(["file://src/a.ts"])
  })

  test("matches a directory and its nested files with either separator", () => {
    expect(affectedTabs(tabs, pathFromTab, { path: "src", type: "directory" })).toEqual([
      "file://src/a.ts",
      "file://src/deep/b.ts",
    ])
    expect(affectedTabs(["file://src\\b.ts"], pathFromTab, { path: "src", type: "directory" })).toEqual([
      "file://src\\b.ts",
    ])
  })

  test("does not match sibling prefixes", () => {
    expect(affectedTabs(["file://src-other/c.ts"], pathFromTab, { path: "src", type: "directory" })).toEqual([])
  })

  test("skips tabs without a file path", () => {
    expect(affectedTabs(tabs, pathFromTab, { path: "review", type: "file" })).toEqual([])
  })
})
