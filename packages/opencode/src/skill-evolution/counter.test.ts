import { describe, expect, test } from "bun:test"
import { Counter } from "./counter"

describe("Counter", () => {
  test("starts at zero for unknown session", () => {
    const id = "session-zero-" + Math.random()
    expect(Counter.get(id)).toBe(0)
  })

  test("increment increases count by one each call", () => {
    const id = "session-inc-" + Math.random()
    Counter.increment(id)
    Counter.increment(id)
    Counter.increment(id)
    expect(Counter.get(id)).toBe(3)
  })

  test("getAndReset returns current value and resets to zero", () => {
    const id = "session-reset-" + Math.random()
    Counter.increment(id)
    Counter.increment(id)
    const val = Counter.getAndReset(id)
    expect(val).toBe(2)
    expect(Counter.get(id)).toBe(0)
  })

  test("reset removes counter entry", () => {
    const id = "session-del-" + Math.random()
    Counter.increment(id)
    Counter.reset(id)
    expect(Counter.get(id)).toBe(0)
  })

  test("different sessions are tracked independently", () => {
    const a = "session-a-" + Math.random()
    const b = "session-b-" + Math.random()
    Counter.increment(a)
    Counter.increment(a)
    Counter.increment(b)
    expect(Counter.get(a)).toBe(2)
    expect(Counter.get(b)).toBe(1)
    Counter.reset(a)
    Counter.reset(b)
  })

  test("getAndReset on unknown session returns 0", () => {
    const id = "session-empty-" + Math.random()
    expect(Counter.getAndReset(id)).toBe(0)
  })
})
