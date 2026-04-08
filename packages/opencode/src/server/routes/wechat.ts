import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { lazy } from "@/util/lazy"
import { WeChatManager, WeChatEvent } from "@/wechat/manager"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"

export const WeChatRoutes = lazy(() =>
  new Hono()
    .post(
      "/start",
      describeRoute({
        summary: "Start WeChat bridge",
        description: "Start the WeChat bridge service",
        operationId: "wechat.start",
        responses: {
          200: {
            description: "Bridge started",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    code: z.string().optional(),
                    message: z.string().optional(),
                    status: z.string().optional(),
                    user: z
                      .object({
                        id: z.string(),
                        name: z.string(),
                      })
                      .optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const body = await c.req.json().catch(() => ({}))
        const clientId: string = body?.clientId || crypto.randomUUID()
        if (!(await WeChatManager.tryLock(clientId))) {
          return c.json({ success: false, code: "locked", message: "微信已被其他客户端连接" })
        }
        const result = await WeChatManager.start(body?.model, body?.autoInstall === true)
        if (!result.success) {
          await WeChatManager.unlock(clientId)
        }
        return c.json({ ...result, clientId })
      },
    )
    .post(
      "/stop",
      describeRoute({
        summary: "Stop WeChat bridge",
        description: "Stop the WeChat bridge service",
        operationId: "wechat.stop",
        responses: {
          200: {
            description: "Bridge stopped",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => {
        const body = await c.req.json().catch(() => ({}))
        if (body?.clientId) await WeChatManager.unlock(body.clientId)
        await WeChatManager.stop()
        return c.json({ success: true })
      },
    )
    .post(
      "/ping",
      describeRoute({
        summary: "Ping WeChat lease",
        description: "Renew the WeChat lock lease or detect if stolen by another client",
        operationId: "wechat.ping",
        responses: {
          200: {
            description: "Ping result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.boolean(),
                    stolen: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const body = await c.req.json().catch(() => ({}))
        const clientId: string = body?.clientId || ""
        if (!clientId) return c.json({ ok: false, stolen: false })
        const result = await WeChatManager.ping(clientId)
        return c.json(result)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get WeChat status",
        description: "Get the current WeChat bridge status",
        operationId: "wechat.status",
        responses: {
          200: {
            description: "Status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    status: z.enum(["idle", "starting", "qrcode", "connected", "error"]),
                    qrcode: z.string().nullable(),
                    user: z
                      .object({
                        id: z.string(),
                        name: z.string(),
                      })
                      .nullable(),
                    error: z
                      .object({
                        code: z.string(),
                        message: z.string(),
                      })
                      .nullable(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const session = await WeChatManager.loadSession()
        return c.json({
          status: WeChatManager.status,
          qrcode: WeChatManager.qrcode,
          user: WeChatManager.session?.user || session?.user || null,
          error: WeChatManager.error,
          locked: WeChatManager.lockHolder !== null,
          lockHolder: WeChatManager.lockHolder,
        })
      },
    )
    .get(
      "/events",
      describeRoute({
        summary: "Subscribe to WeChat events",
        description: "Get real-time WeChat events via SSE",
        operationId: "wechat.events",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      async (c) => {
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        const clientId = c.req.query("clientId") || ""

        return streamSSE(c, async (stream) => {
          const q = new AsyncQueue<string | null>()
          let done = false

          q.push(
            JSON.stringify({
              type: "wechat.connected",
              properties: { status: WeChatManager.status },
            }),
          )

          const heartbeat = setInterval(() => {
            q.push(
              JSON.stringify({
                type: "wechat.heartbeat",
                properties: {},
              }),
            )
          }, 10_000)

          const unsub = Bus.subscribeAll((event) => {
            if (event.type.startsWith("wechat.")) {
              q.push(JSON.stringify(event))
            }
          })

          const stop = () => {
            if (done) return
            done = true
            clearInterval(heartbeat)
            unsub()
            q.push(null)
          }

          stream.onAbort(stop)

          try {
            for await (const data of q) {
              if (data === null) return
              await stream.writeSSE({ data })
            }
          } finally {
            stop()
          }
        })
      },
    )
    .delete(
      "/session",
      describeRoute({
        summary: "Clear WeChat session",
        description: "Clear the saved WeChat session",
        operationId: "wechat.session.clear",
        responses: {
          200: {
            description: "Session cleared",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => {
        await WeChatManager.clearSession()
        return c.json({ success: true })
      },
    ),
)
