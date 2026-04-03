import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { spawn } from "child_process"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"
import { Lease } from "../lease"

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

const WebUpdateOS = z.enum(["darwin", "linux", "windows"])

const WEB_UPDATE_BASE = "https://aether.aiphys.cn/download"

const INSTALLER_YML: Record<string, string> = {
  darwin: "latest/mac-arm64.yml",
  linux: "latest/linux-x64.yml",
  windows: "latest/windows-x64.yml",
}

const INSTALLER_SCRIPT: Record<string, string> = {
  darwin: "aether_darwin_installer.command",
  linux: "aether_linux_installer.sh",
  windows: "aether_windows_installer.bat",
}

const UPDATE_SCRIPT: Record<string, string> = {
  darwin: "update_darwin_web.command",
  linux: "update_linux_web.sh",
  windows: "update_windows_web.bat",
}

const UPDATE_PKG_EXT: Record<string, string> = {
  darwin: ".dmg",
  linux: ".zip",
  windows: ".zip",
}

async function downloadedReady(os: string, ver: string) {
  const script = await findInstallerScript(os)
  if (!script) return false
  const file = UPDATE_SCRIPT[os]
  if (!file) return false
  const ext = UPDATE_PKG_EXT[os] ?? ".dmg"
  const work = computeWorkDir(script)
  const dl = path.join(work, "downloads")
  const upd = path.join(dl, versioned(file, ver))
  try {
    await fs.access(upd)
  } catch {
    return false
  }
  const files = await fs.readdir(dl).catch(() => [])
  return files.some((x) => x.toLowerCase().endsWith(ext) && x.includes(ver))
}

function versioned(name: string, ver: string) {
  const idx = name.lastIndexOf(".")
  if (idx < 0) return `${name}-${ver}`
  return `${name.slice(0, idx)}-${ver}${name.slice(idx)}`
}

function compareVer(a: string, b: string) {
  const norm = (v: string) => v.replace(/^v/i, "").split("-")[0].split(".").map((x) => Number.parseInt(x || "0", 10) || 0)
  const x = norm(a)
  const y = norm(b)
  const len = Math.max(x.length, y.length, 3)
  for (let i = 0; i < len; i++) {
    const p = x[i] ?? 0
    const q = y[i] ?? 0
    if (p < q) return -1
    if (p > q) return 1
  }
  return 0
}

function getWorkDir(): string | null {
  const dir = getAppRoot()
  const base = path.basename(dir)
  if (base === "Aether") return dir
  if (!base.startsWith("aether_")) return null
  const root = path.dirname(dir)
  if (path.basename(root) !== "Aether") return null
  return root
}

async function findInstallerScript(os: string): Promise<string | null> {
  const name = INSTALLER_SCRIPT[os]
  if (!name) return null
  const dir = getWorkDir()
  if (!dir) return null
  const file = path.join(dir, name)
  try {
    await fs.access(file)
    return file
  } catch {
    return null
  }
}

function computeWorkDir(scriptPath: string): string {
  return path.dirname(path.resolve(scriptPath))
}

function getAppRoot(): string {
  return path.dirname(process.execPath)
}

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
        return c.json({ healthy: true, version: Installation.VERSION })
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
                schema: resolver(
                  z.object({
                    currentVersion: z.string(),
                    remoteVersion: z.string(),
                    updateAvailable: z.boolean(),
                    downloaded: z.boolean(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const os = c.req.query("os")
        if (!os || !WebUpdateOS.safeParse(os).success) {
          return c.json({ error: "Invalid or missing 'os' query parameter. Expected: darwin, linux, or windows" }, 400)
        }
        const ymlPath = INSTALLER_YML[os]
        const metaUrl = `${WEB_UPDATE_BASE}/${ymlPath}`
        try {
          const res = await fetch(metaUrl)
          if (!res.ok) {
            return c.json({ error: `Failed to fetch version metadata: ${res.status}` }, 400)
          }
          const text = await res.text()
          const match = text.match(/^version:\s*(.+)$/m)
          const remoteVersion = (match?.[1]?.trim() ?? "").replace(/^['"]|['"]$/g, "")
          if (!remoteVersion) {
            return c.json({ error: "Could not parse remote version from metadata" }, 400)
          }
          let currentVersion = ""
          try {
            const state = await fs.readFile(path.join(getAppRoot(), ".aether_web_version"), "utf-8")
            const ver = state.trim()
            if (ver) currentVersion = ver
          } catch {}
          if (!currentVersion) {
            try {
              const raw = await fs.readFile(path.resolve(process.cwd(), "packages/opencode/package.json"), "utf-8")
              const parsed = JSON.parse(raw)
              if (parsed && typeof parsed === "object" && typeof parsed.version === "string" && parsed.version.trim()) {
                currentVersion = parsed.version.trim()
              }
            } catch {}
          }
          if (!currentVersion) currentVersion = Installation.VERSION
          const updateAvailable = compareVer(currentVersion, remoteVersion) < 0
          const downloaded = updateAvailable ? await downloadedReady(os, remoteVersion) : false
          return c.json({
            currentVersion,
            remoteVersion,
            updateAvailable,
            downloaded,
          })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return c.json({ error: `Failed to check update: ${message}` }, 400)
        }
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
                schema: resolver(
                  z.union([
                    z.object({ success: z.literal(true), path: z.string() }),
                    z.object({ success: z.literal(false), error: z.string() }),
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
          os: WebUpdateOS,
          version: z.string().min(1),
        }),
      ),
      async (c) => {
        const { os, version } = c.req.valid("json")
        const scriptPath = await findInstallerScript(os)
        if (!scriptPath) {
          return c.json({ success: false as const, error: `Installer script not found for ${os}` })
        }
        const upd = UPDATE_SCRIPT[os]
        if (!upd) return c.json({ success: false as const, error: `Update script not configured for ${os}` })
        try {
          await fs.chmod(scriptPath, 0o755)
        } catch {}
        const workDir = computeWorkDir(scriptPath)
        if (await downloadedReady(os, version)) {
          return c.json({ success: true as const, path: path.join(workDir, "downloads", versioned(upd, version)) })
        }
        const currentVersion = (() => {
          try {
            const state = Bun.file(path.join(workDir, ".aether_web_version"))
            return state
              .text()
              .then((x) => x.trim())
              .catch(() => Installation.VERSION)
          } catch {
            return Promise.resolve(Installation.VERSION)
          }
        })()
        log.info("running installer auto mode", { os, script: scriptPath, version, workDir })
        try {
          const cur = await currentVersion
          if (compareVer(cur, version) >= 0) {
            return c.json({ success: false as const, error: "No upgrade needed" })
          }
          const exitCode = await new Promise<number>((resolve, reject) => {
            const cmd = os === "windows" ? "cmd" : "bash"
            const cmdArgs = os === "windows" ? ["/c", scriptPath, "auto", cur] : [scriptPath, "auto", cur]
            const child = spawn(cmd, cmdArgs, { cwd: workDir })
            child.on("close", (code: number | null) => resolve(code ?? 1))
            child.on("error", reject)
          })

          const dl = path.join(workDir, "downloads")
          const scriptInDownloads = path.join(dl, versioned(upd, version))
          try {
            await fs.access(scriptInDownloads)
          } catch {
            return c.json({ success: false as const, error: `Downloaded update script missing: ${scriptInDownloads}` })
          }
          try {
            await fs.chmod(scriptInDownloads, 0o755)
          } catch {}

          const pick = async () => {
            const files = await fs.readdir(dl)
            const ext = UPDATE_PKG_EXT[os] ?? ".dmg"
            const list = files.filter((x) => x.toLowerCase().endsWith(ext) && x.includes(version)).sort()
            if (list.length > 0) return path.join(dl, list[list.length - 1])
            const any = files.filter((x) => x.toLowerCase().endsWith(ext)).sort()
            if (any.length > 0) return path.join(dl, any[any.length - 1])
            return ""
          }
          const pkg = await pick()
          if (!pkg) return c.json({ success: false as const, error: `No dmg found in ${dl}` })
          log.info("installer auto result", { exitCode, workDir, script: scriptInDownloads, pkg })
          if (exitCode === 20) {
            return c.json({ success: false as const, error: "Already up to date" })
          }
          if (exitCode === 10) {
            return c.json({ success: true as const, path: scriptInDownloads, package: pkg })
          }
          return c.json({ success: false as const, error: `Installer exited with code ${exitCode}` })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return c.json({ success: false as const, error: `Download failed: ${message}` })
        }
      },
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
                schema: resolver(
                  z.union([
                    z.object({ success: z.literal(true) }),
                    z.object({ success: z.literal(false), error: z.string() }),
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
          os: WebUpdateOS,
          version: z.string().min(1).optional(),
        }),
      ),
      async (c) => {
        const { os, version } = c.req.valid("json")
        const scriptPath = await findInstallerScript(os)
        if (!scriptPath) {
          return c.json({ success: false as const, error: `Installer script not found for ${os}` })
        }
        const workDir = computeWorkDir(scriptPath)
        const file = UPDATE_SCRIPT[os]
        if (!file) return c.json({ success: false as const, error: `Update script not configured for ${os}` })
        const dl = path.join(workDir, "downloads")
        const upd = version ? path.join(dl, versioned(file, version)) : path.join(dl, file)
        let run = upd
        if (!version) {
          const files = await fs.readdir(dl).catch(() => [])
          const idx = file.lastIndexOf(".")
          const stem = idx < 0 ? file : file.slice(0, idx)
          const ext = idx < 0 ? "" : file.slice(idx)
          const prefix = `${stem}-`
          const list = files.filter((x) => x.startsWith(prefix) && x.endsWith(ext)).sort()
          if (list.length > 0) run = path.join(dl, list[list.length - 1])
        }
        try {
          await fs.access(run)
        } catch {
          return c.json({ success: false as const, error: `Update script not found: ${run}` })
        }
        try {
          await fs.chmod(run, 0o755)
        } catch {}
        log.info("launching update script", { os, updater: run, workDir, version })
        try {
          const args = version ? [run, version] : [run]
          if (os === "darwin" || os === "linux" || os === "windows") args.push("--restart")
          const child =
            os === "windows"
              ? spawn("cmd", ["/c", ...args], { detached: true, stdio: "ignore", cwd: path.join(workDir, "downloads") })
              : spawn("bash", args, { detached: true, stdio: "ignore", cwd: path.join(workDir, "downloads") })
          child.unref()
          return c.json({ success: true as const })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return c.json({ success: false as const, error: `Failed to execute update script: ${message}` })
        }
      },
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
