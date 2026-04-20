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

function basePath() {
  const raw = process.env.VITE_BASE_PATH?.trim()
  if (!raw) return "/"
  if (raw === "." || raw === "./") return "/"
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return "/"
  if (/[?#\s"'<>]/.test(raw)) return "/"
  const base = raw.startsWith("/") ? raw : `/${raw}`
  return base.replace(/\/+$/, "") || "/"
}

function baseHref(base: string) {
  return base === "/" ? "/" : `${base}/`
}

function baseStrip(path: string, base: string) {
  if (base === "/") return path
  if (path === base || path === `${base}/`) return "/"
  if (path.startsWith(`${base}/`)) return path.slice(base.length)
  return undefined
}

function baseInject(html: string, base: string) {
  const tag = `<base href="${baseHref(base)}"><script>globalThis.__AETHER_BASE_PATH__=${JSON.stringify(base)}</script>`
  return html.includes("<head>") ? html.replace("<head>", `<head>${tag}`) : `${tag}${html}`
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

async function webIndex(req: Request, reqPath: string, filePath: string, base: string) {
  const file = Bun.file(filePath)
  const stat = await file.stat()
  const html = baseInject(await file.text(), base)
  const headers = {
    "content-type": getMimeType(filePath),
    "cache-control": WEB_REVALIDATE,
    etag: webEtag(new TextEncoder().encode(html).byteLength, stat.mtimeMs),
    "last-modified": stat.mtime.toUTCString(),
  }
  if (req.headers.get("if-none-match") === headers.etag) {
    return new Response(null, {
      status: 304,
      headers,
    })
  }
  return new Response(html, { headers })
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
import { Project } from "../project/project"
import { ProjectID } from "../project/schema"
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
import { createMobileRoutes } from "@/mobile/route"
import { FeishuManager } from "@/mobile/feishu"
import { QQManager } from "@/mobile/qq"
import { WeChatManager } from "@/mobile/wechat"
import { ReadingModeRoutes } from "./routes/reading-mode"
import { DatabaseRoutes } from "./routes/database"
import { CronRoutes } from "./routes/cron"
import { MemoryRoutes } from "./routes/memory"
import { VoiceRoutes } from "./routes/voice"
import { MDNS } from "./mdns"
import { lazy } from "@/util/lazy"
import { initProjectors } from "./projectors"
import { SessionPreference } from "@/session/preference"
import { Cron } from "@/cron"
import { Memory } from "@/memory"
import { installMemory, registerMemoryDirectActions } from "@/memory/installer"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

const NO_AUTH_PATHS = new Set([
  "/site.webmanifest",
  "/favicon-96x96-v3.png",
  "/favicon-v3.svg",
  "/favicon-v3.ico",
  "/apple-touch-icon-v3.png",
  "/oc-theme-preload.js",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
  "/web-app-manifest-192x192-maskable.png",
  "/web-app-manifest-512x512-maskable.png",
  "/social-share.png",
])

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
    registerMemoryDirectActions()
    void Cron.start().catch((error) => {
      log.error("cron start failed", { error })
    })
    void installMemory().catch((error) => {
      log.error("memory install failed", { error })
    })
    const app = new Hono<ServerEnv>()
    const corsware = cors({
      credentials: true,
      origin(input) {
        if (!input) return
        if (input === "null") return input
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
        // WebSocket upgrade requests can't set Authorization headers in the browser.
        // When deployed behind a reverse proxy, URL-embedded credentials (user:pass@host)
        // are not forwarded. Instead, the client sends a "token" query parameter containing
        // base64(username:password), which we convert to an Authorization header here
        // so that basicAuth middleware can validate it normally.
        const token = c.req.query("token")
        if (token && !c.req.header("Authorization")) {
          c.req.raw.headers.set("Authorization", `Basic ${token}`)
        }
        return next()
      })
      .use((c, next) => {
        // Allow CORS preflight requests to succeed without auth.
        // Browser clients sending Authorization headers will preflight with OPTIONS.
        if (c.req.method === "OPTIONS") return next()
        // PWA manifest, favicons, and theme preload are fetched by the browser
        // automatically without Authorization headers. Exempt them from basicAuth
        // since they contain no sensitive data.
        if (NO_AUTH_PATHS.has(c.req.path)) return next()
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
        const raw = c.req.query("directory") || c.req.header("x-opencode-directory")
        const noDirectory = !raw
        const decoded = (() => {
          try {
            return decodeURIComponent(raw ?? "")
          } catch {
            return raw ?? ""
          }
        })()
        const directory = Filesystem.resolve(decoded)

        const browsePaths = ["/file", "/find", "/file/pick-folder", "/file/check-directory", "/file/ensure-directory"]
        const isBrowse = browsePaths.some(
          (p) => c.req.path === p || c.req.path.startsWith(p + "/") || c.req.path.startsWith(p + "?"),
        )
        const create = noDirectory ? false : isBrowse ? Instance.has(directory) : true

        return WorkspaceContext.provide({
          workspaceID: rawWorkspaceID ? WorkspaceID.make(rawWorkspaceID) : undefined,
          async fn() {
            return Instance.provide({
              directory,
              create,
              init: create ? InstanceBootstrap : undefined,
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
      .post(
        "/project-directory-meta",
        describeRoute({
          summary: "Update directory metadata",
          description:
            "Update name and icon for a plain directory (no git project entry). Persisted in project_recent table.",
          operationId: "project.updateDirectoryMeta",
          responses: {
            200: {
              description: "Updated directory metadata",
              content: {
                "application/json": {
                  schema: resolver(Project.RecentInfo),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            directory: z.string(),
            name: z.string().optional(),
            projectID: z.string().optional(),
            icon: z
              .object({
                url: z.string().optional(),
                override: z.string().optional(),
                color: z.string().optional(),
              })
              .optional(),
          }),
        ),
        async (c) => {
          const body = c.req.valid("json")
          await Project.updateDirectoryMeta({ ...body, projectID: body.projectID as ProjectID | undefined })
          const item = Project.recentFromDir(body.directory)
          if (!item) return c.json(null, 404)
          return c.json(item)
        },
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
      .route("/", EventRoutes(opts.onBrowserConnectionChange))
      .route("/mcp", McpRoutes())
      .route("/tui", TuiRoutes())
      .route("/knowledge", KnowledgeRoutes())
      .route("/cron", CronRoutes())
      .route("/memory", MemoryRoutes())
      .route("/voice", VoiceRoutes())
      .route("/mobile/wechat", createMobileRoutes("wechat"))
      .route("/mobile/feishu", createMobileRoutes("feishu"))
      .route("/mobile/qq", createMobileRoutes("qq"))
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
            home: Global.Path.home,
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
        "/vcs/graph",
        describeRoute({
          summary: "Get VCS graph data",
          description: "Retrieve git log and refs data for rendering the git graph visualization.",
          operationId: "vcs.graph",
          responses: {
            200: {
              description: "VCS graph data",
              content: {
                "application/json": {
                  schema: resolver(Vcs.GraphResult),
                },
              },
            },
          },
        }),
        validator(
          "query",
          z.object({
            max: z.coerce.number().optional(),
            branch: z.string().optional(),
            skip: z.coerce.number().optional(),
          }),
        ),
        async (c) => {
          const query = c.req.valid("query")
          return c.json(
            await Vcs.graph({
              max: query.max,
              branch: query.branch,
              skip: query.skip,
            }),
          )
        },
      )
      .post(
        "/vcs/checkout",
        describeRoute({
          summary: "Switch git branch",
          description: "Switch the current git branch to the specified branch name.",
          operationId: "vcs.checkout",
          responses: {
            200: {
              description: "Checkout result",
              content: {
                "application/json": {
                  schema: resolver(Vcs.CheckoutResult),
                },
              },
            },
          },
        }),
        validator("json", z.object({ branch: z.string() })),
        async (c) => {
          const input = c.req.valid("json")
          const result = await Vcs.checkout(input.branch)
          return c.json(result)
        },
      )
      .post(
        "/vcs/rename-branch",
        describeRoute({
          summary: "Rename git branch",
          description: "Rename the current git branch to a new name.",
          operationId: "vcs.renameBranch",
          responses: {
            200: {
              description: "Rename result",
              content: {
                "application/json": {
                  schema: resolver(Vcs.RenameBranchResult),
                },
              },
            },
          },
        }),
        validator("json", z.object({ newName: z.string() })),
        async (c) => {
          const input = c.req.valid("json")
          const result = await Vcs.renameBranch(input.newName)
          return c.json(result)
        },
      )
      .get(
        "/vcs/commit/:hash",
        describeRoute({
          summary: "Get commit details",
          description:
            "Retrieve detailed information about a specific git commit, including metadata and file changes.",
          operationId: "vcs.commitDetail",
          responses: {
            200: {
              description: "Commit details",
              content: {
                "application/json": {
                  schema: resolver(Vcs.CommitDetail),
                },
              },
            },
          },
        }),
        validator(
          "param",
          z.object({
            hash: z.string(),
          }),
        ),
        async (c) => {
          const { hash } = c.req.valid("param")
          return c.json(await Vcs.commitDetails(hash))
        },
      )
      .get(
        "/vcs/file",
        describeRoute({
          summary: "Get file content at commit",
          description: "Retrieve the content of a specific file at a given git commit.",
          operationId: "vcs.fileContent",
          responses: {
            200: {
              description: "File content",
              content: {
                "application/json": {
                  schema: resolver(z.object({ content: z.string() })),
                },
              },
            },
          },
        }),
        validator(
          "query",
          z.object({
            hash: z.string(),
            path: z.string(),
          }),
        ),
        async (c) => {
          const { hash, path } = c.req.valid("query")
          const content = await Vcs.fileContent(hash, path)
          return c.json({ content })
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
      .all("/*", async (c) => {
        const reqPath = c.req.path
        const base = basePath()

        // Redirect root or bare base path to base path with trailing slash
        if (base !== "/" && (reqPath === "/" || reqPath === base)) {
          return c.redirect(baseHref(base))
        }

        // Resolve local file path: strip base prefix if present, otherwise use path directly
        const localPath = baseStrip(reqPath, base) ?? reqPath

        // Serve local web assets if available (next to the binary)
        const webDir = nodePath.join(nodePath.dirname(process.execPath), "web")
        const indexPath = nodePath.join(webDir, "index.html")
        const indexFile = Bun.file(indexPath)
        const filePath = nodePath.join(webDir, localPath === "/" ? "index.html" : localPath)
        const localFile = Bun.file(filePath)
        if (await localFile.exists()) {
          if (nodePath.basename(filePath) === "index.html") return webIndex(c.req.raw, localPath, filePath, base)
          return webResponse(c.req.raw, localPath, filePath)
        }
        // SPA fallback: serve index.html for unknown paths
        if (await indexFile.exists()) {
          return webIndex(c.req.raw, "/", indexPath, base)
        }

        // Fall back to remote proxy
        const remote = new URL(localPath, web)
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
    const bp = basePath()
    const root = bp === "/" ? app : new Hono<ServerEnv>().route(bp, app).route("/", app)
    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: root.fetch,
      websocket: websocket,
      // Raise body limit to 1 GB to support large PDF uploads (default is 128 MB)
      maxRequestBodySize: 1024 * 1024 * 1024,
    } as const
    const AETHER_PORT = 19527
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port, reusePort: true })
      } catch {
        return undefined
      }
    }
    const server =
      opts.port === 0
        ? (tryServe(AETHER_PORT) ??
          tryServe(AETHER_PORT + 1) ??
          tryServe(AETHER_PORT + 2) ??
          tryServe(AETHER_PORT + 3) ??
          tryServe(AETHER_PORT + 4) ??
          tryServe(0))
        : tryServe(opts.port)
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
        setTimeout(() => process.exit(0), 10_000).unref()
        Promise.all(
          [
            Instance.disposeAll(),
            Cron.stop(),
            Memory.stop(),
            FeishuManager.stop(),
            QQManager.stop(),
            WeChatManager.stop(),
          ].map((p) => p.catch(() => {})),
        )
          .then(() => server.stop(true).catch(() => {}))
          .then(() => process.exit(0))
      })
    }

    return server
  }
}
