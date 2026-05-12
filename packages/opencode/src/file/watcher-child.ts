import type ParcelWatcher from "@parcel/watcher"
import * as Parcel from "./parcel-watcher"
import { FileIgnore } from "./ignore"

type Input = {
  dir: string
  ignore: string[]
  filter: string[]
  backend: ParcelWatcher.BackendType
}

type Output =
  | { type: "ready" }
  | { type: "event"; path: string; event: "add" | "change" | "unlink" }
  | { type: "error"; stage: "load" | "subscribe" | "callback"; error: string }

let sub: ParcelWatcher.AsyncSubscription | undefined
let stop = false

function send(msg: Output) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

async function close(code = 0) {
  if (stop) return
  stop = true
  await sub?.unsubscribe().catch(() => undefined)
  process.exit(code)
}

process.on("SIGTERM", () => {
  void close()
})

process.on("SIGINT", () => {
  void close()
})

const raw = process.argv[2]

if (!raw) {
  send({ type: "error", stage: "load", error: "missing watcher child input" })
  process.exit(1)
}

const input = JSON.parse(Buffer.from(raw, "base64url").toString()) as Input
const watcher = Parcel.load()

if (!watcher.value) {
  send({
    type: "error",
    stage: "load",
    error: [watcher.name, watcher.error, watcher.fallback].filter(Boolean).map(String).join(" "),
  })
  process.exit(1)
}

try {
  sub = await watcher.value.subscribe(
    input.dir,
    (err, evts) => {
      if (err) {
        send({
          type: "error",
          stage: "callback",
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      for (const evt of evts) {
        if (FileIgnore.filter(input.filter, evt.path, input.dir)) continue
        if (evt.type === "create") send({ type: "event", path: evt.path, event: "add" })
        if (evt.type === "update") send({ type: "event", path: evt.path, event: "change" })
        if (evt.type === "delete") send({ type: "event", path: evt.path, event: "unlink" })
      }
    },
    {
      ignore: input.ignore,
      backend: input.backend,
    },
  )
  send({ type: "ready" })
} catch (error) {
  send({
    type: "error",
    stage: "subscribe",
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
}
