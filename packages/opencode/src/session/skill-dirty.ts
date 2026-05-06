import { SessionID } from "./schema"
import { Log } from "../util/log"

const state = new Map<string, Set<string>>()

function key(sessionID: SessionID | string) {
  return String(sessionID)
}

export namespace SkillDirty {
  export function add(sessionID: SessionID | string, names: string[]) {
    if (names.length === 0) return
    const id = key(sessionID)
    const before = state.get(id)?.size ?? 0
    const cur = state.get(id) ?? new Set<string>()
    for (const name of names) {
      if (!name.trim()) continue
      cur.add(name)
    }
    if (cur.size === 0) return
    state.set(id, cur)
    Log.activity(`[skill dirty state] op=add session=${id} names=[${names.join(", ")}] before=${before} after=${cur.size} ts=${Date.now()}`)
  }

  export function take(sessionID: SessionID | string) {
    const id = key(sessionID)
    const cur = state.get(id)
    if (!cur || cur.size === 0) {
      Log.activity(`[skill dirty state] op=take session=${id} names=[] before=0 after=0 ts=${Date.now()}`)
      return [] as string[]
    }
    const names = [...cur]
    state.delete(id)
    Log.activity(`[skill dirty state] op=take session=${id} names=[${names.join(", ")}] before=${names.length} after=0 ts=${Date.now()}`)
    return names
  }

  export function list(sessionID: SessionID | string) {
    const cur = state.get(key(sessionID))
    if (!cur) return [] as string[]
    return [...cur]
  }
}
