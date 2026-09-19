import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createWorkingState, isWorking } from "./working-state"

describe("isWorking", () => {
  test("busy when any session is busy or retrying", () => {
    expect(isWorking({ session_status: { a: { type: "idle" }, b: { type: "busy" } } })).toBe(true)
    expect(isWorking({ session_status: { a: { type: "retry", attempt: 1, message: "", next: 0 } } })).toBe(true)
  })

  test("idle when no session is busy", () => {
    expect(isWorking({ session_status: { a: { type: "idle" }, b: { type: "idle" } } })).toBe(false)
    expect(isWorking({ session_status: {} })).toBe(false)
  })

  test("stale incomplete assistant message does not imply busy", () => {
    const store = {
      session_status: { a: { type: "idle" as const } },
      message: { a: [{ role: "assistant", time: {} }] },
    }
    expect(isWorking(store as Parameters<typeof isWorking>[0])).toBe(false)
  })
})

describe("working state", () => {
  test("busy status is working without cached messages", () => {
    createRoot((dispose) => {
      const [status] = createSignal({ type: "busy" as const })
      const working = createWorkingState({ status, pending: () => undefined }).interactive
      expect(working()).toBe(true)
      dispose()
    })
  })

  test("retry status is working without cached messages", () => {
    createRoot((dispose) => {
      const [status] = createSignal({ type: "retry" as const, attempt: 1, message: "", next: 0 })
      const working = createWorkingState({ status, pending: () => undefined }).interactive
      expect(working()).toBe(true)
      dispose()
    })
  })

  test("idle without pending messages is not working", () => {
    createRoot((dispose) => {
      const [status] = createSignal({ type: "idle" as const })
      const working = createWorkingState({ status, pending: () => undefined }).interactive
      expect(working()).toBe(false)
      dispose()
    })
  })

  test("pending assistant message implies working when status is idle", () => {
    createRoot((dispose) => {
      const [status] = createSignal({ type: "idle" as const })
      const [pending] = createSignal({ role: "assistant", time: {} })
      const working = createWorkingState({ status, pending }).interactive
      expect(working()).toBe(true)
      dispose()
    })
  })

  test("busy child session implies parent working", () => {
    createRoot((dispose) => {
      const [status] = createSignal(undefined)
      const working = createWorkingState({
        status,
        pending: () => undefined,
        sessionID: () => "ses_root",
        children: () => ({
          childMap: () => new Map([["ses_root", ["ses_child"]]]),
          status: (id: string) => (id === "ses_child" ? { type: "busy" as const } : undefined),
          pending: () => undefined,
        }),
      }).interactive
      expect(working()).toBe(true)
      dispose()
    })
  })
})
