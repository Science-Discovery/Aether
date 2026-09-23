import { describe, expect, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessionsWithFallback, planSessionLoad } from "./global-sync/session-load"

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

describe("planSessionLoad", () => {
  test("fetches on first load without a recorded cap", () => {
    expect(planSessionLoad(undefined, 5)).toBe("fetch")
  })

  test("fetches when the requested limit exceeds the recorded cap", () => {
    expect(planSessionLoad({ limit: 5 }, 15)).toBe("fetch")
  })

  test("trims from cache when the recorded cap covers the request", () => {
    expect(planSessionLoad({ limit: 15 }, 15)).toBe("trim")
    expect(planSessionLoad({ limit: 15 }, 10)).toBe("trim")
  })

  test("collapse must lower the cap so a later load-more refetches", () => {
    // collapse-all: limit 15 -> 5 while the cache was fetched up to 15
    expect(planSessionLoad({ limit: 15 }, 5)).toBe("trim")
    // with the cap re-recorded to 5 after trimming, the next load-more (15)
    // refetches instead of trimming the already-smaller 5-session cache
    expect(planSessionLoad({ limit: 5 }, 15)).toBe("fetch")
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
