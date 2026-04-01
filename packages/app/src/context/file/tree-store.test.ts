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

  test("force refresh returns fresh data when an inflight request already exists", async () => {
    let resolveInitial: () => void
    const initialPromise = new Promise<void>((r) => { resolveInitial = r })

    const data = new Map<string, Node[]>([
      ["", [dir("src"), file("a.ts")]],
    ])

    let listCount = 0
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async (input) => {
        listCount++
        if (listCount === 1) {
          // First request reads stale data and hangs
          await initialPromise
          return [{ name: "src", path: "src", absolute: "/repo/src", type: "directory" as const, ignored: false }]
        }
        // Subsequent requests read current data
        return data.get(input) ?? []
      },
      onError: () => {},
    })

    // Start the first list request (returns stale data, hangs)
    const first = tree.listDir("")

    // Change the underlying data before the first request completes
    data.set("", [dir("src"), file("a.ts"), file("b.ts")])

    // Force refresh while the first request is still inflight.
    // This should fetch fresh data, not return the stale inflight promise.
    const refresh = tree.refreshDir("")

    // Let the initial request complete with stale data
    resolveInitial!()

    // Wait for both to complete
    await Promise.all([first, refresh])

    // The tree should reflect the fresh data (b.ts included)
    expect(tree.children("").map((n) => n.path)).toEqual(["src", "a.ts", "b.ts"])
  })
})
