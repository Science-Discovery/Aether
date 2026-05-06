import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Installation } from "@/installation"
import { Instance } from "../../project/instance"
import { Flag } from "../../flag/flag"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"
import { Lease } from "../lease"
import {
  downloadWebUpdate,
  installWebUpdate,
  readWebCurrentVersion,
  retryWebUpdateMirror,
  WebUpdateCheckInput,
  WebUpdateCheckResponse,
  WebUpdateCommandResponse,
  WebUpdateDownloadInput,
  WebUpdateDownloadResponse,
  WebUpdateInstallInput,
  WebUpdateMirrorInput,
  webCheck,
} from "../web-update"

export { WebUpdateTest } from "../web-update"

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

const PingInput = z.object({
  id: z.string().min(1),
  alive: z.boolean().optional(),
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

function keepLoopbackNoProxy(value?: string) {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (items.some((item) => item.toLowerCase() === host)) continue
    items.push(host)
  }
  return items.join(",")
}

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
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

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsub()
      q.push(null)
      log.info("global event disconnected")
    }

    const unsub = subscribe(q)

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
        const all = parseProxy(process.env.ALL_PROXY ?? process.env.all_proxy)
        const http = parseProxy(process.env.HTTP_PROXY ?? process.env.http_proxy)
        const https = parseProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy)
        return c.json({
          enabled: !!(http.host || https.host || all.host),
          http: http.host ? http : all,
          https: https.host ? https : all,
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
          delete process.env.ALL_PROXY
          delete process.env.http_proxy
          delete process.env.https_proxy
          delete process.env.all_proxy
          log.info("proxy updated", { enabled: false })
          return c.json(config)
        }
        const http = config.http.host.trim() ? `http://${config.http.host.trim()}:${config.http.port}` : ""
        const https = config.https.host.trim() ? `http://${config.https.host.trim()}:${config.https.port}` : ""
        if (!http && !https) return c.json({ error: "Proxy host is required for HTTP or HTTPS" }, 400)
        const httpValue = http || https
        const httpsValue = https || http
        process.env.HTTP_PROXY = httpValue
        process.env.HTTPS_PROXY = httpsValue
        process.env.ALL_PROXY = httpsValue
        process.env.http_proxy = httpValue
        process.env.https_proxy = httpsValue
        process.env.all_proxy = httpsValue
        const noProxy = keepLoopbackNoProxy(process.env.NO_PROXY ?? process.env.no_proxy)
        process.env.NO_PROXY = noProxy
        process.env.no_proxy = noProxy
        log.info("proxy updated", {
          enabled: true,
          http_host: config.http.host.trim() || "-",
          http_port: config.http.port,
          https_host: config.https.host.trim() || "-",
          https_port: config.https.port,
          no_proxy: noProxy,
        })
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
        return c.json({ healthy: true, version: await readWebCurrentVersion() })
      },
    )
    .get(
      "/web-update/current",
      describeRoute({
        summary: "Get current web version",
        description: "Read the current web app version from local update state.",
        operationId: "global.web-update.current",
        responses: {
          200: {
            description: "Current local web version",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    currentVersion: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ currentVersion: await readWebCurrentVersion() })
      },
    )
    .post(
      "/ping",
      describeRoute({
        summary: "Ping lease",
        description: "Refresh or release browser lease for web auto-exit detection.",
        operationId: "global.ping",
        responses: {
          200: {
            description: "Lease touched",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.literal(true) })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", PingInput),
      async (c) => {
        const body = c.req.valid("json")
        if (body.alive === false) {
          Lease.drop(body.id)
          return c.json({ ok: true as const })
        }
        Lease.touch(body.id)
        return c.json({ ok: true as const })
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

        return streamEvents(c, (q) => {
          async function handler(event: any) {
            q.push(JSON.stringify(event))
          }
          GlobalBus.on("event", handler)
          return () => GlobalBus.off("event", handler)
        })
      },
    )
    .get(
      "/sync-event",
      describeRoute({
        summary: "Subscribe to global sync events",
        description: "Get global sync events",
        operationId: "global.sync-event.subscribe",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      payload: SyncEvent.payloads(),
                    })
                    .meta({
                      ref: "SyncEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global sync event connected")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamEvents(c, (q) => {
          return SyncEvent.subscribeAll(({ def, event }) => {
            // TODO: don't pass def, just pass the type (and it should
            // be versioned)
            q.push(
              JSON.stringify({
                payload: {
                  ...event,
                  type: SyncEvent.versionedType(def.type, def.version),
                },
              }),
            )
          })
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
    )
    .get(
      "/web-update/check",
      describeRoute({
        summary: "Check web update",
        description: "Check for available web application updates by fetching remote version metadata.",
        operationId: "global.web-update.check",
        responses: {
          200: {
            description: "Version check result",
            content: {
              "application/json": {
                schema: resolver(WebUpdateCheckResponse),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const os = c.req.query("os")
        const parsed = WebUpdateCheckInput.safeParse(os)
        if (!parsed.success) {
          return c.json({ error: "Invalid or missing 'os' query parameter. Expected: darwin, linux, or windows" }, 400)
        }
        return c.json(await webCheck(parsed.data))
      },
    )
    .post(
      "/web-update/download",
      describeRoute({
        summary: "Download web update script",
        description: "Download the update/install script for the specified OS and version.",
        operationId: "global.web-update.download",
        responses: {
          200: {
            description: "Download result",
            content: {
              "application/json": {
                schema: resolver(WebUpdateDownloadResponse),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", WebUpdateDownloadInput),
      async (c) => c.json(await downloadWebUpdate(c.req.valid("json"))),
    )
    .post(
      "/web-update/install",
      describeRoute({
        summary: "Execute web update script",
        description: "Execute the previously downloaded update script to install the new version.",
        operationId: "global.web-update.install",
        responses: {
          200: {
            description: "Install result",
            content: {
              "application/json": {
                schema: resolver(WebUpdateCommandResponse),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", WebUpdateInstallInput),
      async (c) => c.json(await installWebUpdate(c.req.valid("json"))),
    )
    .post(
      "/web-update/mirror",
      describeRoute({
        summary: "Retry web update mirror",
        description: "Retry only the mirror step for a failed web update install.",
        operationId: "global.web-update.mirror",
        responses: {
          200: {
            description: "Mirror retry result",
            content: {
              "application/json": {
                schema: resolver(WebUpdateCommandResponse),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", WebUpdateMirrorInput),
      async (c) => c.json(await retryWebUpdateMirror(c.req.valid("json"))),
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade opencode",
        description: "Upgrade opencode to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        if (Flag.OPENCODE_DISABLE_AUTOUPDATE) return c.json({ success: false, error: "Auto-update is disabled" }, 400)
        const method = await Installation.method()
        if (method === "unknown") {
          return c.json({ success: false, error: "Unknown installation method" }, 400)
        }
        const target = c.req.valid("json").target || (await Installation.latest(method))
        const result = await Installation.upgrade(method, target)
          .then(() => ({ success: true as const, version: target }))
          .catch((e) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
        if (result.success) {
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: Installation.Event.Updated.type,
              properties: { version: target },
            },
          })
          return c.json(result)
        }
        return c.json(result, 500)
      },
    ),
)
