import { GlobalBus } from "../../bus/global"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

export function WorkspaceServerRoutes() {
  return new Hono().get("/event", async (c) => {
    c.header("X-Accel-Buffering", "no")
    c.header("X-Content-Type-Options", "nosniff")
    return streamSSE(c, async (stream) => {
      let resolve!: () => void
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        clearInterval(heartbeat)
        GlobalBus.off("event", handler)
        resolve()
      }
      const send = async (event: unknown) => {
        await stream.writeSSE({
          data: JSON.stringify(event),
        })
      }
      const handler = async (event: { directory?: string; payload: unknown }) => {
        try {
          await send(event.payload)
        } catch {
          finish()
        }
      }
      GlobalBus.on("event", handler)
      await send({ type: "server.connected", properties: {} })
      const heartbeat = setInterval(() => {
        send({ type: "server.heartbeat", properties: {} }).catch(finish)
      }, 10_000)

      await new Promise<void>((r) => {
        resolve = r
        stream.onAbort(finish)
      })
    })
  })
}
