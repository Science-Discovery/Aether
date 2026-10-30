import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

type Store = { session_status: Record<string, SessionStatus> }
type State = {
  request: number
  applied: number
  versions: Map<string, number>
  writes: Map<string, { request: number; value: string | undefined }>
}
const cache = new WeakMap<Store, State>()

function state(store: Store) {
  const known = cache.get(store)
  if (known) return known
  const next: State = { request: 0, applied: 0, versions: new Map(), writes: new Map() }
  cache.set(store, next)
  return next
}

export function touch(store: Store, id: string) {
  const current = state(store).versions
  current.set(id, (current.get(id) ?? 0) + 1)
}

export function capture(store: Store) {
  const current = state(store)
  return {
    request: ++current.request,
    applied: current.applied,
    values: new Map(Object.entries(store.session_status).map(([id, value]) => [id, JSON.stringify(value)])),
    versions: new Map(current.versions),
  }
}

// Missing HTTP entries mean idle. Preserve live changes, including a status
// that changed away from and back to its original value while HTTP was pending.
// Apply the returned map synchronously. HTTP responses are ordered by request,
// independently of live event versions, even when they confirm the same value
// or an empty table. HTTP-origin changes can be replaced by a newer response;
// direct local changes remain protected by the value comparison.
export function rebase(next: Record<string, SessionStatus>, before: ReturnType<typeof capture>, store: Store) {
  const current = state(store)
  if (before.request < current.applied) return { ...store.session_status }
  const result = { ...next }
  const ids = new Set([...before.values.keys(), ...Object.keys(store.session_status), ...Object.keys(next)])
  for (const id of ids) {
    const value = store.session_status[id]
    const serialized = JSON.stringify(value)
    const written = current.writes.get(id)
    const managed = written && written.request > before.applied && written.value === serialized
    if (before.versions.get(id) !== current.versions.get(id) || (before.values.get(id) !== serialized && !managed)) {
      if (value === undefined) {
        delete result[id]
        continue
      }
      result[id] = value
      continue
    }
    current.writes.set(id, { request: before.request, value: JSON.stringify(next[id]) })
  }
  current.applied = before.request
  return result
}
