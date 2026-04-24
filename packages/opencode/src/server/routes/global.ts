import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "os"
import { spawn } from "child_process"
import { createHash } from "crypto"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { ConfigPaths } from "../../config/paths"
import { Global } from "@/global"
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
const WebUpdateStatus = z.enum(["available", "downloading", "downloaded", "installing", "failed"])
const WebUpdateState = z.object({
  status: z.enum(["downloading", "downloaded", "installing", "installed", "failed"]),
  version: z.string().min(1),
  server: z.string().min(1),
  at: z.number().int(),
  current_version: z.string().min(1).optional(),
  manifest_url: z.string().min(1).optional(),
  package_path: z.string().min(1).optional(),
  package_sha512: z.string().min(1).optional(),
  package_size: z.number().int().positive().optional(),
  script_path: z.string().min(1).optional(),
  error: z.string().optional(),
})

const WEB_UPDATE_BASE_DEFAULT = "https://aether.aiphys.cn/download"
const UPDATE_RUN = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
})()

const INSTALLER_YML: Record<string, string | ((arch: string) => string)> = {
  darwin: "latest/mac-arm64.yml",
  linux: (arch) => `latest/linux-${arch}.yml`,
  windows: "latest/windows-x64.yml",
}

const UPDATE_YML: Record<string, string | ((arch: string) => string)> = {
  darwin: "mac-arm64.yml",
  linux: (arch) => `linux-${arch}.yml`,
  windows: "windows-x64.yml",
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

const UpdateConfig = z.object({
  updateBaseUrl: z.string().optional(),
})

async function readUpdateConfig() {
  const configDir = Global.Path.config
  for (const ext of ["jsonc", "json"]) {
    const file = path.join(configDir, `update-config.${ext}`)
    const text = await fs.readFile(file, "utf-8").catch(() => undefined)
    if (!text) continue
    const data = ConfigPaths.parseText(text, file, "empty").catch(() => undefined)
    if (!data) continue
    const parsed = UpdateConfig.safeParse(await data)
    if (parsed.success) return parsed.data
  }
  return null
}

let cachedBaseUrl: string | undefined

async function getUpdateBase() {
  if (cachedBaseUrl) return cachedBaseUrl
  const cfg = await readUpdateConfig()
  cachedBaseUrl = cfg?.updateBaseUrl?.trim() || WEB_UPDATE_BASE_DEFAULT
  return cachedBaseUrl
}

function updateStatePath(work: string) {
  return path.join(work, "downloads", "web-update-state.json")
}

function updateState(
  version: string,
  status: z.infer<typeof WebUpdateState>["status"],
  error?: string,
  extra?: Partial<z.infer<typeof WebUpdateState>>,
) {
  return {
    version,
    status,
    server: UPDATE_RUN,
    at: Date.now(),
    ...(extra ?? {}),
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

function cleanYaml(val: string) {
  return val.trim().replace(/^['"]|['"]$/g, "")
}

function origin(url: string) {
  const next = new URL(url)
  return `${next.protocol}//${next.host}`
}

function abs(url: string, val: string) {
  if (!val) return ""
  if (val.startsWith("http://") || val.startsWith("https://")) return val
  if (val.startsWith("/")) return `${origin(url)}${val}`
  return `${url.slice(0, url.lastIndexOf("/"))}/${val}`
}

function arch() {
  return process.arch === "arm64" ? "arm64" : "x64"
}

function yml(map: Record<string, string | ((arch: string) => string)>, os: z.infer<typeof WebUpdateOS>) {
  const item = map[os]
  return typeof item === "function" ? item(arch()) : item
}

async function manifestUrl(os: z.infer<typeof WebUpdateOS>, version?: string) {
  const base = await getUpdateBase()
  if (!version) return `${base}/${yml(INSTALLER_YML, os)}`
  return `${base}/${version}/${yml(UPDATE_YML, os)}`
}

function parseManifest(text: string) {
  let sec = ""
  let ver = ""
  let pkg = ""
  let sha = ""
  let note = ""
  let ins = ""
  let size = 0
  let file = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("version:")) {
      ver = cleanYaml(line.slice("version:".length))
      continue
    }
    if (line.startsWith("notes_url:")) {
      note = cleanYaml(line.slice("notes_url:".length))
      continue
    }
    if (/^package:\s*$/.test(line)) {
      sec = "package"
      file = false
      continue
    }
    if (/^installer:\s*$/.test(line)) {
      sec = "installer"
      file = false
      continue
    }
    if (/^files:\s*$/.test(line)) {
      sec = "files"
      file = false
      continue
    }
    if (/^[^\s-].*:\s*$/.test(raw)) {
      sec = ""
      file = false
      continue
    }
    if (sec === "package") {
      if (/^url:\s*/.test(line)) {
        pkg = cleanYaml(line.slice("url:".length))
        continue
      }
      if (/^sha512:\s*/.test(line)) {
        sha = cleanYaml(line.slice("sha512:".length))
        continue
      }
      if (/^size:\s*/.test(line)) {
        size = Number.parseInt(cleanYaml(line.slice("size:".length)), 10) || 0
        continue
      }
    }
    if (sec === "installer" && /^url:\s*/.test(line)) {
      ins = cleanYaml(line.slice("url:".length))
      continue
    }
    if (sec !== "files") continue
    if (/^-\s*url:\s*/.test(line)) {
      if (!pkg) pkg = cleanYaml(line.replace(/^-\s*url:\s*/, ""))
      file = !pkg || pkg === cleanYaml(line.replace(/^-\s*url:\s*/, ""))
      continue
    }
    if (!file) continue
    if (/^sha512:\s*/.test(line) && !sha) {
      sha = cleanYaml(line.slice("sha512:".length))
      continue
    }
    if (/^size:\s*/.test(line) && !size) {
      size = Number.parseInt(cleanYaml(line.slice("size:".length)), 10) || 0
    }
  }
  return { ver, pkg, sha, size, ins, note }
}

async function fetchManifest(os: z.infer<typeof WebUpdateOS>, version?: string) {
  const url = await manifestUrl(os, version)
  const res = await fetch(url)
  if (!res.ok) {
    return { ok: false as const, url, error: `Failed to fetch version metadata: ${res.status}` }
  }
  const text = await res.text()
  const data = parseManifest(text)
  if (!data.ver) {
    return { ok: false as const, url, error: "Could not parse remote version from metadata" }
  }
  if (!data.pkg || !data.sha || !data.size) {
    return { ok: false as const, url, error: "Update manifest must include package url, sha512, and size" }
  }
  return {
    ok: true as const,
    url,
    version: data.ver,
    package_url: abs(url, data.pkg),
    package_sha512: data.sha,
    package_size: data.size,
    installer_url: data.ins ? abs(url, data.ins) : "",
    notes_url: data.note ? abs(url, data.note) : "",
  }
}

function packageMatch(os: string, ver: string, name: string) {
  const ext = UPDATE_PKG_EXT[os] ?? ".dmg"
  const prefix = os === "linux" ? `aether-linux-${arch()}` : os === "windows" ? "aether-windows-x64" : "aether-darwin"
  return name.startsWith(prefix) && name.includes(ver) && name.toLowerCase().endsWith(ext)
}

async function packagePath(os: string, ver: string, work: string) {
  const dl = path.join(work, "downloads")
  const files = await fs.readdir(dl).catch(() => [])
  const list = files.filter((x) => packageMatch(os, ver, x)).sort()
  if (list.length === 0) return ""
  return path.join(dl, list[list.length - 1])
}

async function pkgHash(file: string) {
  return createHash("sha512")
    .update(await fs.readFile(file))
    .digest("base64")
}

async function verifyDownload(
  os: z.infer<typeof WebUpdateOS>,
  meta: Extract<Awaited<ReturnType<typeof fetchManifest>>, { ok: true }>,
  work: string,
) {
  const file = UPDATE_SCRIPT[os]
  if (!file) return { ok: false as const, error: `Update script not configured for ${os}` }
  const dl = path.join(work, "downloads")
  const script = path.join(dl, versioned(file, meta.version))
  try {
    await fs.access(script)
  } catch {
    return { ok: false as const, error: `Downloaded update script missing: ${script}` }
  }
  const pkg = await packagePath(os, meta.version, work)
  if (!pkg) return { ok: false as const, error: `No update package found in ${dl}` }
  try {
    const stat = await fs.stat(pkg)
    if (stat.size !== meta.package_size) {
      return { ok: false as const, error: `Downloaded package size mismatch for ${pkg}` }
    }
    const sha = await pkgHash(pkg)
    if (sha !== meta.package_sha512) {
      return { ok: false as const, error: `Downloaded package checksum mismatch for ${pkg}` }
    }
    return { ok: true as const, script, package: pkg }
  } catch {
    return { ok: false as const, error: `Failed to validate downloaded package: ${pkg}` }
  }
}

async function resetUpdate(os: string, ver: string, work: string) {
  const dl = path.join(work, "downloads")
  const file = UPDATE_SCRIPT[os]
  const state = await readUpdateState(work)
  const files = new Set<string>()
  if (state?.package_path) files.add(state.package_path)
  if (state?.script_path) files.add(state.script_path)
  if (file) files.add(path.join(dl, versioned(file, ver)))
  const pkg = await packagePath(os, ver, work)
  if (pkg) files.add(pkg)
  files.add(path.join(dl, "last-result.yml"))
  files.add(path.join(dl, "web-update-state.json"))
  if (state?.version === ver) {
    files.add(path.join(dl, `manifest-${ver}.yml`))
  }
  await Promise.all(Array.from(files).map((x) => fs.rm(x, { force: true }).catch(() => undefined)))
  await fs.rm(path.join(work, `.aether_${ver}.next`), { force: true, recursive: true }).catch(() => undefined)
  await fs.rm(path.join(work, `aether_${ver}`), { force: true, recursive: true }).catch(() => undefined)
  await clearUpdateState(work)
}

async function resolveUpdateStatus(
  os: z.infer<typeof WebUpdateOS>,
  cur: string,
  meta: Extract<Awaited<ReturnType<typeof fetchManifest>>, { ok: true }>,
  work: string,
) {
  const state = await readUpdateState(work)
  if (!state) {
    return { status: "available" as const, error: "" }
  }
  if (state.version !== meta.version) {
    return {
      status: "failed" as const,
      error: "A previous update attempt targeted a different version. Restart the update from scratch.",
    }
  }
  if (state.status === "installed") {
    return { status: "installed" as const, error: state.error ?? "" }
  }
  if (state.status === "installing" && compareVer(cur, state.version) >= 0) {
    return { status: "installed" as const, error: state.error ?? "" }
  }
  const chk = await verifyDownload(os, meta, work)
  if (state.status === "downloaded") {
    if (chk.ok) return { status: "downloaded" as const, error: state.error ?? "", ...chk }
    return {
      status: "failed" as const,
      error: chk.error,
    }
  }
  if (state.status === "downloading") {
    if (chk.ok) return { status: "downloaded" as const, error: state.error ?? "", ...chk }
    if (state.server === UPDATE_RUN) return { status: "downloading" as const, error: state.error ?? "" }
    return {
      status: "failed" as const,
      error: state.error ?? "The previous download did not finish. Restart the update from scratch.",
    }
  }
  if (state.status === "installing") {
    if (state.server === UPDATE_RUN) return { status: "installing" as const, error: state.error ?? "" }
    return {
      status: "failed" as const,
      error: state.error ?? "The previous install did not finish. Restart the update from scratch.",
    }
  }
  return {
    status: "failed" as const,
    error: state.error ?? "The previous update failed. Restart the update from scratch.",
  }
}

function versioned(name: string, ver: string) {
  const idx = name.lastIndexOf(".")
  if (idx < 0) return `${name}-${ver}`
  return `${name.slice(0, idx)}-${ver}${name.slice(idx)}`
}

function compareVer(a: string, b: string) {
  const norm = (v: string) =>
    v
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((x) => Number.parseInt(x || "0", 10) || 0)
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
  const url = `${await getUpdateBase()}/installer/${name}`
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
  if (Installation.isLocal()) {
    return {
      currentVersion,
      remoteVersion: "",
      updateAvailable: false,
      downloaded: false,
      status: "available" as const,
      workDir: "",
      workDirFallback: false,
      updateError: undefined,
      checkError: "Local build, skipping update check",
    }
  }
  const resolved = resolveWorkDir(os)
  const workDir = resolved?.path ?? ""
  const workDirFallback = resolved?.isFallback ?? false
  try {
    const meta = await fetchManifest(os)
    if (!meta.ok) {
      return {
        currentVersion,
        remoteVersion: "",
        updateAvailable: false,
        downloaded: false,
        status: "available" as const,
        workDir,
        workDirFallback,
        updateError: undefined,
        checkError: meta.error,
      }
    }
    const remoteVersion = meta.version
    const updateAvailable = compareVer(currentVersion, remoteVersion) < 0
    if (!updateAvailable && workDir) await clearUpdateState(workDir)
    const state = updateAvailable && workDir ? await resolveUpdateStatus(os, currentVersion, meta, workDir) : null
    if (state?.status === "installed" && workDir) {
      await clearUpdateState(workDir)
    }
    const downloaded = state?.status === "downloaded"
    return {
      currentVersion,
      remoteVersion,
      updateAvailable,
      downloaded,
      status: state?.status === "installed" ? "available" : (state?.status ?? "available"),
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

export const WebUpdateTest = {
  fetchManifest,
  manifestUrl,
  packageMatch,
  parseManifest,
  readUpdateState,
  resetUpdate,
  resolveUpdateStatus,
  updateState,
  verifyDownload,
  versioned,
  writeUpdateState,
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
        if (Installation.isLocal()) {
          return c.json({ success: false as const, error: "Local build, update is not available" })
        }
        const resolved = resolveWorkDir(os)
        if (!resolved) {
          return c.json({ success: false as const, error: "Could not determine aether work directory" })
        }
        const workDir = resolved.path
        const upd = UPDATE_SCRIPT[os]
        if (!upd) return c.json({ success: false as const, error: `Update script not configured for ${os}` })
        const meta = await fetchManifest(os, version)
        if (!meta.ok) return c.json({ success: false as const, error: meta.error })
        const cur = await readWebCurrentVersion()
        const state = await resolveUpdateStatus(os, cur, meta, workDir)
        if (force) await resetUpdate(os, version, workDir)
        if (!force && state.status === "downloaded") {
          return c.json({ success: true as const, path: state.script })
        }
        if (!force && state.status === "downloading") {
          return c.json({ success: false as const, error: "Update download is already in progress" })
        }
        if (!force && state.status === "installing") {
          return c.json({ success: false as const, error: "Update install is already in progress" })
        }
        if (!force && state.status === "failed") {
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
        log.info("running installer auto mode", { os, script: scriptPath, version, workDir })
        try {
          if (compareVer(cur, version) >= 0) {
            await clearUpdateState(workDir)
            return c.json({ success: false as const, error: "No upgrade needed" })
          }
          await writeUpdateState(
            workDir,
            updateState(version, "downloading", undefined, {
              current_version: cur,
              manifest_url: meta.url,
              package_sha512: meta.package_sha512,
              package_size: meta.package_size,
            }),
          )
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
          if (exitCode === 20) {
            await clearUpdateState(workDir)
            return c.json({ success: false as const, error: "Already up to date" })
          }
          const chk = await verifyDownload(os, meta, workDir)
          if (!chk.ok) {
            await writeUpdateState(
              workDir,
              updateState(version, "failed", chk.error, {
                current_version: cur,
                manifest_url: meta.url,
                package_sha512: meta.package_sha512,
                package_size: meta.package_size,
              }),
            )
            return c.json({ success: false as const, error: chk.error })
          }
          try {
            await fs.chmod(chk.script, 0o755)
          } catch {}
          log.info("installer auto result", { exitCode, workDir, script: chk.script, package: chk.package })
          if (exitCode === 10) {
            await writeUpdateState(
              workDir,
              updateState(version, "downloaded", undefined, {
                current_version: cur,
                manifest_url: meta.url,
                package_path: chk.package,
                package_sha512: meta.package_sha512,
                package_size: meta.package_size,
                script_path: chk.script,
              }),
            )
            return c.json({ success: true as const, path: chk.script, package: chk.package })
          }
          await writeUpdateState(
            workDir,
            updateState(version, "failed", `Installer exited with code ${exitCode}`, {
              current_version: cur,
              manifest_url: meta.url,
              package_path: chk.package,
              package_sha512: meta.package_sha512,
              package_size: meta.package_size,
              script_path: chk.script,
            }),
          )
          return c.json({ success: false as const, error: `Installer exited with code ${exitCode}` })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          await writeUpdateState(workDir, updateState(version, "failed", `Download failed: ${message}`)).catch(
            () => undefined,
          )
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
        if (Installation.isLocal()) {
          return c.json({ success: false as const, error: "Local build, update is not available" })
        }
        const resolved = resolveWorkDir(os)
        if (!resolved) {
          return c.json({ success: false as const, error: "Could not determine aether work directory" })
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
        const next = version || (await readUpdateState(workDir))?.version || "latest"
        const meta = version ? await fetchManifest(os, version) : null
        if (version) {
          if (!meta) return c.json({ success: false as const, error: "Update metadata is unavailable" })
          if (!meta.ok) return c.json({ success: false as const, error: meta.error })
        }
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
          await writeUpdateState(
            workDir,
            updateState(version ?? "latest", "failed", `Update script not found: ${run}`),
          ).catch(() => undefined)
          return c.json({ success: false as const, error: `Update script not found: ${run}` })
        }
        const cur = await readWebCurrentVersion()
        const state = version && meta?.ok ? await resolveUpdateStatus(os, cur, meta, workDir) : null
        if (version && state?.status !== "downloaded") {
          const msg = state?.error || "Update files are not ready. Restart the update from scratch."
          await writeUpdateState(workDir, updateState(version, "failed", msg)).catch(() => undefined)
          return c.json({ success: false as const, error: msg })
        }
        try {
          await fs.chmod(run, 0o755)
        } catch {}
        log.info("launching update script", { os, updater: run, workDir, version })
        try {
          await writeUpdateState(
            workDir,
            updateState(next, "installing", undefined, {
              current_version: cur,
              manifest_url: meta?.ok ? meta.url : undefined,
              package_path: state && "package" in state ? state.package : undefined,
              package_sha512: meta?.ok ? meta.package_sha512 : undefined,
              package_size: meta?.ok ? meta.package_size : undefined,
              script_path: run,
            }),
          )
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
          await writeUpdateState(
            workDir,
            updateState(next, "failed", `Failed to execute update script: ${message}`),
          ).catch(() => undefined)
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
