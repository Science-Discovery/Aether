import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { lazy } from "@/util/lazy"
import { FeishuManager, FeishuEvent } from "@/feishu/manager"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"

export const FeishuRoutes = lazy(() =>
  new Hono()
    .post(
      "/start",
      describeRoute({
        summary: "Start Feishu bridge",
        description: "Start the Feishu bridge service with WebSocket connection",
        operationId: "feishu.start",
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
                    appId: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const body = await c.req.json().catch(() => ({}))
        const config =
          body?.appId && body?.appSecret ? { appId: body.appId, appSecret: body.appSecret } : undefined
        const result = await FeishuManager.start(config)
        return c.json(result)
      },
    )
    .post(
      "/stop",
      describeRoute({
        summary: "Stop Feishu bridge",
        description: "Stop the Feishu bridge service",
        operationId: "feishu.stop",
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
        await FeishuManager.stop()
        return c.json({ success: true })
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get Feishu status",
        description: "Get the current Feishu bridge status",
        operationId: "feishu.status",
        responses: {
          200: {
            description: "Status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    status: z.enum(["idle", "starting", "connected", "error"]),
                    appId: z.string().nullable(),
                    hasConfig: z.boolean(),
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
        const config = await FeishuManager.loadConfig()
        return c.json({
          status: FeishuManager.status,
          appId: FeishuManager.session?.appId || null,
          hasConfig: !!config,
          error: FeishuManager.error,
        })
      },
    )
    .get(
      "/events",
      describeRoute({
        summary: "Subscribe to Feishu events",
        description: "Get real-time Feishu events via SSE",
        operationId: "feishu.events",
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

        return streamSSE(c, async (stream) => {
          const q = new AsyncQueue<string | null>()
          let done = false

          q.push(
            JSON.stringify({
              type: "feishu.status",
              properties: { status: FeishuManager.status },
            }),
          )

          // If already connected, push connected event immediately
          if (FeishuManager.status === "connected" && FeishuManager.session?.appId) {
            q.push(
              JSON.stringify({
                type: "feishu.connected",
                properties: { appId: FeishuManager.session.appId },
              }),
            )
          }

          const heartbeat = setInterval(() => {
            q.push(
              JSON.stringify({
                type: "feishu.heartbeat",
                properties: {},
              }),
            )
          }, 10_000)

          const unsub = Bus.subscribeAll((event) => {
            if (event.type.startsWith("feishu.")) {
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
        summary: "Clear Feishu session",
        description: "Clear the saved Feishu configuration and session data",
        operationId: "feishu.session.clear",
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
        await FeishuManager.clearSession()
        return c.json({ success: true })
      },
    ),
)
