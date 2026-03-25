import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"

const log = Log.create({ service: "server" })

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

const ProxyTarget = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
})

const ProxyConfig = z.object({
  enabled: z.boolean(),
  http: ProxyTarget,
  https: ProxyTarget,
})

function parseProxy(value?: string) {
  if (!value) return { host: "", port: 8080 }
  try {
    const url = new URL(value)
    const port = Number.parseInt(url.port, 10)
    return {
      host: url.hostname,
      port: Number.isInteger(port) ? port : 8080,
    }
  } catch {
    return { host: "", port: 8080 }
  }
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/proxy",
      describeRoute({
        summary: "Get proxy configuration",
        description: "Get current process-level HTTP/HTTPS proxy configuration.",
        operationId: "global.proxy.get",
        responses: {
          200: {
            description: "Proxy config",
            content: {
              "application/json": {
                schema: resolver(ProxyConfig),
              },
            },
          },
        },
      }),
      async (c) => {
        const http = parseProxy(process.env.HTTP_PROXY ?? process.env.http_proxy)
        const https = parseProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy)
        return c.json({
          enabled: !!(http.host || https.host),
          http,
          https,
        })
      },
    )
    .patch(
      "/proxy",
      describeRoute({
        summary: "Update proxy configuration",
        description: "Update process-level HTTP/HTTPS proxy configuration.",
        operationId: "global.proxy.update",
        responses: {
          200: {
            description: "Updated proxy config",
            content: {
              "application/json": {
                schema: resolver(ProxyConfig),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", ProxyConfig),
      async (c) => {
        const config = c.req.valid("json")
        if (!config.enabled) {
          delete process.env.HTTP_PROXY
          delete process.env.HTTPS_PROXY
          delete process.env.http_proxy
          delete process.env.https_proxy
          return c.json(config)
        }
        const http = config.http.host.trim() ? `http://${config.http.host.trim()}:${config.http.port}` : ""
        const https = config.https.host.trim() ? `https://${config.https.host.trim()}:${config.https.port}` : ""
        if (!http && !https) return c.json({ error: "Proxy host is required for HTTP or HTTPS" }, 400)
        const httpValue = http || https
        const httpsValue = https || http
        process.env.HTTP_PROXY = httpValue
        process.env.HTTPS_PROXY = httpsValue
        process.env.http_proxy = httpValue
        process.env.https_proxy = httpsValue
        return c.json({
          ...config,
          http: {
            ...config.http,
            host: config.http.host.trim(),
          },
          https: {
            ...config.https,
            host: config.https.host.trim(),
          },
        })
      },
    )
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.VERSION })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamSSE(c, async (stream) => {
          const q = new AsyncQueue<string | null>()
          let done = false

          q.push(
            JSON.stringify({
              payload: {
                type: "server.connected",
                properties: {},
              },
            }),
          )

          // Send heartbeat every 10s to prevent stalled proxy streams.
          const heartbeat = setInterval(() => {
            q.push(
              JSON.stringify({
                payload: {
                  type: "server.heartbeat",
                  properties: {},
                },
              }),
            )
          }, 10_000)

          async function handler(event: any) {
            q.push(JSON.stringify(event))
          }
          GlobalBus.on("event", handler)

          const stop = () => {
            if (done) return
            done = true
            clearInterval(heartbeat)
            GlobalBus.off("event", handler)
            q.push(null)
            log.info("event disconnected")
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
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const next = await Config.updateGlobal(config)
        return c.json(next)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    ),
)
