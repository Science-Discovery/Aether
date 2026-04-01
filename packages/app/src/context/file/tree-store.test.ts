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
  test("force refresh bypasses inflight cache when previous request is pending", async () => {
    let callCount = 0
    let resolveFirst: () => void
    const firstPending = new Promise<void>((r) => { resolveFirst = r })

    const data = new Map<string, Node[]>([
      ["", [file("README.md")]],
    ])

    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input.replace(/\/+$/, ""),
      list: async (input) => {
        callCount++
        if (callCount === 1) {
          await firstPending
        }
        return data.get(input) ?? []
      },
      onError: () => {},
    })

    // Start a listDir that hangs (never resolves until we want it to)
    const firstCall = tree.listDir("")
    // callCount should be 1 now
    expect(callCount).toBe(1)

    // Update underlying data while first request is still in-flight
    data.set("", [file("README.md"), file("notes.md")])

    // Call refreshDir which passes force=true — should start a NEW request
    // despite the first one still being in-flight
    const refreshPromise = tree.refreshDir("")

    // Allow the first request to resolve
    resolveFirst!()
    await firstCall
    await refreshPromise

    // callCount should be 2: the original + the force refresh
    expect(callCount).toBe(2)

    // The tree should reflect the NEW data
    expect(tree.children("").map((n) => n.path)).toEqual(["README.md", "notes.md"])
  })


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
