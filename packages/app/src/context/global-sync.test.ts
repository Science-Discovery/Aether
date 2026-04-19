import { describe, expect, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadDescendantsForRoots, loadRootSessionsWithFallback } from "./global-sync/session-load"
import type { Session } from "@opencode-ai/sdk/v2/client"

const makeSession = (input: {
  id: string
  directory?: string
  parentID?: string
  archived?: boolean
}): Session =>
  ({
    id: input.id,
    slug: input.id,
    projectID: "project",
    directory: input.directory ?? "dir",
    parentID: input.parentID,
    title: input.id,
    version: "test",
    time: {
      created: 1,
      updated: 1,
      ...(input.archived ? { archived: 1 } : {}),
    },
  }) as Session

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("loadDescendantsForRoots", () => {
  test("loads descendants from tree payload for new branch-tree sessions", async () => {
    const root = makeSession({ id: "root" })
    const child = makeSession({ id: "child", parentID: "root" })
    const archivedChild = makeSession({ id: "child-archived", parentID: "root", archived: true })

    const treeCalls: string[] = []
    const childrenCalls: string[] = []

    const result = await loadDescendantsForRoots({
      directory: "dir",
      roots: [root],
      tree: async (query) => {
        treeCalls.push(query.sessionID)
        return {
          data: {
            kind: "tree",
            sessions: [root, child, archivedChild],
          },
        }
      },
      children: async (query) => {
        childrenCalls.push(query.sessionID)
        return { data: [] }
      },
    })

    expect(treeCalls).toEqual(["root"])
    expect(childrenCalls).toEqual([])
    expect(result.map((session) => session.id)).toEqual(["child"])
  })

  test("falls back to recursive children loading for legacy roots", async () => {
    const root = makeSession({ id: "legacy-root" })
    const child = makeSession({ id: "legacy-child", parentID: "legacy-root" })
    const grandchild = makeSession({ id: "legacy-grandchild", parentID: "legacy-child" })

    const childrenByParent: Record<string, Session[]> = {
      "legacy-root": [child],
      "legacy-child": [grandchild],
      "legacy-grandchild": [],
    }

    const result = await loadDescendantsForRoots({
      directory: "dir",
      roots: [root],
      tree: async () => ({ data: { kind: "legacy" } }),
      children: async (query) => ({ data: childrenByParent[query.sessionID] ?? [] }),
    })

    expect(result.map((session) => session.id)).toEqual(["legacy-child", "legacy-grandchild"])
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
