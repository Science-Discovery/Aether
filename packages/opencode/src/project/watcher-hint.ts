import path from "path"
import { Filesystem } from "@/util/filesystem"

const subs = new Set<() => void>()
const TTL = 300_000
const PRUNE_MS = 5_000

let timer: ReturnType<typeof setInterval> | undefined
const map = new Map<
  string,
  {
    directory: string
    files: string[]
    dirs: string[]
    watched: string[]
    at: number
  }
>()

function emit() {
  for (const sub of subs) sub()
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

function prune(now = Date.now()) {
  let dirty = false
  for (const [id, item] of map.entries()) {
    if (now - item.at <= TTL) continue
    map.delete(id)
    dirty = true
  }
  if (!dirty) return
  emit()
  stop()
}

function unique(input: string[]) {
  return [...new Set(input)].sort()
}

function inside(root: string, value: string) {
  const rel = path.relative(root, value)
  if (!rel) return true
  if (rel.startsWith("..")) return false
  return !path.isAbsolute(rel)
}

function normalize(root: string, value: string) {
  const next = Filesystem.resolve(path.isAbsolute(value) ? value : path.join(root, value))
  if (!inside(root, next)) throw new Error(`Watcher hint path escapes project directory: ${value}`)
  const rel = path.relative(root, next).replaceAll("\\", "/")
  return rel === "" ? "" : rel
}

function watched(root: string, files: string[], dirs: string[]) {
  return unique(
    [...dirs, ...files.map((item) => path.dirname(item).replaceAll("\\", "/")).map((item) => (item === "." ? "" : item))]
      .map((item) => Filesystem.resolve(path.join(root, item)))
      .filter((item) => inside(root, item)),
  )
}

function value(item: {
  directory: string
  files: string[]
  dirs: string[]
  watched: string[]
}) {
  return {
    directory: item.directory,
    files: item.files,
    dirs: item.dirs,
    watched: item.watched,
  }
}

export const WatcherHint = {
  get(id: string) {
    prune()
    const item = map.get(id)
    if (!item) return
    return value(item)
  },
  set(
    id: string,
    input: {
      directory: string
      files?: string[]
      dirs?: string[]
    },
  ) {
    if (!id) return
    start()
    const directory = Filesystem.resolve(input.directory)
    const files = unique((input.files ?? []).map((item) => normalize(directory, item)).filter(Boolean))
    const dirs = unique((input.dirs ?? []).map((item) => normalize(directory, item)))
    const next = {
      directory,
      files,
      dirs,
      watched: watched(directory, files, dirs),
      at: Date.now(),
    }
    map.set(id, next)
    emit()
    return value(next)
  },
  touch(id: string) {
    const item = map.get(id)
    if (!item) return
    start()
    map.set(id, {
      ...item,
      at: Date.now(),
    })
    return item.watched
  },
  drop(id: string) {
    if (!map.has(id)) return
    map.delete(id)
    emit()
    stop()
  },
  watch(directory: string) {
    prune()
    const root = Filesystem.resolve(directory)
    return unique(
      [...map.values()]
        .filter((item) => item.directory === root)
        .flatMap((item) => item.watched),
    )
  },
  clear() {
    if (map.size === 0) return
    map.clear()
    emit()
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
