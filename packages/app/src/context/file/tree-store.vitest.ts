import { describe, expect, test } from "vitest"
import { createFileTreeStore } from "./tree-store"
import type { FileNode } from "@opencode-ai/sdk/v2"

const node = (path: string): FileNode => ({
  name: path.split("/").pop() ?? path,
  path,
  absolute: `/repo/${path}`,
  type: "file",
  ignored: false,
})

type Gate = PromiseWithResolvers<void>

const deferredList = () => {
  const gates: Gate[] = []
  let version = 0
  return {
    gates,
    write: () => {
      version++
    },
    list: async (input: string) => {
      const gate = Promise.withResolvers<void>()
      const seen = version
      gates.push(gate)
      await gate.promise
      return [node(`${input ? `${input}/` : ""}v${seen}.md`)]
    },
  }
}

describe("file tree store forced refresh", () => {
  test("force refresh during in-flight fetch issues a second fetch and drops the stale one", async () => {
    const source = deferredList()
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input,
      list: source.list,
      onError: () => {},
    })

    const first = tree.listDir("")
    expect(source.gates.length).toBe(1)

    source.write()
    const forced = tree.listDir("", { force: true })

    expect(source.gates.length).toBe(2)
    expect(tree.dirState("")?.loading).toBe(true)

    source.gates[0].resolve()
    await first
    expect(tree.children("")).toEqual([])
    expect(tree.isLoaded("")).toBe(false)

    source.gates[1].resolve()
    await forced
    expect(tree.children("").map((n) => n.path)).toEqual(["v1.md"])
    expect(tree.isLoaded("")).toBe(true)
  })

  test("late stale response after a forced refresh does not overwrite fresh children", async () => {
    const source = deferredList()
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input,
      list: source.list,
      onError: () => {},
    })

    const first = tree.listDir("")
    source.write()
    const forced = tree.listDir("", { force: true })
    expect(source.gates.length).toBe(2)

    source.gates[1].resolve()
    await forced
    expect(tree.children("").map((n) => n.path)).toEqual(["v1.md"])

    source.gates[0].resolve()
    await first
    expect(tree.children("").map((n) => n.path)).toEqual(["v1.md"])
    expect(tree.dirState("")?.error).toBeUndefined()
  })

  test("stale failed response is swallowed while the superseding fetch succeeds", async () => {
    const errors: string[] = []
    const gates: Gate[] = []
    const tree = createFileTreeStore({
      scope: () => "/repo",
      normalizeDir: (input) => input,
      list: async (input: string) => {
        const gate = Promise.withResolvers<void>()
        const index = gates.length
        gates.push(gate)
        await gate.promise
        if (index === 0) throw new Error("stale boom")
        return [node(`${input ? `${input}/` : ""}ok.md`)]
      },
      onError: (message) => errors.push(message),
    })

    const first = tree.listDir("")
    const forced = tree.listDir("", { force: true })
    expect(gates.length).toBe(2)

    gates[0].resolve()
    await first
    gates[1].resolve()
    await forced

    expect(errors).toEqual([])
    expect(tree.dirState("")?.error).toBeUndefined()
    expect(tree.children("").map((n) => n.path)).toEqual(["ok.md"])
  })
})
