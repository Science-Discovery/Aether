import { ActiveInstance } from "@/project/active-instance"

const TTL = 30_000
const map = new Map<string, { at: number; directory?: string }>()

const owner = (id: string) => `lease:${id}`

const prune = (now = Date.now()) => {
  for (const [id, item] of map.entries()) {
    if (now - item.at <= TTL) continue
    map.delete(id)
    ActiveInstance.deactivateOwner(owner(id))
  }
}

export namespace Lease {
  export function touch(id: string, directory?: string) {
    if (!id) return false
    prune()
    const prev = map.get(id)
    const next = directory || prev?.directory
    map.set(id, { at: Date.now(), directory: next })
    if (directory) ActiveInstance.activateOwner(owner(id), directory)
    return next ? ActiveInstance.is(next) : false
  }

  export function drop(id: string) {
    if (!id) return
    prune()
    map.delete(id)
    ActiveInstance.deactivateOwner(owner(id))
  }

  export function count() {
    prune()
    return map.size
  }
}
