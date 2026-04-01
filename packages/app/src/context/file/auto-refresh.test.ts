import { describe, expect, test } from "bun:test"
import { createAutoRefresh } from "./auto-refresh"

describe("file tree auto-refresh", () => {
  test("calls refreshDir at the specified interval", async () => {
    const refreshCalls: string[] = []
    let now = 0
    const settled = Promise.withResolvers<void>()

    const { start, stop } = createAutoRefresh({
      intervalMs: 100,
      refreshDir: (dir: string) => {
        refreshCalls.push(dir)
        if (refreshCalls.length >= 3) settled.resolve()
      },
      getNow: () => now,
    })

    start()

    // Simulate time advancing: advance past interval boundaries
    // The auto-refresh uses setInterval, so we need real time to pass
    await settled.promise
    stop()

    expect(refreshCalls.length).toBeGreaterThanOrEqual(3)
    // Every call should refresh root
    for (const call of refreshCalls) {
      expect(call).toBe("")
    }
  })

  test("does not refresh before start is called", async () => {
    const refreshCalls: string[] = []

    const { start, stop } = createAutoRefresh({
      intervalMs: 50,
      refreshDir: (dir: string) => {
        refreshCalls.push(dir)
      },
    })

    // Wait some time without calling start
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(refreshCalls.length).toBe(0)
    stop()
  })

  test("stops refreshing after stop is called", async () => {
    const refreshCalls: string[] = []
    const firstRefresh = Promise.withResolvers<void>()

    const { start, stop } = createAutoRefresh({
      intervalMs: 30,
      refreshDir: (dir: string) => {
        refreshCalls.push(dir)
        if (refreshCalls.length === 1) firstRefresh.resolve()
      },
    })

    start()
    await firstRefresh.promise

    const countAfterFirst = refreshCalls.length
    stop()

    await new Promise((resolve) => setTimeout(resolve, 150))

    // Should not have grown significantly after stop
    expect(refreshCalls.length).toBeLessThanOrEqual(countAfterFirst + 1)
  })

  test("handles refreshDir errors gracefully", async () => {
    const refreshCalls: string[] = []
    const secondRefresh = Promise.withResolvers<void>()

    const { start, stop } = createAutoRefresh({
      intervalMs: 30,
      refreshDir: (dir: string) => {
        refreshCalls.push(dir)
        if (refreshCalls.length === 1) throw new Error("network error")
        if (refreshCalls.length === 2) secondRefresh.resolve()
      },
    })

    start()
    await secondRefresh.promise
    stop()

    // Should have continued refreshing despite errors
    expect(refreshCalls.length).toBeGreaterThanOrEqual(2)
  })
})
