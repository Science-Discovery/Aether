import nodePath from "path"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
}
function getMimeType(filePath: string): string {
  const ext = nodePath.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] ?? "application/octet-stream"
}
const WEB_CACHE = "public, max-age=31536000, immutable"
const WEB_REVALIDATE = "no-cache"

function webEtag(size: number, mtimeMs: number) {
  return `W/"${size}-${mtimeMs}"`
}

function hashed(path: string) {
  return path.startsWith("/assets/") && /-[A-Za-z0-9_-]{8,}\./.test(nodePath.basename(path))
}

async function webHeaders(reqPath: string, filePath: string) {
  const stat = await Bun.file(filePath).stat()
  return {
    "content-type": getMimeType(filePath),
    "cache-control": hashed(reqPath) ? WEB_CACHE : WEB_REVALIDATE,
    etag: webEtag(Number(stat.size), stat.mtimeMs),
    "last-modified": stat.mtime.toUTCString(),
  }
}

async function webResponse(req: Request, reqPath: string, filePath: string) {
  const file = Bun.file(filePath)
  const headers = await webHeaders(reqPath, filePath)
  if (req.headers.get("if-none-match") === headers.etag) {
    return new Response(null, {
      status: 304,
      headers,
    })
  }
  return new Response(file, { headers })
}
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { createHash } from "node:crypto"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { proxy } from "hono/proxy"
import { basicAuth } from "hono/basic-auth"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { Command } from "../command"
import { Global } from "../global"
import { WorkspaceContext } from "../control-plane/workspace-context"
import { WorkspaceID } from "../control-plane/schema"
import { ProviderID } from "../provider/schema"
import { WorkspaceRouterMiddleware } from "../control-plane/workspace-router-middleware"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes, type ServerEnv } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { EventRoutes } from "./routes/event"
import { InstanceBootstrap } from "../project/bootstrap"
import { NotFoundError } from "../storage/db"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { Filesystem } from "@/util/filesystem"
import { Snapshot } from "@/snapshot"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { KnowledgeRoutes } from "./routes/knowledge"
import { WeChatRoutes } from "./routes/wechat"
import { FeishuRoutes } from "./routes/feishu"
import { ReadingModeRoutes } from "./routes/reading-mode"
import { DatabaseRoutes } from "./routes/database"
import { MDNS } from "./mdns"
import { lazy } from "@/util/lazy"
import { initProjectors } from "./projectors"
import { SessionPreference } from "@/session/preference"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

const web = process.env.AETHER_WEB_ORIGIN || process.env.OPENCODE_WEB_ORIGIN || "https://app.opencode.ai"

initProjectors()

export namespace Server {
  const log = Log.create({ service: "server" })

  export const Default = lazy(() => createApp({}))

  export const createApp = (opts: {
    cors?: string[]
    onBrowserConnectionChange?: (count: number) => void
  }): Hono<ServerEnv> => {
    SessionPreference.clear()
    const app = new Hono<ServerEnv>()
    let sseConnectionCount = 0
    const corsware = cors({
      credentials: true,
      origin(input) {
        if (!input) return
        if (input.startsWith("http://localhost:")) return input
        if (input.startsWith("http://127.0.0.1:")) return input
        if (
          input === "tauri://localhost" ||
          input === "http://tauri.localhost" ||
          input === "https://tauri.localhost"
        ) {
          return input
        }
        if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
          return input
        }
        if (opts?.cors?.includes(input)) {
          return input
        }
      },
    })
    return app
      .onError((err, c) => {
        log.error("failed", {
          error: err,
        })
        if (err instanceof NamedError) {
          let status: ContentfulStatusCode
          if (err instanceof NotFoundError) status = 404
          else if (err instanceof Provider.ModelNotFoundError) status = 400
          else if (err.name === "ProviderAuthValidationFailed") status = 400
          else if (err.name.startsWith("Worktree")) status = 400
          else status = 500
          return c.json(err.toObject(), { status })
        }
        if (err instanceof HTTPException) return err.getResponse()
        const message = err instanceof Error && err.stack ? err.stack : err.toString()
        return c.json(new NamedError.Unknown({ message }).toObject(), {
          status: 500,
        })
      })
      .use((c, next) => {
        // Allow CORS preflight requests to succeed without auth.
        // Browser clients sending Authorization headers will preflight with OPTIONS.
        if (c.req.method === "OPTIONS") return next()
        const password = Flag.OPENCODE_SERVER_PASSWORD
        if (!password) return next()
        const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
        return basicAuth({ username, password })(c, next)
      })
      .use(async (c, next) => {
        const skipLogging = c.req.path === "/log"
        if (!skipLogging) {
          log.info("request", {
            method: c.req.method,
            path: c.req.path,
          })
        }
        const timer = log.time("request", {
          method: c.req.method,
          path: c.req.path,
        })
        await next()
        if (!skipLogging) {
          timer.stop()
        }
      })
      .use((c, next) => {
        if (c.req.path === "/file/raw") {
          c.set("cors", opts.cors)
          return next()
        }
        return corsware(c, next)
      })
      .route("/global", GlobalRoutes())
      .put(
        "/auth/:providerID",
        describeRoute({
          summary: "Set auth credentials",
          description: "Set authentication credentials",
          operationId: "auth.set",
          responses: {
            200: {
              description: "Successfully set authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        validator("json", Auth.Info.zod),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const info = c.req.valid("json")
          await Auth.set(providerID, info)
          return c.json(true)
        },
      )
      .delete(
        "/auth/:providerID",
        describeRoute({
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
          operationId: "auth.remove",
          responses: {
            200: {
              description: "Successfully removed authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          await Auth.remove(providerID)
          return c.json(true)
        },
      )
      .use(async (c, next) => {
        if (c.req.path === "/log") return next()
        const rawWorkspaceID = c.req.query("workspace") || c.req.header("x-opencode-workspace")
        const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
        const directory = Filesystem.resolve(
          (() => {
            try {
              return decodeURIComponent(raw)
            } catch {
              return raw
            }
          })(),
        )

        return WorkspaceContext.provide({
          workspaceID: rawWorkspaceID ? WorkspaceID.make(rawWorkspaceID) : undefined,
          async fn() {
            return Instance.provide({
              directory,
              init: InstanceBootstrap,
              async fn() {
                return next()
              },
            })
          },
        })
      })
      .use(WorkspaceRouterMiddleware)
      .get(
        "/doc",
        openAPIRouteHandler(app, {
          documentation: {
            info: {
              title: "opencode",
              version: "0.0.3",
              description: "opencode api",
            },
            openapi: "3.1.1",
          },
        }),
      )
      .use(
        validator(
          "query",
          z.object({
            directory: z.string().optional(),
            workspace: z.string().optional(),
          }),
        ),
      )
      .route("/project", ProjectRoutes())
      .route("/pty", PtyRoutes())
      .route("/config", ConfigRoutes())
      .route("/experimental", ExperimentalRoutes())
      .route("/session", SessionRoutes())
      .route("/permission", PermissionRoutes())
      .route("/question", QuestionRoutes())
      .route("/provider", ProviderRoutes())
      .route("/database", DatabaseRoutes())
      .route("/", FileRoutes())
      .route("/", EventRoutes())
      .route("/mcp", McpRoutes())
      .route("/tui", TuiRoutes())
      .route("/knowledge", KnowledgeRoutes())
      .route("/wechat", WeChatRoutes())
      .route("/feishu", FeishuRoutes())
      .route("/reading-mode", ReadingModeRoutes())
      .post(
        "/instance/dispose",
        describeRoute({
          summary: "Dispose instance",
          description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          operationId: "instance.dispose",
          responses: {
            200: {
              description: "Instance disposed",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
          },
        }),
        async (c) => {
          await Instance.dispose()
          return c.json(true)
        },
      )
      .get(
        "/path",
        describeRoute({
          summary: "Get paths",
          description: "Retrieve the current working directory and related path information for the OpenCode instance.",
          operationId: "path.get",
          responses: {
            200: {
              description: "Path",
              content: {
                "application/json": {
                  schema: resolver(
                    z
                      .object({
                        home: z.string(),
                        state: z.string(),
                        config: z.string(),
                        worktree: z.string(),
                        directory: z.string(),
                      })
                      .meta({
                        ref: "Path",
                      }),
                  ),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json({
            home: process.platform === "win32" ? "/" : Global.Path.home,
            state: Global.Path.state,
            config: Global.Path.config,
            worktree: Instance.worktree,
            directory: Instance.directory,
          })
        },
      )
      .get(
        "/vcs",
        describeRoute({
          summary: "Get VCS info",
          description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
          operationId: "vcs.get",
          responses: {
            200: {
              description: "VCS info",
              content: {
                "application/json": {
                  schema: resolver(Vcs.Info),
                },
              },
            },
          },
        }),
        async (c) => {
          const [branch, default_branch] = await Promise.all([Vcs.branch(), Vcs.defaultBranch()])
          return c.json({
            branch,
            default_branch,
          })
        },
      )
      .get(
        "/vcs/diff",
        describeRoute({
          summary: "Get VCS diff",
          description: "Retrieve the current git diff for the working tree or against the default branch.",
          operationId: "vcs.diff",
          responses: {
            200: {
              description: "VCS diff",
              content: {
                "application/json": {
                  schema: resolver(Snapshot.FileDiff.array()),
                },
              },
            },
          },
        }),
        validator(
          "query",
          z.object({
            mode: Vcs.Mode,
          }),
        ),
        async (c) => {
          return c.json(await Vcs.diff(c.req.valid("query").mode))
        },
      )
      .get(
        "/command",
        describeRoute({
          summary: "List commands",
          description: "Get a list of all available commands in the OpenCode system.",
          operationId: "command.list",
          responses: {
            200: {
              description: "List of commands",
              content: {
                "application/json": {
                  schema: resolver(Command.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const commands = await Command.list()
          return c.json(commands)
        },
      )
      .post(
        "/log",
        describeRoute({
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
          operationId: "app.log",
          responses: {
            200: {
              description: "Log entry written successfully",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            service: z.string().meta({ description: "Service name for the log entry" }),
            level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
            message: z.string().meta({ description: "Log message" }),
            extra: z
              .record(z.string(), z.any())
              .optional()
              .meta({ description: "Additional metadata for the log entry" }),
          }),
        ),
        async (c) => {
          const { service, level, message, extra } = c.req.valid("json")
          const logger = Log.create({ service })

          switch (level) {
            case "debug":
              logger.debug(message, extra)
              break
            case "info":
              logger.info(message, extra)
              break
            case "error":
              logger.error(message, extra)
              break
            case "warn":
              logger.warn(message, extra)
              break
          }

          return c.json(true)
        },
      )
      .get(
        "/agent",
        describeRoute({
          summary: "List agents",
          description: "Get a list of all available AI agents in the OpenCode system.",
          operationId: "app.agents",
          responses: {
            200: {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: resolver(Agent.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const modes = await Agent.list()
          return c.json(modes)
        },
      )
      .get(
        "/skill",
        describeRoute({
          summary: "List skills",
          description: "Get a list of all available skills in the OpenCode system.",
          operationId: "app.skills",
          responses: {
            200: {
              description: "List of skills",
              content: {
                "application/json": {
                  schema: resolver(Skill.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const skills = await Skill.all()
          return c.json(skills)
        },
      )
      .get(
        "/lsp",
        describeRoute({
          summary: "Get LSP status",
          description: "Get LSP server status",
          operationId: "lsp.status",
          responses: {
            200: {
              description: "LSP server status",
              content: {
                "application/json": {
                  schema: resolver(LSP.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await LSP.status())
        },
      )
      .get(
        "/formatter",
        describeRoute({
          summary: "Get formatter status",
          description: "Get formatter status",
          operationId: "formatter.status",
          responses: {
            200: {
              description: "Formatter status",
              content: {
                "application/json": {
                  schema: resolver(Format.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await Format.status())
        },
      )
      .get(
        "/event",
        describeRoute({
          summary: "Subscribe to events",
          description: "Get events",
          operationId: "event.subscribe",
          responses: {
            200: {
              description: "Event stream",
              content: {
                "text/event-stream": {
                  schema: resolver(BusEvent.payloads()),
                },
              },
            },
          },
        }),
        async (c) => {
          log.info("event connected")
          c.header("X-Accel-Buffering", "no")
          c.header("X-Content-Type-Options", "nosniff")
          sseConnectionCount++
          opts.onBrowserConnectionChange?.(sseConnectionCount)
          return streamSSE(c, async (stream) => {
            stream.writeSSE({
              data: JSON.stringify({
                type: "server.connected",
                properties: {},
              }),
            })
            const unsub = Bus.subscribeAll(async (event) => {
              await stream.writeSSE({
                data: JSON.stringify(event),
              })
              if (event.type === Bus.InstanceDisposed.type) {
                stream.close()
              }
            })

            // Track disconnection via either onAbort (immediate) or heartbeat
            // write failure (Bun only detects TCP close on next write attempt).
            let disconnected = false
            const onDisconnect = () => {
              if (disconnected) return
              disconnected = true
              sseConnectionCount--
              opts.onBrowserConnectionChange?.(sseConnectionCount)
            }

            // Heartbeat every 3s: keeps proxy streams alive and detects browser close.
            const heartbeat = setInterval(() => {
              stream
                .writeSSE({
                  data: JSON.stringify({
                    type: "server.heartbeat",
                    properties: {},
                  }),
                })
                .catch(() => {
                  clearInterval(heartbeat)
                  unsub()
                  onDisconnect()
                })
            }, 3_000)

            await new Promise<void>((resolve) => {
              stream.onAbort(() => {
                clearInterval(heartbeat)
                unsub()
                resolve()
                onDisconnect()
                log.info("event disconnected")
              })
            })
          })
        },
      )
      .all("/*", async (c) => {
        const reqPath = c.req.path

        // Serve local web assets if available (next to the binary)
        const webDir = nodePath.join(nodePath.dirname(process.execPath), "web")
        const localFilePath = nodePath.join(webDir, reqPath === "/" ? "index.html" : reqPath)
        const localFile = Bun.file(localFilePath)
        if (await localFile.exists()) {
          return webResponse(c.req.raw, reqPath, localFilePath)
        }
        // SPA fallback: serve index.html for unknown paths
        const indexPath = nodePath.join(webDir, "index.html")
        const indexFile = Bun.file(indexPath)
        if (await indexFile.exists()) {
          return webResponse(c.req.raw, "/", indexPath)
        }

        // Fall back to remote proxy
        const remote = new URL(reqPath, web)
        const response = await proxy(remote.toString(), {
          ...c.req,
          headers: {
            ...c.req.raw.headers,
            host: remote.host,
          },
        })
        const match = response.headers.get("content-type")?.includes("text/html")
          ? (await response.clone().text()).match(
              /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
            )
          : undefined
        const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
        response.headers.set("Content-Security-Policy", csp(hash))
        return response
      })
  }

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(Default(), {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  /** @deprecated do not use this dumb shit */
  export let url: URL

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
    onBrowserConnectionChange?: (count: number) => void
  }) {
    const app = createApp(opts)
    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: app.fetch,
      websocket: websocket,
      // Raise body limit to 1 GB to support large PDF uploads (default is 128 MB)
      maxRequestBodySize: 1024 * 1024 * 1024,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port, reusePort: true })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    url = new URL(`http://${opts.hostname}:${server.port}`)

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        server
          .stop(true)
          .catch(() => {})
          .then(() => process.exit(0))
      })
    }

    return server
  }
}
