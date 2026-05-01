import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { makeTimer } from "@solid-primitives/timer"

const GRACE_MS = 3000

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | undefined

export function createWorkingState(input: {
  status: () => SessionStatus
  pending: () => unknown
  blocked?: () => boolean
}) {
  const [grace, setGrace] = createSignal(false)

  createEffect(() => {
    const s = input.status()
    if (s?.type === "busy" || s?.type === "retry") {
      setGrace(true)
      return
    }
    if (grace()) {
      makeTimer(() => setGrace(false), GRACE_MS, setTimeout)
    }
  })

  const working = createMemo(() => {
    if (input.blocked?.()) return false
    const s = input.status()
    if (s?.type === "busy" || s?.type === "retry") return true
    if (grace()) return !!input.pending()
    return false
  })

  return { working, grace }
}
