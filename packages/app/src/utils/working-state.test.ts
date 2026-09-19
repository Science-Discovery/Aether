import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createWorkingState } from "./working-state"

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
