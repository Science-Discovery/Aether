const TTL = 30_000
const map = new Map<string, number>()

const prune = (now = Date.now()) => {
  for (const [id, at] of map.entries()) {
    if (now - at <= TTL) continue
    map.delete(id)
  }
}

export namespace Lease {
  export function touch(id: string) {
    if (!id) return
    map.set(id, Date.now())
  }

  export function drop(id: string) {
    if (!id) return
    map.delete(id)
  }

  export function count() {
    prune()
    return map.size
  }
}
