import { describe, expect, test } from "bun:test"
import { createReconnectTracker } from "./reconnect"

describe("createReconnectTracker", () => {
  test("fire calls hooks in order and bumps count", () => {
    const tracker = createReconnectTracker()
    const calls: string[] = []

    expect(tracker.count).toBe(0)
    tracker.listen(() => calls.push("first"))
    tracker.listen(() => calls.push("second"))

    tracker.fire()
    tracker.fire()

    expect(calls).toEqual(["first", "second", "first", "second"])
    expect(tracker.count).toBe(2)
  })

  test("unsubscribe removes the hook", () => {
    const tracker = createReconnectTracker()
    let calls = 0

    const unsub = tracker.listen(() => {
      calls++
    })
    tracker.fire()
    unsub()
    tracker.fire()

    expect(calls).toBe(1)
    expect(tracker.count).toBe(2)
  })

  test("fires with no hooks registered", () => {
    const tracker = createReconnectTracker()
    tracker.fire()
    expect(tracker.count).toBe(1)
  })
})
