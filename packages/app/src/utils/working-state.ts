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
  pending: (id: string) => unknown
}

const busy = (status: SessionStatus) => status?.type === "busy" || status?.type === "retry"

function descendant(id: string, source: ChildrenSource, seen = new Set<string>()) {
  if (seen.has(id)) return false
  seen.add(id)
  const children = source.childMap().get(id)
  if (!children?.length) return false
  for (const child of children) {
    if (busy(source.status(child))) return true
    if (source.pending(child)) return true
    if (descendant(child, source, seen)) return true
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
    if (busy(s)) {
      setGrace(true)
      return
    }
    if (grace()) {
      makeTimer(() => setGrace(false), GRACE_MS, setTimeout)
    }
  })

  const self = createMemo(() => {
    if (input.blocked?.()) return false
    const s = input.status()
    if (busy(s)) return true
    if (grace()) return !!input.pending()
    return false
  })

  const active = createMemo(() => {
    const s = input.status()
    if (busy(s)) return true
    return !!input.pending()
  })

  const child = createMemo(() => {
    const id = input.sessionID?.()
    const source = input.children?.()
    if (!id || !source) return false
    return descendant(id, source)
  })

  const visual = createMemo(() => self() || child())
  const interactive = createMemo(() => active() || child())

  return { visual, interactive, grace }
}
