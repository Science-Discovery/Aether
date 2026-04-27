import { SessionID } from "./schema"

const state = new Map<string, Set<string>>()

function key(sessionID: SessionID | string) {
  return String(sessionID)
}

export namespace SkillDirty {
  export function add(sessionID: SessionID | string, names: string[]) {
    if (names.length === 0) return
    const id = key(sessionID)
    const cur = state.get(id) ?? new Set<string>()
    for (const name of names) {
      if (!name.trim()) continue
      cur.add(name)
    }
    if (cur.size === 0) return
    state.set(id, cur)
  }

  export function take(sessionID: SessionID | string) {
    const id = key(sessionID)
    const cur = state.get(id)
    if (!cur || cur.size === 0) return [] as string[]
    state.delete(id)
    return [...cur]
  }

  export function list(sessionID: SessionID | string) {
    const cur = state.get(key(sessionID))
    if (!cur) return [] as string[]
    return [...cur]
  }
}
