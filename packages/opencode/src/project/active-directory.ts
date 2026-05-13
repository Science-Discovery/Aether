import { Filesystem } from "@/util/filesystem"
import { Log } from "../util/log"

const subs = new Set<() => void>()
const TTL = 300_000
const PRUNE_MS = 5_000
const log = Log.create({ service: "active-directory" })

let current: string | undefined
let timer: ReturnType<typeof setInterval> | undefined
let tick = 0
const map = new Map<string, { directory: string; at: number; tick: number }>()

function latest() {
  let next: string | undefined
  let seen = -1
  for (const item of map.values()) {
    if (item.tick < seen) continue
    seen = item.tick
    next = item.directory
  }
  return next
}

function emit() {
  current = latest()
  for (const sub of subs) sub()
}

function sync() {
  current = latest()
  return current
}

function prune(now = Date.now()) {
  let dirty = false
  const dropped: { id: string; directory: string; ageMs: number }[] = []
  for (const [id, item] of map.entries()) {
    if (now - item.at <= TTL) continue
    map.delete(id)
    dirty = true
    dropped.push({
      id,
      directory: item.directory,
      ageMs: now - item.at,
    })
  }
  if (!dirty) return current
  log.info("lease pruned", {
    dropped,
    current,
    directories: [...new Set([...map.values()].map((item) => item.directory))],
    leases: map.size,
  })
  emit()
  return current
}

function start() {
  if (timer) return
  timer = setInterval(prune, PRUNE_MS)
  timer.unref?.()
}

function stop() {
  if (timer && map.size === 0 && subs.size === 0) {
    clearInterval(timer)
    timer = undefined
  }
}

export const ActiveDirectory = {
  get() {
    prune()
    return current
  },
  set(id: string, directory?: string) {
    if (!id) return current
    if (!directory) return this.drop(id)
    start()
    const next = Filesystem.resolve(directory)
    const prev = map.get(id)
    map.set(id, {
      directory: next,
      at: Date.now(),
      tick: ++tick,
    })
    log.info("lease set", {
      id,
      directory: next,
      previous: prev?.directory,
      current,
      directories: [...new Set([...map.values()].map((item) => item.directory))],
      leases: map.size,
    })
    if (prev?.directory !== next) emit()
    else sync()
    return current
  },
  has(directory: string) {
    prune()
    const next = Filesystem.resolve(directory)
    for (const item of map.values()) {
      if (item.directory === next) return true
    }
    return false
  },
  list() {
    prune()
    return [...new Set([...map.values()].map((item) => item.directory))]
  },
  count(directory: string) {
    prune()
    const next = Filesystem.resolve(directory)
    let count = 0
    for (const item of map.values()) {
      if (item.directory !== next) continue
      count += 1
    }
    return count
  },
  directory(id: string) {
    prune()
    return map.get(id)?.directory
  },
  touch(id: string) {
    const item = map.get(id)
    if (!item) {
      log.info("lease touch miss", {
        id,
        current,
        directories: [...new Set([...map.values()].map((item) => item.directory))],
        leases: map.size,
      })
      return current
    }
    start()
    const now = Date.now()
    map.set(id, {
      ...item,
      at: now,
      tick: ++tick,
    })
    log.info("lease touch hit", {
      id,
      directory: item.directory,
      ageMs: now - item.at,
      current,
      directories: [...new Set([...map.values()].map((item) => item.directory))],
      leases: map.size,
    })
    return sync()
  },
  drop(id: string) {
    if (!id) return current
    if (!map.has(id)) return current
    const prev = map.get(id)
    map.delete(id)
    log.info("lease dropped", {
      id,
      directory: prev?.directory,
      current,
      directories: [...new Set([...map.values()].map((item) => item.directory))],
      leases: map.size,
    })
    emit()
    stop()
    return current
  },
  clear() {
    if (map.size === 0 && current === undefined) return
    map.clear()
    current = undefined
    for (const sub of subs) sub()
    stop()
  },
  subscribe(sub: () => void) {
    start()
    subs.add(sub)
    return () => {
      subs.delete(sub)
      stop()
    }
  },
}
