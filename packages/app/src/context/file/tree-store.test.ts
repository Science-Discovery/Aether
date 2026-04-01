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

describe("file tree store force refresh", () => {
  test("force refresh starts a new request when an in-flight request exists", async () => {
    let callCount = 0
    const resolvers: Array<() => void> = []

    const data = new Map<string, Node[]>([
      ["", [file("a.txt")]],
    ])

    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async (input) => {
        callCount++
        await new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
        return data.get(input) ?? []
      },
      onError: () => {},
    })

    // Start an initial load (it will hang until we resolve it)
    const firstLoad = tree.listDir("")

    // Update data BEFORE the first request resolves
    data.set("", [file("a.txt"), file("b.txt")])

    // Start a force refresh while the first request is still in-flight
    const refreshPromise = tree.refreshDir("")

    // Force refresh should have started a NEW request (callCount should be 2),
    // not reused the in-flight one
    expect(callCount).toBe(2)

    // Resolve the first (stale) request
    resolvers[0]()

    // Resolve the second (fresh) request
    resolvers[1]()

    await Promise.all([firstLoad, refreshPromise])

    // Tree should reflect the latest data
    expect(tree.children("").map((item) => item.path)).toEqual(["a.txt", "b.txt"])
  })

  test("force refresh fetches fresh data after previous load completed", async () => {
    let callCount = 0
    const data = new Map<string, Node[]>([
      ["", [file("a.txt")]],
    ])

    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async (input) => {
        callCount++
        return data.get(input) ?? []
      },
      onError: () => {},
    })

    // Initial load completes
    await tree.listDir("")
    expect(tree.children("").map((i) => i.path)).toEqual(["a.txt"])

    // Data changes
    data.set("", [file("a.txt"), file("b.txt")])

    // Force refresh picks up new data
    await tree.refreshDir("")

    expect(callCount).toBe(2)
    expect(tree.children("").map((i) => i.path)).toEqual(["a.txt", "b.txt"])
  })
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
})
