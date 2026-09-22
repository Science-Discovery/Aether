import { describe, expect, test } from "bun:test"
import { createInflight } from "./inflight"

describe("inflight", () => {
  test("non-force joins the pending promise, force does not", () => {
    const inflight = createInflight()
    const gate = Promise.withResolvers<void>()
    inflight.attach("a", gate.promise)

    expect(inflight.held("a")).toBe(gate.promise)
    expect(inflight.held("a", false)).toBe(gate.promise)
    expect(inflight.held("a", true)).toBeUndefined()
  })

  test("force claim supersedes the previous one", () => {
    const inflight = createInflight()
    const stale = inflight.claim("a")

    expect(inflight.fresh("a", stale)).toBe(true)

    const next = inflight.claim("a")
    expect(next).not.toBe(stale)
    expect(inflight.fresh("a", stale)).toBe(false)
    expect(inflight.fresh("a", next)).toBe(true)
  })

  test("detach removes only its own promise", () => {
    const inflight = createInflight()
    const first = Promise.resolve()
    const second = Promise.resolve()
    inflight.attach("a", first)
    inflight.attach("a", second)

    inflight.detach("a", first)
    expect(inflight.held("a")).toBe(second)

    inflight.detach("a", second)
    expect(inflight.held("a")).toBeUndefined()
  })

  test("reset clears pending promises and claims", () => {
    const inflight = createInflight()
    const id = inflight.claim("a")
    inflight.attach("a", Promise.resolve())

    inflight.reset()

    expect(inflight.held("a")).toBeUndefined()
    expect(inflight.fresh("a", id)).toBe(false)
  })
})
