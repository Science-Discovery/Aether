type State = "active" | "closing"

type Entry = {
  state: State
  updatedAt: number
  closingAt: number | null
}

const TTL = 30_000
const CLOSING_GRACE_MS = 30_000
const map = new Map<string, Entry>()

const prune = (now = Date.now()) => {
  for (const [id, entry] of map.entries()) {
    if (entry.state === "active" && now - entry.updatedAt <= TTL) continue
    if (entry.state === "closing" && now - entry.closingAt! <= CLOSING_GRACE_MS + TTL) continue
    map.delete(id)
  }
}

export namespace Lease {
  export function touch(id: string) {
    if (!id) return
    const existing = map.get(id)
    if (existing && existing.state === "closing") {
      map.set(id, { state: "active", updatedAt: Date.now(), closingAt: null })
      return
    }
    map.set(id, { state: "active", updatedAt: Date.now(), closingAt: null })
  }

  export function markClosing(id: string) {
    if (!id) return
    const existing = map.get(id)
    if (existing && existing.state === "closing") return
    map.set(id, { state: "closing", updatedAt: Date.now(), closingAt: Date.now() })
  }

  export function drop(id: string) {
    if (!id) return
    map.delete(id)
  }

  export function count() {
    prune()
    return map.size
  }

  export function activeCount() {
    prune()
    let n = 0
    for (const entry of map.values()) {
      if (entry.state === "active") n++
    }
    return n
  }

  export function closingCount() {
    prune()
    let n = 0
    for (const entry of map.values()) {
      if (entry.state === "closing") n++
    }
    return n
  }
}
