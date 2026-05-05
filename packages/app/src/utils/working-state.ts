import { createEffect, createMemo, createSignal } from "solid-js"
import { makeTimer } from "@solid-primitives/timer"

const GRACE_MS = 3000

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | undefined

export type ChildrenSource = {
  childMap: () => Map<string, string[]>
  status: (id: string) => SessionStatus
}

const isBusy = (s: SessionStatus) => s?.type === "busy" || s?.type === "retry"

function descendantBusy(sessionID: string, source: ChildrenSource): boolean {
  const children = source.childMap().get(sessionID)
  if (!children?.length) return false
  for (const id of children) {
    if (isBusy(source.status(id))) return true
    if (descendantBusy(id, source)) return true
  }
  return false
}

export function createWorkingState(input: {
  status: () => SessionStatus
  pending: () => unknown
  blocked?: () => boolean
  sessionID?: () => string | undefined
  children?: () => ChildrenSource
}) {
  const [grace, setGrace] = createSignal(false)

  createEffect(() => {
    const s = input.status()
    if (isBusy(s)) {
      setGrace(true)
      return
    }
    if (grace()) {
      makeTimer(() => setGrace(false), GRACE_MS, setTimeout)
    }
  })

  const selfVisual = createMemo(() => {
    if (input.blocked?.()) return false
    const s = input.status()
    if (isBusy(s)) return true
    if (grace()) return !!input.pending()
    return false
  })

  const selfInteractive = createMemo(() => {
    const s = input.status()
    if (isBusy(s)) return true
    if (grace()) return !!input.pending()
    return false
  })

  const descBusy = createMemo(() => {
    const id = input.sessionID?.()
    const src = input.children
    if (!id || !src) return false
    return descendantBusy(id, src())
  })

  const visual = createMemo(() => selfVisual() || descBusy())
  const interactive = createMemo(() => selfInteractive() || descBusy())

  return { visual, interactive, grace }
}
