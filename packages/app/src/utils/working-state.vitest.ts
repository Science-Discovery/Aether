import { describe, expect, test } from "vitest"
import { createRoot } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { dropSessionCaches } from "../context/global-sync/session-cache"
import { createWorkingState } from "@/utils/working-state"

const streaming = () =>
  ({
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1 },
  }) as Message

function createState() {
  return createStore({
    session_status: { ses_1: { type: "busy" } as SessionStatus },
    message: { ses_1: [streaming()] },
    session_diff: {},
    todo: {},
    part: {},
    permission: {},
    question: {},
  })
}

function createWorking(store: ReturnType<typeof createState>[0]) {
  return createWorkingState({
    status: () => store.session_status["ses_1"],
    pending: () =>
      (store.message["ses_1"] ?? []).findLast(
        (message) => message.role === "assistant" && typeof message.time?.completed !== "number",
      ),
  }).interactive
}

describe("working state reactivity", () => {
  test("busy session stays working after message cache eviction", () => {
    createRoot((dispose) => {
      const [store, setStore] = createState()
      const working = createWorking(store)
      expect(working()).toBe(true)

      setStore(
        produce((draft) => {
          dropSessionCaches(draft, ["ses_1"])
        }),
      )
      expect(store.message["ses_1"]).toBeUndefined()
      expect(store.session_status["ses_1"]).toEqual({ type: "busy" })
      expect(working()).toBe(true)
      dispose()
    })
  })

  test("session stops working only after both status and streaming message settle", () => {
    createRoot((dispose) => {
      const [store, setStore] = createState()
      const working = createWorking(store)
      expect(working()).toBe(true)

      setStore("session_status", "ses_1", reconcile({ type: "idle" }))
      expect(working()).toBe(true)

      setStore("message", "ses_1", reconcile([{ ...streaming(), time: { created: 1, completed: 2 } }], { key: "id" }))
      expect(working()).toBe(false)

      setStore("session_status", "ses_1", reconcile({ type: "busy" }))
      expect(working()).toBe(true)
      dispose()
    })
  })
})
