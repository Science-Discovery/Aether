import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "os"
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
const WebUpdateStatus = z.enum(["available", "downloading", "downloaded", "installing", "recovery"])
const WebUpdateState = z.object({
  status: z.enum(["downloading", "downloaded", "installing", "error"]),
  version: z.string().min(1),
  server: z.string().min(1),
  at: z.number().int(),
  error: z.string().optional(),
})

const WEB_UPDATE_BASE = "https://aether.aiphys.cn/download"
const UPDATE_PKG_PREFIX: Record<string, string> = {
  darwin: "aether-darwin",
  linux: "aether-linux-x64",
  windows: "aether-windows-x64",
}
const UPDATE_RUN = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
})()

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
  darwin: "update_darwin.command",
  linux: "update_linux.sh",
  windows: "update_windows.bat",
}

const UPDATE_PKG_EXT: Record<string, string> = {
  darwin: ".dmg",
  linux: ".zip",
  windows: ".zip",
}

function updateStatePath(work: string) {
  return path.join(work, "downloads", "web-update-state.json")
}

function updateState(version: string, status: z.infer<typeof WebUpdateState>["status"], error?: string) {
  return {
    version,
    status,
    server: UPDATE_RUN,
    at: Date.now(),
    ...(error?.trim() ? { error: error.trim() } : {}),
  }
}

async function readUpdateState(work: string) {
  try {
    const text = await fs.readFile(updateStatePath(work), "utf-8")
    const parsed = WebUpdateState.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

async function writeUpdateState(work: string, state: z.infer<typeof WebUpdateState>) {
  const file = updateStatePath(work)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
}

async function clearUpdateState(work: string) {
  await fs.rm(updateStatePath(work), { force: true }).catch(() => undefined)
}

function updateScriptPrefix(name: string) {
  const idx = name.lastIndexOf(".")
  return `${idx < 0 ? name : name.slice(0, idx)}-`
}

function packageMatch(os: string, ver: string, name: string) {
  const ext = UPDATE_PKG_EXT[os] ?? ".dmg"
  const prefix = UPDATE_PKG_PREFIX[os] ?? "aether"
  return name.startsWith(prefix) && name.includes(ver) && name.toLowerCase().endsWith(ext)
}

async function packagePath(os: string, ver: string, work: string) {
  const dl = path.join(work, "downloads")
  const files = await fs.readdir(dl).catch(() => [])
  const list = files.filter((x) => packageMatch(os, ver, x)).sort()
  if (list.length === 0) return ""
  return path.join(dl, list[list.length - 1])
}

async function downloadedReady(os: string, ver: string, work: string) {
  const file = UPDATE_SCRIPT[os]
  if (!file) return false
  const dl = path.join(work, "downloads")
  const upd = path.join(dl, versioned(file, ver))
  try {
    await fs.access(upd)
  } catch {
    return false
  }
  const pkg = await packagePath(os, ver, work)
  if (!pkg) return false
  try {
    await fs.access(pkg)
    return true
  } catch {
    return false
  }
}

async function resetUpdate(os: string, ver: string, work: string) {
  const dl = path.join(work, "downloads")
  const file = UPDATE_SCRIPT[os]
  const ext = UPDATE_PKG_EXT[os] ?? ".dmg"
  const prefix = UPDATE_PKG_PREFIX[os] ?? "aether"
  const files = await fs.readdir(dl).catch(() => [])
  const list = files.filter(
    (x) =>
      (x.startsWith(prefix) && x.toLowerCase().endsWith(ext)) ||
      (file ? x.startsWith(updateScriptPrefix(file)) && x.endsWith(path.extname(file)) : false) ||
      x === "last-result.yml" ||
      x === "web-update-state.json",
  )
  await Promise.all(list.map((x) => fs.rm(path.join(dl, x), { force: true }).catch(() => undefined)))
  await fs.rm(path.join(work, `.aether_${ver}.next`), { force: true, recursive: true }).catch(() => undefined)
  await fs.rm(path.join(work, `aether_${ver}`), { force: true, recursive: true }).catch(() => undefined)
  await clearUpdateState(work)
}

async function resolveUpdateStatus(os: z.infer<typeof WebUpdateOS>, ver: string, work: string) {
  const state = await readUpdateState(work)
  const ready = await downloadedReady(os, ver, work)
  if (!state) {
    if (ready) return { status: "downloaded" as const, error: "" }
    return { status: "available" as const, error: "" }
  }
  if (state.version !== ver) {
    return { status: "recovery" as const, error: "A previous update attempt targeted a different version. Restart the update from scratch." }
  }
  if (state.status === "downloaded") {
    if (ready) return { status: "downloaded" as const, error: state.error ?? "" }
    return { status: "recovery" as const, error: "Downloaded update files are incomplete. Restart the update from scratch." }
  }
  if (state.status === "downloading") {
    if (state.server === UPDATE_RUN) return { status: "downloading" as const, error: state.error ?? "" }
    return {
      status: "recovery" as const,
      error: state.error ?? "The previous download did not finish. Restart the update from scratch.",
    }
  }
  if (state.status === "installing") {
    if (state.server === UPDATE_RUN) return { status: "installing" as const, error: state.error ?? "" }
    return {
      status: "recovery" as const,
      error: state.error ?? "The previous install did not finish. Restart the update from scratch.",
    }
  }
  return {
    status: "recovery" as const,
    error: state.error ?? "The previous update failed. Restart the update from scratch.",
  }
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
  const base = path.basename(dir).toLowerCase()
  if (base === "aether") return dir
  if (!base.startsWith("aether_")) return null
  const root = path.dirname(dir)
  if (path.basename(root).toLowerCase() !== "aether") return null
  return root
}

function getFallbackWorkDir(os: string): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  if (!home) return null
  if (os === "darwin") return path.join(home, "Applications", "aether")
  if (os === "linux") return path.join(home, ".local", "share", "applications", "aether")
  if (os === "windows") {
    const base = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    return path.join(base, "Programs", "aether")
  }
  return null
}

function resolveWorkDir(os: string): { path: string; isFallback: boolean } | null {
  const current = getWorkDir()
  if (current) return { path: current, isFallback: false }
  const fb = getFallbackWorkDir(os)
  if (!fb) return null
  return { path: fb, isFallback: true }
}

async function fetchInstallerScript(os: string): Promise<string | null> {
  const name = INSTALLER_SCRIPT[os]
  if (!name) return null
  const url = `${WEB_UPDATE_BASE}/installer/${name}`
  const dest = path.join(tmpdir(), `aether-installer-${name}`)
  try {
    const res = await fetch(url)
    if (!res.ok) {
      log.error("failed to fetch installer script", { url, status: res.status })
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(dest, buf)
    if (os !== "windows") {
      await fs.chmod(dest, 0o755).catch(() => undefined)
    }
    return dest
  } catch (e) {
    log.error("error fetching installer script", { url, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

function getAppRoot(): string {
  return path.dirname(process.execPath)
}

async function readWebCurrentVersion() {
  const file = path.join(getAppRoot(), ".aether_web_version")
  const read = () =>
    fs
      .readFile(file, "utf-8")
      .then((x) => x.trim())
      .catch(() => "")

  const cached = await read()
  if (cached) return cached
  const fallback = Installation.VERSION
  await fs.writeFile(file, `${fallback}\n`, "utf-8").catch(() => undefined)
  const next = await read()
  return next || fallback
}

async function webCheck(os: z.infer<typeof WebUpdateOS>) {
  const currentVersion = await readWebCurrentVersion()
  const resolved = resolveWorkDir(os)
  const workDir = resolved?.path ?? ""
  const workDirFallback = resolved?.isFallback ?? false
  const ymlPath = INSTALLER_YML[os]
  const metaUrl = `${WEB_UPDATE_BASE}/${ymlPath}`
  try {
    const res = await fetch(metaUrl)
    if (!res.ok) {
      return {
        currentVersion,
        remoteVersion: "",
        updateAvailable: false,
        downloaded: false,
        status: "available" as const,
        workDir,
        workDirFallback,
        updateError: undefined,
        checkError: `Failed to fetch version metadata: ${res.status}`,
      }
    }
    const text = await res.text()
    const match = text.match(/^version:\s*(.+)$/m)
    const remoteVersion = (match?.[1]?.trim() ?? "").replace(/^['"]|['"]$/g, "")
    if (!remoteVersion) {
      return {
        currentVersion,
        remoteVersion: "",
        updateAvailable: false,
        downloaded: false,
        status: "available" as const,
        workDir,
        workDirFallback,
        updateError: undefined,
        checkError: "Could not parse remote version from metadata",
      }
    }
    const updateAvailable = compareVer(currentVersion, remoteVersion) < 0
    if (!updateAvailable && workDir) await clearUpdateState(workDir)
    const state = updateAvailable && workDir ? await resolveUpdateStatus(os, remoteVersion, workDir) : null
    const downloaded = state?.status === "downloaded"
    return {
      currentVersion,
      remoteVersion,
      updateAvailable,
      downloaded,
      status: state?.status ?? "available",
      workDir,
      workDirFallback,
      updateError: state?.error || undefined,
      checkError: undefined,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return {
      currentVersion,
      remoteVersion: "",
      updateAvailable: false,
      downloaded: false,
      status: "available" as const,
      workDir,
      workDirFallback,
      updateError: undefined,
      checkError: `Failed to check update: ${message}`,
    }
  }
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
                schema: resolver(
                  z.object({
                    currentVersion: z.string(),
                    remoteVersion: z.string(),
                    updateAvailable: z.boolean(),
                    downloaded: z.boolean(),
                    status: WebUpdateStatus,
                    workDir: z.string(),
                    workDirFallback: z.boolean(),
                    updateError: z.string().optional(),
                    checkError: z.string().optional(),
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
        const parsed = WebUpdateOS.safeParse(os)
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
          acceptFallback: z.boolean().optional(),
          force: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const { os, version, acceptFallback, force } = c.req.valid("json")
        const resolved = resolveWorkDir(os)
        if (!resolved) {
          return c.json({ success: false as const, error: "Could not determine aether work directory" })
        }
        if (resolved.isFallback && !acceptFallback) {
          return c.json({
            success: false as const,
            error: `Aether is not installed in the expected location. Install to fallback path requires confirmation: ${resolved.path}`,
          })
        }
        const workDir = resolved.path
        const upd = UPDATE_SCRIPT[os]
        if (!upd) return c.json({ success: false as const, error: `Update script not configured for ${os}` })
        const state = await resolveUpdateStatus(os, version, workDir)
        if (force) await resetUpdate(os, version, workDir)
        if (!force && state.status === "downloaded") {
          return c.json({ success: true as const, path: path.join(workDir, "downloads", versioned(upd, version)) })
        }
        if (!force && state.status === "downloading") {
          return c.json({ success: false as const, error: "Update download is already in progress" })
        }
        if (!force && state.status === "installing") {
          return c.json({ success: false as const, error: "Update install is already in progress" })
        }
        if (!force && state.status === "recovery") {
          return c.json({ success: false as const, error: state.error || "Update needs to restart from scratch" })
        }
        try {
          await fs.mkdir(workDir, { recursive: true })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return c.json({ success: false as const, error: `Failed to create work directory ${workDir}: ${msg}` })
        }
        const scriptPath = await fetchInstallerScript(os)
        if (!scriptPath) {
          return c.json({ success: false as const, error: `Failed to fetch installer script for ${os}` })
        }
        const currentVersion = readWebCurrentVersion()
        log.info("running installer auto mode", { os, script: scriptPath, version, workDir })
        try {
          const cur = await currentVersion
          if (compareVer(cur, version) >= 0) {
            await clearUpdateState(workDir)
            return c.json({ success: false as const, error: "No upgrade needed" })
          }
          await writeUpdateState(workDir, updateState(version, "downloading"))
          const exitCode = await new Promise<number>((resolve, reject) => {
            const cmd = os === "windows" ? "cmd" : "bash"
            const cmdArgs = os === "windows" ? ["/c", scriptPath, "auto", cur] : [scriptPath, "auto", cur]
            const child = spawn(cmd, cmdArgs, {
              cwd: workDir,
              env: { ...process.env, AETHER_WORK_DIR: workDir },
              windowsHide: os === "windows",
            })
            child.on("close", (code: number | null) => resolve(code ?? 1))
            child.on("error", reject)
          })

          const dl = path.join(workDir, "downloads")
          const scriptInDownloads = path.join(dl, versioned(upd, version))
          try {
            await fs.access(scriptInDownloads)
          } catch {
            await writeUpdateState(workDir, updateState(version, "error", `Downloaded update script missing: ${scriptInDownloads}`))
            return c.json({ success: false as const, error: `Downloaded update script missing: ${scriptInDownloads}` })
          }
          try {
            await fs.chmod(scriptInDownloads, 0o755)
          } catch {}

          const pkg = await packagePath(os, version, workDir)
          if (!pkg) {
            await writeUpdateState(workDir, updateState(version, "error", `No update package found in ${dl}`))
            return c.json({ success: false as const, error: `No update package found in ${dl}` })
          }
          log.info("installer auto result", { exitCode, workDir, script: scriptInDownloads, pkg })
          if (exitCode === 20) {
            await clearUpdateState(workDir)
            return c.json({ success: false as const, error: "Already up to date" })
          }
          if (exitCode === 10) {
            await writeUpdateState(workDir, updateState(version, "downloaded"))
            return c.json({ success: true as const, path: scriptInDownloads, package: pkg })
          }
          await writeUpdateState(workDir, updateState(version, "error", `Installer exited with code ${exitCode}`))
          return c.json({ success: false as const, error: `Installer exited with code ${exitCode}` })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          await writeUpdateState(workDir, updateState(version, "error", `Download failed: ${message}`)).catch(() => undefined)
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
          acceptFallback: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const { os, version, acceptFallback } = c.req.valid("json")
        const resolved = resolveWorkDir(os)
        if (!resolved) {
          return c.json({ success: false as const, error: "Could not determine aether work directory" })
        }
        if (resolved.isFallback && !acceptFallback) {
          return c.json({
            success: false as const,
            error: `Aether is not installed in the expected location. Install to fallback path requires confirmation: ${resolved.path}`,
          })
        }
        const workDir = resolved.path
        try {
          await fs.mkdir(workDir, { recursive: true })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return c.json({ success: false as const, error: `Failed to create work directory ${workDir}: ${msg}` })
        }
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
          await writeUpdateState(workDir, updateState(version ?? "latest", "error", `Update script not found: ${run}`)).catch(
            () => undefined,
          )
          return c.json({ success: false as const, error: `Update script not found: ${run}` })
        }
        const next = version || (await readUpdateState(workDir))?.version || "latest"
        const state = version ? await resolveUpdateStatus(os, version, workDir) : null
        if (version && state?.status !== "downloaded") {
          const msg = state?.error || "Update files are not ready. Restart the update from scratch."
          await writeUpdateState(workDir, updateState(version, "error", msg)).catch(() => undefined)
          return c.json({ success: false as const, error: msg })
        }
        try {
          await fs.chmod(run, 0o755)
        } catch {}
        log.info("launching update script", { os, updater: run, workDir, version })
        try {
          await writeUpdateState(workDir, updateState(next, "installing"))
          const args = version ? [run, version] : [run]
          if (os === "darwin" || os === "linux" || os === "windows") args.push("--restart")
          const env = resolved.isFallback ? { ...process.env, AETHER_CURRENT_DIR: getAppRoot() } : process.env
          const child =
            os === "windows"
              ? spawn("cmd", ["/c", ...args], {
                  detached: true,
                  stdio: "ignore",
                  cwd: path.join(workDir, "downloads"),
                  env,
                  windowsHide: true,
                })
              : spawn("bash", args, { detached: true, stdio: "ignore", cwd: path.join(workDir, "downloads"), env })
          child.unref()
          return c.json({ success: true as const })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          await writeUpdateState(workDir, updateState(next, "error", `Failed to execute update script: ${message}`)).catch(
            () => undefined,
          )
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
