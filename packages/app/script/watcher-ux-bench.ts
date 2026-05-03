import { invalidateFromWatcher } from "../src/context/file/watcher"
import { createRefreshQueue } from "../src/context/file/refresh-queue"
import type { FileNode } from "@opencode-ai/sdk/v2"

declare const Bun: { sleep: (ms: number) => Promise<void> }
declare const console: { log: (...args: unknown[]) => void }

type Event = {
  file: string
  event: "add" | "change" | "unlink"
  wait?: number
}

type Node = Record<string, FileNode>

function sleep(ms: number) {
  return Bun.sleep(ms)
}

function node(path: string, type: "file" | "directory"): FileNode {
  const name = path.split("/").at(-1) ?? path
  return {
    name,
    path,
    absolute: `/repo/${path}`,
    ignored: false,
    type,
  }
}

function legacy(event: { type: string; properties: unknown }, ops: any) {
  if (event.type !== "file.watcher.updated") return
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const raw = typeof props?.file === "string" ? props.file : undefined
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (!raw || !kind) return
  const path = ops.normalize(raw)
  if (!path || path.startsWith(".git/")) return

  if (ops.hasFile(path) || ops.isOpen?.(path)) ops.loadFile(path)

  if (kind === "change") {
    const dir = (() => {
      if (path === "") return ""
      const node = ops.node(path)
      if (node?.type !== "directory") return
      return path
    })()
    if (dir === undefined) return
    if (!ops.isDirLoaded(dir)) return
    ops.refreshDir(dir)
    return
  }

  if (kind !== "add" && kind !== "unlink") return
  let parent = path.split("/").slice(0, -1).join("/")
  while (parent !== "" && !ops.isDirLoaded(parent)) {
    parent = parent.split("/").slice(0, -1).join("/")
  }
  if (!ops.isDirLoaded(parent)) return
  ops.refreshDir(parent)
}

function evt(input: Event) {
  return {
    type: "file.watcher.updated",
    properties: {
      file: input.file,
      event: input.event,
    },
  }
}

async function runCurrent(events: Event[], nodes: Node, loaded: Set<string>) {
  const calls: string[] = []
  const flushes: string[][] = []
  const queue = createRefreshQueue((dirs) => {
    flushes.push(dirs)
    calls.push(...dirs)
  }, 150)

  const ops = {
    normalize: (input: string) => input,
    hasFile: () => false,
    isOpen: () => false,
    loadFile: () => {},
    node: (file: string) => nodes[file],
    isDirLoaded: (dir: string) => loaded.has(dir),
    refreshDir: (dir: string) => queue.push(dir),
  }

  for (const item of events) {
    invalidateFromWatcher(evt(item), ops)
    if (item.wait) await sleep(item.wait)
  }
  await sleep(200)
  queue.stop()
  return { calls, flushes }
}

async function runLegacy(events: Event[], nodes: Node, loaded: Set<string>) {
  const calls: string[] = []
  const ops = {
    normalize: (input: string) => input,
    hasFile: () => false,
    isOpen: () => false,
    loadFile: () => {},
    node: (file: string) => nodes[file],
    isDirLoaded: (dir: string) => loaded.has(dir),
    refreshDir: (dir: string) => calls.push(dir),
  }
  for (const item of events) {
    legacy(evt(item), ops)
    if (item.wait) await sleep(item.wait)
  }
  return { calls, flushes: [] as string[][] }
}

function ratio(before: number, after: number) {
  if (before === 0) return "0.0"
  return (((before - after) / before) * 100).toFixed(1)
}

async function parentCase() {
  const nodes: Node = {
    "src/skill": node("src/skill", "directory"),
  }
  const loaded = new Set(["src/skill", "src"])
  const events: Event[] = [{ file: "src/skill", event: "change" }]
  const old = await runLegacy(events, nodes, loaded)
  const cur = await runCurrent(events, nodes, loaded)
  return {
    case: "parent-refresh",
    legacy: old.calls,
    current: cur.calls,
    improved: cur.calls.includes("src"),
  }
}

async function burstCase() {
  const nodes: Node = {}
  const loaded = new Set(["src/skill"])
  const events: Event[] = Array.from({ length: 120 }).map((_, i) => ({
    file: `src/skill/f-${i}.ts`,
    event: "add" as const,
  }))
  const old = await runLegacy(events, nodes, loaded)
  const cur = await runCurrent(events, nodes, loaded)
  return {
    case: "debounce-burst",
    legacy_refresh_calls: old.calls.length,
    current_refresh_calls: cur.calls.length,
    current_flush_batches: cur.flushes.length,
    reduction_pct: ratio(old.calls.length, cur.calls.length),
  }
}

const a = await parentCase()
const b = await burstCase()

console.log(`[watcher-ux] ${JSON.stringify(a)}`)
console.log(`[watcher-ux] ${JSON.stringify(b)}`)
