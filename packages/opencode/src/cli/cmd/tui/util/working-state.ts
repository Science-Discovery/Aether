import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"

const GRACE_MS = 3000

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | undefined

export function createWorkingState(input: { status: () => SessionStatus; pending: () => unknown }) {
  const [grace, setGrace] = createSignal(false)

  createEffect(() => {
    const s = input.status()
    if (s?.type === "busy" || s?.type === "retry") {
      setGrace(true)
      return
    }
    if (grace()) {
      const timer = setTimeout(() => setGrace(false), GRACE_MS)
      onCleanup(() => clearTimeout(timer))
    }
  })

  const working = createMemo(() => {
    const s = input.status()
    if (s?.type === "busy" || s?.type === "retry") return true
    if (grace()) return !!input.pending()
    return false
  })

  return { working }
}
