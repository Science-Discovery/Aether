import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { loadRootSessionsWithFallback, mergeSessions } from "./session-load"

const session = (id: string) => ({ id, title: id }) as Session
type Query = { directory: string; roots: true; limit?: number }

describe("mergeSessions", () => {
  test("keeps a detached root when an older root/tree request finishes and removes duplicate rows", () => {
    const child = { ...session("child"), parentID: "parent", treeID: "old", time: { created: 1, updated: 1 } }
    const root = { ...session("child"), treeID: "new", time: { created: 1, updated: 2 } }
    const parent = { ...session("parent"), time: { created: 1, updated: 1 } }
    const merged = mergeSessions([child, parent, child], [root, parent])
    expect(merged.map((session) => session.id)).toEqual(["child", "parent"])
    expect(merged[0]).toEqual(root)
    expect(merged.filter((session) => !session.parentID)).toHaveLength(2)
  })

  test("keeps newer API metadata and filters archived rows", () => {
    const old = { ...session("child"), parentID: "parent", time: { created: 1, updated: 1 } }
    const root = { ...session("child"), time: { created: 1, updated: 2 } }
    const archived = { ...session("archived"), time: { created: 1, updated: 3, archived: 3 } }
    expect(mergeSessions([root, archived], [old])).toEqual([root])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("returns limited result on first success", async () => {
    const calls: Query[] = []
    const result = await loadRootSessionsWithFallback({
      directory: "/tmp/project",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [session("s1")] }
      },
    })
    expect(calls).toEqual([{ directory: "/tmp/project", roots: true, limit: 10 }])
    expect(result).toEqual({ data: [session("s1")], limit: 10, limited: true })
  })

  test("recovers when the limited attempt fails transiently", async () => {
    const calls: Query[] = []
    let attempts = 0
    const result = await loadRootSessionsWithFallback({
      directory: "/tmp/project",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        attempts++
        if (attempts === 1) throw new TypeError("Failed to fetch")
        return { data: [session("s1")] }
      },
    })
    expect(calls).toEqual([
      { directory: "/tmp/project", roots: true, limit: 10 },
      { directory: "/tmp/project", roots: true },
    ])
    expect(result).toEqual({ data: [session("s1")], limit: 10, limited: false })
  })

  test("retries the whole round when both attempts fail transiently", async () => {
    let limitedAttempts = 0
    let plainAttempts = 0
    const result = await loadRootSessionsWithFallback({
      directory: "/tmp/project",
      limit: 10,
      list: async (query) => {
        if (query.limit !== undefined) {
          limitedAttempts++
          throw new TypeError("Failed to fetch")
        }
        plainAttempts++
        if (plainAttempts === 1) throw new TypeError("Failed to fetch")
        return { data: [session("s1")] }
      },
    })
    expect(limitedAttempts).toBe(2)
    expect(plainAttempts).toBe(2)
    expect(result).toEqual({ data: [session("s1")], limit: 10, limited: false })
  })

  test("does not retry non-transient errors", async () => {
    let attempts = 0
    const result = await loadRootSessionsWithFallback({
      directory: "/tmp/project",
      limit: 10,
      list: async (query) => {
        attempts++
        if (query.limit !== undefined) {
          throw Object.assign(new Error("bad request"), { name: "UnknownError", data: { message: "bad request" } })
        }
        return { data: [session("s1")] }
      },
    })
    expect(attempts).toBe(2)
    expect(result).toEqual({ data: [session("s1")], limit: 10, limited: false })
  })

  test("gives up after exhausting retries on persistent transient failure", async () => {
    let attempts = 0
    await expect(
      loadRootSessionsWithFallback({
        directory: "/tmp/project",
        limit: 10,
        list: async () => {
          attempts++
          throw new TypeError("Failed to fetch")
        },
      }),
    ).rejects.toThrow("Failed to fetch")
    expect(attempts).toBe(6)
  })
})
