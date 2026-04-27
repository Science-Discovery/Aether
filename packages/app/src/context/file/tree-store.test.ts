import { describe, expect, test } from "bun:test"
import { createFileTreeStore } from "./tree-store"

type Node = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

const dir = (path: string): Node => ({
  name: path.split("/").pop() || path,
  path,
  absolute: `/repo/${path}`,
  type: "directory",
  ignored: false,
})

const file = (path: string): Node => ({
  name: path.split("/").pop() || path,
  path,
  absolute: `/repo/${path}`,
  type: "file",
  ignored: false,
})

describe("file tree store refresh", () => {
  test("refreshes loaded descendants when refreshing root", async () => {
    const data = new Map<string, Node[]>([
      ["", [dir("docs"), file("README.md")]],
      ["docs", [file("docs/intro.md")]],
    ])

    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async (input) => data.get(input) ?? [],
      onError: () => {},
    })

    await tree.listDir("")
    await tree.listDir("docs")

    data.set("", [dir("docs"), file("README.md"), file("notes.md")])
    data.set("docs", [file("docs/intro.md"), file("docs/new.md")])

    await tree.refreshDir("")

    expect(tree.children("").map((item) => item.path)).toEqual(["docs", "README.md", "notes.md"])
    expect(tree.children("docs").map((item) => item.path)).toEqual(["docs/intro.md", "docs/new.md"])
  })

  test("reset restores the saved expanded dirs", () => {
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async () => [],
      onError: () => {},
      initialExpanded: new Set(["docs"]),
    })

    expect(tree.dirState("docs")?.expanded).toBe(true)

    tree.collapseDir("docs")
    expect(tree.dirState("docs")?.expanded).toBe(false)

    tree.reset(["docs", "src"])

    expect(tree.dirState("")?.expanded).toBe(true)
    expect(tree.dirState("docs")?.expanded).toBe(true)
    expect(tree.dirState("src")?.expanded).toBe(true)
  })

  test("reveal loads and expands ancestor dirs for a file path", async () => {
    const data = new Map<string, Node[]>([
      ["", [dir("docs")]],
      ["docs", [dir("docs/api")]],
      ["docs/api", [file("docs/api/spec.md")]],
    ])

    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async (input) => data.get(input) ?? [],
      onError: () => {},
    })

    await tree.revealPath("docs/api/spec.md")

    expect(tree.children("").map((item) => item.path)).toEqual(["docs"])
    expect(tree.children("docs").map((item) => item.path)).toEqual(["docs/api"])
    expect(tree.children("docs/api").map((item) => item.path)).toEqual(["docs/api/spec.md"])
    expect(tree.dirState("docs")?.expanded).toBe(true)
    expect(tree.dirState("docs/api")?.expanded).toBe(true)
  })
})
