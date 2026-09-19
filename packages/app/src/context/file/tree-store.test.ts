import { describe, expect, test } from "bun:test"
import { createFileTreeStore, type TreeSnapshot } from "./tree-store"
import type { FileNode } from "@opencode-ai/sdk/v2"

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
  test("collapseAll collapses every expanded directory except root", async () => {
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async () => [],
      onError: () => {},
      initialExpanded: new Set(["docs", "src/nested"]),
    })

    tree.collapseAll()

    expect(tree.dirState("")?.expanded).toBe(true)
    expect(tree.dirState("docs")?.expanded).toBe(false)
    expect(tree.dirState("src/nested")?.expanded).toBe(false)
  })
})

describe("tree snapshots", () => {
  const node = (path: string, type: "file" | "directory"): FileNode => ({
    name: path.split("/").pop() ?? path,
    path,
    absolute: `/repo/${path}`,
    type,
    ignored: false,
  })

  test("seeds from initialSnapshot without fetching and refetches on load", async () => {
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input,
      list: async () => {
        calls++
        return [node("README.md", "file")]
      },
      onError: () => {},
      initialSnapshot: {
        node: { docs: node("docs", "directory"), "docs/a.md": node("docs/a.md", "file") },
        dir: {
          "": { expanded: true, loaded: true, children: ["docs"] },
          docs: { expanded: true, loaded: true, children: ["docs/a.md"] },
        },
      },
    })

    expect(calls).toBe(0)
    expect(tree.children("").map((n) => n.path)).toEqual(["docs"])
    expect(tree.isLoaded("")).toBe(false)

    await tree.listDir("", { force: true })
    expect(calls).toBe(1)
    expect(tree.children("").map((n) => n.path)).toEqual(["README.md"])
    expect(tree.isLoaded("")).toBe(true)
  })

  test("writes sanitized snapshots through onSnapshot", async () => {
    const snapshots: TreeSnapshot[] = []
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input,
      list: async () => [node("a.md", "file")],
      onError: () => {},
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    })

    await tree.listDir("")

    expect(snapshots.length).toBeGreaterThan(0)
    const last = snapshots.at(-1)!
    expect(last.dir[""]?.loaded).toBe(true)
    expect(last.dir[""]?.children).toEqual(["a.md"])
    expect(last.node["a.md"]?.path).toBe("a.md")
  })
})
