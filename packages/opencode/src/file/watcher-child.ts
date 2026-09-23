import { createInterface } from "readline"
import { existsSync } from "fs"
import path from "path"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"

// JS sidecar for FileWatcher. Implements the same JSON-over-stdio protocol as
// the go watcher sidecar (see file/watcher.ts child()), but hosts the native
// @parcel/watcher binding in this child process: a segfault in watcher.node
// then kills this process instead of the server. Spawned by
// file/watcher.ts; one process per watched directory.
//
// Protocol: one "start" message on stdin, then "ready" once, then "event"
// lines, "error" lines for failures (fatal before ready). Closing stdin or
// a signal unsubscribes and exits.
//
// Two ways to reach main(): spawn this file directly (source checkouts via
// `bun watcher-child.ts`), or run a packaged binary with --watcher-child so
// the bundled copy self-executes (a compiled binary has no source file on
// disk to spawn).
export const childArg = "--watcher-child"

function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function binding(): typeof import("@parcel/watcher") {
  const candidates: string[] = []
  if (process.platform === "win32") {
    candidates.push(process.arch === "arm64" ? "@parcel/watcher-win32-arm64" : "@parcel/watcher-win32-x64")
  } else if (process.platform === "darwin") {
    candidates.push(process.arch === "arm64" ? "@parcel/watcher-darwin-arm64" : "@parcel/watcher-darwin-x64")
  } else if (process.platform === "linux") {
    const libc = (globalThis as { OPENCODE_LIBC?: string }).OPENCODE_LIBC ?? "glibc"
    candidates.push(`@parcel/watcher-linux-${process.arch}-${libc}`)
  }
  for (const name of candidates) {
    try {
      return createWrapper(require(name))
    } catch {
      // try the next candidate, then the aggregate package
    }
  }
  return require("@parcel/watcher") as typeof import("@parcel/watcher")
}

export function main() {
  let sub: ParcelWatcher.AsyncSubscription | undefined

  const start = async (msg: { root: string; ignore?: string[]; backend?: ParcelWatcher.BackendType }) => {
    const watcher = binding()
    const dir = path.resolve(msg.root)
    // On Windows the native backend neither rejects nor fires events for a
    // missing directory; fail fast so the parent can fall back instead of
    // waiting on a subscription that will never report anything.
    if (!existsSync(dir)) throw new Error(`directory does not exist: ${dir}`)
    sub = await watcher.subscribe(
      dir,
      (_err, events) => {
        for (const evt of events) {
          send({
            type: "event",
            path: evt.path,
            event: evt.type === "create" ? "add" : evt.type === "update" ? "change" : "unlink",
          })
        }
      },
      { ignore: msg.ignore ?? [], backend: msg.backend },
    )
    send({ type: "ready", watched: 1, ignored: (msg.ignore ?? []).length })
  }

  const stop = () => {
    sub?.unsubscribe().catch(() => undefined)
    process.exit(0)
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on("line", (line) => {
    if (!line.trim()) return
    let msg: { type?: string; root?: string; ignore?: string[]; backend?: ParcelWatcher.BackendType }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type !== "start" || !msg.root) return
    start(msg as { root: string; ignore?: string[]; backend?: ParcelWatcher.BackendType }).catch((e) => {
      send({ type: "error", stage: "start", error: e instanceof Error ? e.message : String(e), fatal: true })
      // A fatal start failure must terminate the process: stdin stays open and
      // would otherwise keep this sidecar alive forever.
      setTimeout(() => process.exit(1), 100)
    })
  })

  process.stdin.on("end", stop)
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

if (import.meta.main) main()
