import { afterEach, describe, expect, test, vi } from "bun:test"
import { createRefreshQueue } from "./refresh-queue"

describe("refresh queue", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("deduplicates dirs in one debounce window", () => {
    vi.useFakeTimers()
    const calls: string[][] = []
    const queue = createRefreshQueue((dirs) => calls.push(dirs), 150)

    queue.push("src")
    queue.push("src")
    queue.push("src/lib")
    vi.advanceTimersByTime(149)
    expect(calls).toEqual([])

    vi.advanceTimersByTime(1)
    expect(calls).toEqual([["src", "src/lib"]])
  })

  test("batches later pushes into next flush", () => {
    vi.useFakeTimers()
    const calls: string[][] = []
    const queue = createRefreshQueue((dirs) => calls.push(dirs), 150)

    queue.push("src")
    vi.advanceTimersByTime(150)
    queue.push("docs")
    vi.advanceTimersByTime(150)

    expect(calls).toEqual([["src"], ["docs"]])
  })

  test("stop clears pending flush", () => {
    vi.useFakeTimers()
    const calls: string[][] = []
    const queue = createRefreshQueue((dirs) => calls.push(dirs), 150)

    queue.push("src")
    queue.stop()
    vi.advanceTimersByTime(300)

    expect(calls).toEqual([])
  })
})
