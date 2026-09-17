import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { createServer, type RequestListener } from "node:http"
import type { ServerConnection } from "@/context/server"
import { connectShared } from "./shared-connection"

type Sink = {
  events: Array<{ directory?: string; payload: Event }>
  ended: boolean
}

function watch(conn: ReturnType<typeof connectShared>) {
  const sink: Sink = { events: [], ended: false }
  void (async () => {
    for await (const event of conn.stream) sink.events.push(event)
    sink.ended = true
  })()
  return sink
}

async function until(check: () => boolean, ms: number, label: string) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timeout waiting for: ${label}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sseChunk = (type: string) => `data: ${JSON.stringify({ payload: { type, properties: {} } })}\n\n`

async function startEventServer() {
  const clients = new Set<import("node:http").ServerResponse>()
  let leaderConnectedAt = 0
  const handler: RequestListener = (req, res) => {
    if (req.url !== "/global/event") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
      return
    }
    if (!leaderConnectedAt) leaderConnectedAt = Date.now()
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    clients.add(res)
    res.write(sseChunk("server.connected"))
    res.on("close", () => clients.delete(res))
  }
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    leaderConnectedAt: () => leaderConnectedAt,
    push(type: string) {
      for (const res of clients) res.write(sseChunk(type))
    },
    stop: () => server.close(),
  }
}

describe("connectShared", () => {
  test("relays events to follower and recovers when leader dies", async () => {
    const http = await startEventServer()
    const server = { url: http.url } as ServerConnection.HttpBase
    const controllers: AbortController[] = []
    const open = () => {
      const ctrl = new AbortController()
      controllers.push(ctrl)
      // happy-dom hijacks globalThis.fetch in bun test and blocks cross-origin
      // SSE; route through Bun's native fetch like a real browser would.
      return connectShared({
        server,
        signal: ctrl.signal,
        fetch: ((input, init) => Bun.fetch(input, init)) as typeof fetch,
      })
    }

    try {
      const leader = watch(open())
      await until(() => leader.events.length > 0, 5000, "leader receives sse")

      // connectShared heartbeats every 2000ms starting at L; the follower role
      // is decided by hearing a beat inside a 500ms window after claim. Open the
      // second connection at L+1250 so the beat at L+2000 lands mid-window.
      const at = http.leaderConnectedAt()
      const elapsed = Date.now() - at
      await sleep(Math.max(0, 1250 - elapsed))
      const follower = watch(open())

      await sleep(Math.max(0, 2600 - (Date.now() - at)))
      http.push("todo.updated")
      await until(() => follower.events.some((e) => e.payload.type === "todo.updated"), 5000, "follower relay")

      controllers[0].abort()
      await until(() => follower.ended, 10_000, "follower stream ends after leader death")
      expect(follower.ended).toBe(true)

      const again = watch(open())
      await until(() => again.events.length > 0, 5000, "recovered connection streams again")
      http.push("todo.updated")
      await until(() => again.events.some((e) => e.payload.type === "todo.updated"), 5000, "recovered connection relay")
    } finally {
      for (const ctrl of controllers) ctrl.abort()
      http.stop()
    }
  }, 30_000)
})
