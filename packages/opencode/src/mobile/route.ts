import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"
import { FeishuManager } from "@/mobile/feishu"
import type { FeishuConfig } from "@/mobile/feishu"
import { QQManager } from "@/mobile/qq"
import type { QQConfig } from "@/mobile/qq"
import { WeChatManager } from "@/mobile/wechat"
import type { MobileStatus } from "@/mobile/base"

export function createMobileRoutes(platform: "feishu" | "qq" | "wechat") {
  const manager = platform === "feishu" ? FeishuManager : platform === "qq" ? QQManager : WeChatManager
  const prefix = platform

  const statusValues = [
    "idle",
    "starting",
    "qrcode",
    "connected",
    "reconnecting",
    "error",
  ] as const satisfies readonly MobileStatus[]
  const statusSchema = z.object({
    status: z.enum(statusValues),
    enabled: z.boolean(),
    ...(platform === "feishu" || platform === "qq"
      ? { appId: z.string().nullable(), hasConfig: z.boolean() }
      : platform === "wechat"
        ? {
            qrcode: z.string().nullable(),
            user: z.object({ id: z.string(), name: z.string() }).nullable(),
            hasConfig: z.boolean(),
          }
        : {}),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })

  const startResponseSchema = z.object({
    success: z.boolean(),
    code: z.string().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    ...(platform === "feishu" || platform === "qq"
      ? { appId: z.string().optional() }
      : { user: z.object({ id: z.string(), name: z.string() }).optional() }),
  })

  return new Hono()
    .post(
      "/start",
      describeRoute({
        summary: `Start ${platform} bridge`,
        description: `Start the ${platform} bridge service`,
        operationId: `${prefix}.start`,
        responses: {
          200: {
            description: "Bridge started",
            content: { "application/json": { schema: resolver(startResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const body = await c.req.json().catch(() => ({}))

        if (platform === "feishu" || platform === "qq") {
          const mgr = platform === "feishu" ? FeishuManager : QQManager
          const config = body?.appId && body?.appSecret ? { appId: body.appId, appSecret: body.appSecret } : undefined
          const model =
            body?.model?.providerID && body?.model?.modelID
              ? { providerID: body.model.providerID as string, modelID: body.model.modelID as string }
              : undefined
          const result = await mgr.start(config, model)
          await mgr.setDesired(true)
          return c.json(result)
        }
        const result = await WeChatManager.start(body?.rescan === true)
        await WeChatManager.setDesired(true)
        return c.json(result)
      },
    )
    .post(
      "/retry",
      describeRoute({
        summary: "Retry WeChat connection",
        description: "Retry WeChat connection from error state",
        operationId: "wechat.retry",
        responses: {
          200: {
            description: "Retry initiated",
            content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } },
          },
        },
      }),
      async (c) => {
        if (platform !== "wechat") return c.json({ success: false })
        const result = await WeChatManager.retry()
        await WeChatManager.setDesired(true)
        return c.json(result)
      },
    )
    .post(
      "/stop",
      describeRoute({
        summary: `Stop ${platform} bridge`,
        description: `Stop the ${platform} bridge service`,
        operationId: `${prefix}.stop`,
        responses: {
          200: {
            description: "Bridge stopped",
            content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } },
          },
        },
      }),
      async (c) => {
        await manager.setDesired(false)
        await manager.stop()
        return c.json({ success: true })
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: `Get ${platform} status`,
        description: `Get the current ${platform} bridge status`,
        operationId: `${prefix}.status`,
        responses: {
          200: {
            description: "Status",
            content: { "application/json": { schema: resolver(statusSchema) } },
          },
        },
      }),
      async (c) => {
        const enabled = await manager.desired()
        if (platform === "feishu") {
          const config = await FeishuManager.adapter.loadConfig()
          return c.json({
            status: FeishuManager.status,
            enabled,
            appId: FeishuManager.session?.appId || null,
            hasConfig: !!config,
            error: FeishuManager.error,
          })
        } else if (platform === "qq") {
          const config = await QQManager.adapter.loadConfig()
          return c.json({
            status: QQManager.status,
            enabled,
            appId: QQManager.session?.appId || null,
            hasConfig: !!config,
            error: QQManager.error,
          })
        } else {
          const session = await WeChatManager.adapter.loadSession()
          return c.json({
            status: WeChatManager.status,
            enabled,
            qrcode: WeChatManager.qrcode,
            user: WeChatManager.session?.user || session?.user || null,
            error: WeChatManager.error,
            hasConfig: !!session?.connected && !!session?.user,
          })
        }
      },
    )
    .get(
      "/events",
      describeRoute({
        summary: `Subscribe to ${platform} events`,
        description: `Get real-time ${platform} events via SSE`,
        operationId: `${prefix}.events`,
        responses: {
          200: {
            description: "Event stream",
            content: { "text/event-stream": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) => {
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamSSE(c, async (stream) => {
          const q = new AsyncQueue<string | null>()
          let done = false

          const initialProps: any = { status: manager.status }
          if (manager.status === "connected") {
            if (platform === "feishu" && FeishuManager.session?.appId) {
              initialProps.appId = FeishuManager.session.appId
            } else if (platform === "qq" && QQManager.session?.appId) {
              initialProps.appId = QQManager.session.appId
            } else if (platform === "wechat") {
              const session = await WeChatManager.adapter.loadSession()
              const user = WeChatManager.session?.user || session?.user
              if (user) initialProps.user = user
            }
          }
          q.push(JSON.stringify({ type: `${prefix}.status`, properties: initialProps }))

          if (platform === "wechat" && WeChatManager.status === "qrcode" && WeChatManager.qrcode) {
            q.push(JSON.stringify({ type: `${prefix}.qrcode`, properties: { image: WeChatManager.qrcode } }))
          }

          const heartbeat = setInterval(() => {
            q.push(JSON.stringify({ type: `${prefix}.heartbeat`, properties: {} }))
          }, 10_000)

          const unsub = Bus.subscribeAll((event) => {
            if (event.type.startsWith(`${prefix}.`)) {
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
        summary: `Clear ${platform} session`,
        description: `Clear the saved ${platform} configuration and session data`,
        operationId: `${prefix}.session.clear`,
        responses: {
          200: {
            description: "Session cleared",
            content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } },
          },
        },
      }),
      async (c) => {
        await manager.setDesired(false)
        await manager.clearSession()
        return c.json({ success: true })
      },
    )
}
