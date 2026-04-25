import { spawn } from "child_process"
import { createHash } from "crypto"
import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { Installation } from "@/installation"
import { ConfigPaths } from "../config/paths"
import { Log } from "../util/log"

const log = Log.create({ service: "server" })

export const WebUpdateOS = z.enum(["darwin", "linux", "windows"])
export const WebUpdateAction = z.enum(["recover", "mirror"])
export const WebUpdateStatus = z.enum(["available", "downloading", "downloaded", "installing", "failed"])
export const WebUpdateCheckInput = WebUpdateOS
export const WebUpdateDownloadInput = z.object({
  os: WebUpdateOS,
  version: z.string().min(1),
  force: z.boolean().optional(),
})
export const WebUpdateInstallInput = z.object({
  os: WebUpdateOS,
  version: z.string().min(1).optional(),
})
export const WebUpdateMirrorInput = z.object({
  os: WebUpdateOS,
  version: z.string().min(1).optional(),
})
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
  action: WebUpdateAction.optional(),
  error: z.string().optional(),
})
const WebUpdateResult = z.object({
  status: z.enum(["installed", "failed"]),
  version: z.string().min(1),
  at: z.number().int(),
  action: WebUpdateAction.optional(),
  error: z.string().optional(),
})
export const WebUpdateCheckResponse = z.object({
  currentVersion: z.string(),
  remoteVersion: z.string(),
  updateAvailable: z.boolean(),
  downloaded: z.boolean(),
  status: WebUpdateStatus,
  workDir: z.string(),
  updateAction: WebUpdateAction.optional(),
  updateError: z.string().optional(),
  checkError: z.string().optional(),
})
export const WebUpdateCommandResponse = z.union([
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string(), action: WebUpdateAction.optional() }),
])
export const WebUpdateDownloadResponse = z.union([
  z.object({ success: z.literal(true), path: z.string() }),
  z.object({ success: z.literal(false), error: z.string(), action: WebUpdateAction.optional() }),
])

const WEB_UPDATE_BASE_DEFAULT = "https://aether.aiphys.cn/download"
function arch() {
  return process.arch === "arm64" ? "arm64" : "x64"
}

const UPDATE_PKG_PREFIX: Record<string, string> = {
  darwin: "aether-darwin",
  linux: `aether-linux-${arch()}`,
  windows: "aether-windows-x64",
}
const UPDATE_RUN = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
})()
const INSTALLER_YML: Record<string, string | ((arch: string) => string)> = {
  darwin: "latest/mac-arm64.yml",
  linux: (a) => `latest/linux-${a}.yml`,
  windows: "latest/windows-x64.yml",
}
const UPDATE_YML: Record<string, string | ((arch: string) => string)> = {
  darwin: "mac-arm64.yml",
  linux: (a) => `linux-${a}.yml`,
  windows: "windows-x64.yml",
}

function yml(map: Record<string, string | ((arch: string) => string)>, os: z.infer<typeof WebUpdateOS>) {
  const item = map[os]
  return typeof item === "function" ? item(arch()) : item
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
const INSTALL_TTL = 2 * 60 * 1000
const UpdateConfig = z.object({
  updateBaseUrl: z.string().optional(),
})

let cachedBaseUrl: string | undefined

function updateStatePath(work: string) {
  return path.join(work, "downloads", "web-update-state.json")
}

function resultPath(work: string) {
  return path.join(work, "downloads", "web-update-result.env")
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
  await fs.rm(resultPath(work), { force: true }).catch(() => undefined)
}

async function readResult(work: string) {
  try {
    const text = await fs.readFile(resultPath(work), "utf-8")
    const data = Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf("=")
          if (idx < 0) return ["", ""]
          return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()]
        })
        .filter(([key]) => key),
    ) as Record<string, string>
    const parsed = WebUpdateResult.safeParse({
      status: data.status,
      version: data.version,
      at: Number.parseInt(data.at ?? "0", 10),
      action: data.action || undefined,
      error: data.error || undefined,
    })
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

const failRes = (error: string, action?: z.infer<typeof WebUpdateAction>) => {
  if (action) return { success: false as const, error, action }
  return { success: false as const, error }
}

async function failState(
  work: string,
  version: string,
  error: string,
  extra?: Partial<z.infer<typeof WebUpdateState>>,
) {
  await writeUpdateState(work, updateState(version, "failed", error, extra)).catch(() => undefined)
  return failRes(error, extra?.action)
}

async function mkdirp(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Failed to create work directory ${dir}: ${msg}`
  }
}

async function chmodSafe(file: string) {
  try {
    await fs.chmod(file, 0o755)
  } catch {}
}

async function runPath(work: string, file: string, version?: string) {
  const dl = path.join(work, "downloads")
  if (version) return path.join(dl, versioned(file, version))
  const files = await fs.readdir(dl).catch(() => [])
  const idx = file.lastIndexOf(".")
  const stem = idx < 0 ? file : file.slice(0, idx)
  const ext = idx < 0 ? "" : file.slice(idx)
  const list = files.filter((x) => x.startsWith(`${stem}-`) && x.endsWith(ext)).sort()
  if (list.length > 0) return path.join(dl, list[list.length - 1])
  return path.join(dl, file)
}

function runEnv(work: string, extra?: Record<string, string>) {
  return {
    ...process.env,
    AETHER_CURRENT_DIR: getAppRoot(),
    AETHER_WORK_DIR: work,
    AETHER_UPDATE_RESULT: resultPath(work),
    ...(extra ?? {}),
  }
}

async function spawnAuto(os: z.infer<typeof WebUpdateOS>, script: string, work: string) {
  const updateBase = await getUpdateBase()
  return await new Promise<number>((resolve, reject) => {
    const cmd = os === "windows" ? "cmd" : "bash"
    const args = os === "windows" ? ["/c", script, "auto"] : [script, "auto"]
    const child = spawn(cmd, args, {
      cwd: work,
      env: { ...process.env, AETHER_WORK_DIR: work, AETHER_UPDATE_BASE: updateBase },
      windowsHide: os === "windows",
    })
    child.on("close", (code: number | null) => resolve(code ?? 1))
    child.on("error", reject)
  })
}

function spawnRun(
  os: z.infer<typeof WebUpdateOS>,
  run: string,
  work: string,
  version?: string,
  extra?: Record<string, string>,
) {
  const args = version ? [run, version] : [run, "--restart"]
  if (version) args.push("--restart")
  const child =
    os === "windows"
      ? spawn("cmd", ["/c", ...args], {
          detached: true,
          stdio: "ignore",
          cwd: path.join(work, "downloads"),
          env: runEnv(work, extra),
          windowsHide: true,
        })
      : spawn("bash", args, {
          detached: true,
          stdio: "ignore",
          cwd: path.join(work, "downloads"),
          env: runEnv(work, extra),
        })
  child.unref()
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

function manifestUrl(os: z.infer<typeof WebUpdateOS>, version?: string) {
  return (base: string) => {
    if (!version) return `${base}/${yml(INSTALLER_YML, os)}`
    return `${base}/${version}/${yml(UPDATE_YML, os)}`
  }
}

async function readUpdateConfig() {
  const dir = Global.Path.config
  for (const ext of ["jsonc", "json"]) {
    const file = path.join(dir, `update-config.${ext}`)
    const text = await fs.readFile(file, "utf-8").catch(() => undefined)
    if (!text) continue
    const data = await ConfigPaths.parseText(text, file, "empty").catch(() => undefined)
    if (!data) continue
    const parsed = UpdateConfig.safeParse(data)
    if (parsed.success) return parsed.data
  }
  return null
}

async function getUpdateBase() {
  if (cachedBaseUrl) return cachedBaseUrl
  const cfg = await readUpdateConfig()
  cachedBaseUrl = cfg?.updateBaseUrl?.trim() || WEB_UPDATE_BASE_DEFAULT
  return cachedBaseUrl
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
  const url = manifestUrl(os, version)(await getUpdateBase())
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

async function verifyInstall(ver: string, work: string) {
  const dir = path.join(work, `aether_${ver}`)
  const file = path.join(dir, ".aether_web_version")
  try {
    const cur = (await fs.readFile(file, "utf-8")).trim()
    if (!cur) return { ok: false as const, error: `Installed version marker is empty: ${file}` }
    if (compareVer(cur, ver) !== 0) {
      return { ok: false as const, error: `Installed version marker mismatch for ${dir}` }
    }
    return { ok: true as const, dir }
  } catch {
    return { ok: false as const, error: `Installed version directory is incomplete: ${dir}` }
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
  const result = await readResult(work)
  if (!state) {
    return { status: "available" as const, error: "" }
  }
  if (state.version !== meta.version) {
    return {
      status: "failed" as const,
      error: "A previous update attempt targeted a different version. Restart the update from scratch.",
      action: "recover" as const,
    }
  }
  if (result?.version === state.version && result.status === "failed") {
    return {
      status: "failed" as const,
      error: result.error || state.error || "The previous update failed. Restart the update from scratch.",
      action: result.action ?? state.action ?? "recover",
    }
  }
  if (state.status === "installed") {
    return { status: "installed" as const, error: state.error ?? "", action: state.action }
  }
  if (state.status === "installing" && compareVer(cur, state.version) >= 0) {
    const chk = await verifyInstall(state.version, work)
    if (chk.ok) return { status: "installed" as const, error: state.error ?? "", action: state.action }
    return { status: "failed" as const, error: chk.error, action: "recover" as const }
  }
  const chk = await verifyDownload(os, meta, work)
  if (state.status === "downloaded") {
    if (chk.ok) return { status: "downloaded" as const, error: state.error ?? "", action: state.action, ...chk }
    return { status: "failed" as const, error: chk.error, action: state.action ?? "recover" }
  }
  if (state.status === "downloading") {
    if (chk.ok) return { status: "downloaded" as const, error: state.error ?? "", action: state.action, ...chk }
    if (state.server === UPDATE_RUN) {
      return { status: "downloading" as const, error: state.error ?? "", action: state.action }
    }
    return {
      status: "failed" as const,
      error: state.error ?? "The previous download did not finish. Restart the update from scratch.",
      action: state.action ?? "recover",
    }
  }
  if (state.status === "installing") {
    if (Date.now() - state.at > INSTALL_TTL) {
      return {
        status: "failed" as const,
        error: state.error ?? "The previous install took too long to finish. Restart the update from scratch.",
        action: state.action ?? "recover",
      }
    }
    if (state.server === UPDATE_RUN) {
      return { status: "installing" as const, error: state.error ?? "", action: state.action }
    }
    return {
      status: "failed" as const,
      error: state.error ?? "The previous install did not finish. Restart the update from scratch.",
      action: state.action ?? "recover",
    }
  }
  return {
    status: "failed" as const,
    error: state.error ?? "The previous update failed. Restart the update from scratch.",
    action: state.action ?? "recover",
  }
}

function versioned(name: string, ver: string) {
  const idx = name.lastIndexOf(".")
  if (idx < 0) return `${name}-${ver}`
  return `${name.slice(0, idx)}-${ver}${name.slice(idx)}`
}

function normalizeVersion(v: string): string {
  const parts = v
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((x) => Number.parseInt(x || "0", 10) || 0)
  while (parts.length < 4) parts.push(0)
  return parts.slice(0, 4).join(".")
}

function compareVer(a: string, b: string) {
  const norm = (v: string) =>
    normalizeVersion(v)
      .split(".")
      .map((x) => Number.parseInt(x || "0", 10) || 0)
  const x = norm(a)
  const y = norm(b)
  for (let i = 0; i < 4; i++) {
    if (x[i] < y[i]) return -1
    if (x[i] > y[i]) return 1
  }
  return 0
}

function getWorkDir(os: string): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  if (!home) return null
  if (os === "darwin" || os === "linux") return path.join(home, ".local", "share", "aether", "update")
  if (os === "windows") return path.join(home, ".local", "share", "aether", "update")
  return null
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
    const text = await res.text()
    const patched = patchInstallerScript(os, text)
    await fs.writeFile(dest, patched)
    if (os !== "windows") {
      await fs.chmod(dest, 0o755).catch(() => undefined)
    }
    return dest
  } catch (e) {
    log.error("error fetching installer script", { url, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

function patchInstallerScript(os: string, text: string): string {
  if (os === "windows") {
    return text.replace(
      /set\s+"BASE=(https:\/\/[^\s"]+)"/,
      'if defined AETHER_UPDATE_BASE (set "BASE=%AETHER_UPDATE_BASE%") else (set "BASE=$1")',
    )
  }
  return text.replace(/base="(https:\/\/[^\s"]+)"/, 'base="${AETHER_UPDATE_BASE:-$1}"')
}

function getAppRoot(): string {
  return path.dirname(process.execPath)
}

function findVersionParent(dir: string): string | null {
  const name = path.basename(dir)
  if (/^aether_/.test(name)) return path.dirname(dir)
  const parent = path.dirname(dir)
  if (parent === dir) return null
  return findVersionParent(parent)
}

async function scanLocalVersions() {
  const root = getAppRoot()
  const parent = findVersionParent(root)
  if (!parent) return []
  const entries = await fs.readdir(parent).catch(() => [])
  const versions: string[] = []
  for (const entry of entries) {
    const match = /^aether_(.+)$/.exec(entry)
    if (match) {
      const full = path.join(parent, entry)
      const stat = await fs.stat(full).catch(() => null)
      if (stat?.isDirectory()) versions.push(match[1])
    }
  }
  return versions
}

export async function readWebCurrentVersion() {
  const file = path.join(getAppRoot(), ".aether_web_version")
  const marker = await fs
    .readFile(file, "utf-8")
    .then((x) => x.trim())
    .catch(() => "")

  const local = await scanLocalVersions()
  let best = local.length > 0 ? local[0] : ""
  for (let i = 1; i < local.length; i++) {
    if (compareVer(local[i], best) > 0) best = local[i]
  }

  if (marker && (!best || compareVer(marker, best) > 0)) return normalizeVersion(marker)
  if (best) return normalizeVersion(best)

  const fallback = normalizeVersion(Installation.VERSION)
  await fs.writeFile(file, `${fallback}\n`, "utf-8").catch(() => undefined)
  return fallback
}

export async function webCheck(os: z.infer<typeof WebUpdateOS>) {
  const currentVersion = await readWebCurrentVersion()
  const workDir = getWorkDir(os) ?? ""
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
        updateAction: undefined,
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
    return {
      currentVersion,
      remoteVersion,
      updateAvailable,
      downloaded: state?.status === "downloaded",
      status: state?.status === "installed" ? "available" : (state?.status ?? "available"),
      workDir,
      updateAction: state?.action,
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
      updateAction: undefined,
      updateError: undefined,
      checkError: `Failed to check update: ${message}`,
    }
  }
}

export async function downloadWebUpdate(input: z.infer<typeof WebUpdateDownloadInput>) {
  const os = input.os
  const version = input.version
  const force = input.force
  const workDir = getWorkDir(os)
  if (!workDir) return failRes("Could not determine aether work directory")
  const file = UPDATE_SCRIPT[os]
  if (!file) return failRes(`Update script not configured for ${os}`)
  const meta = await fetchManifest(os, version)
  if (!meta.ok) return failRes(meta.error)
  const cur = await readWebCurrentVersion()
  const state = await resolveUpdateStatus(os, cur, meta, workDir)
  if (force) await resetUpdate(os, version, workDir)
  if (!force && state.status === "downloaded") {
    return { success: true as const, path: state.script }
  }
  if (!force && state.status === "downloading") return failRes("Update download is already in progress")
  if (!force && state.status === "installing") return failRes("Update install is already in progress")
  if (!force && state.status === "failed") {
    return failRes(state.error || "Update needs to restart from scratch", state.action ?? "recover")
  }
  const dirErr = await mkdirp(workDir)
  if (dirErr) return failRes(dirErr)
  const scriptPath = await fetchInstallerScript(os)
  if (!scriptPath) return failRes(`Failed to fetch installer script for ${os}`)
  log.info("running installer auto mode", { os, script: scriptPath, version, workDir })
  try {
    if (compareVer(cur, version) >= 0) {
      await clearUpdateState(workDir)
      return failRes("No upgrade needed")
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
    const exitCode = await spawnAuto(os, scriptPath, workDir)
    const chk = await verifyDownload(os, meta, workDir)
    if (!chk.ok) {
      return await failState(workDir, version, chk.error, {
        current_version: cur,
        manifest_url: meta.url,
        package_sha512: meta.package_sha512,
        package_size: meta.package_size,
        action: "recover",
      })
    }
    await chmodSafe(chk.script)
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
      return { success: true as const, path: chk.script, package: chk.package }
    }
    return await failState(workDir, version, `Installer exited with code ${exitCode}`, {
      current_version: cur,
      manifest_url: meta.url,
      package_path: chk.package,
      package_sha512: meta.package_sha512,
      package_size: meta.package_size,
      script_path: chk.script,
      action: "recover",
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return await failState(workDir, version, `Download failed: ${message}`, { action: "recover" })
  }
}

export async function installWebUpdate(input: z.infer<typeof WebUpdateInstallInput>) {
  const os = input.os
  const version = input.version
  const workDir = getWorkDir(os)
  if (!workDir) return failRes("Could not determine aether work directory")
  const dirErr = await mkdirp(workDir)
  if (dirErr) return failRes(dirErr)
  const file = UPDATE_SCRIPT[os]
  if (!file) return failRes(`Update script not configured for ${os}`)
  const next = version || (await readUpdateState(workDir))?.version || "latest"
  const meta = version ? await fetchManifest(os, version) : null
  if (version) {
    if (!meta) return failRes("Update metadata is unavailable")
    if (!meta.ok) return failRes(meta.error)
  }
  const run = await runPath(workDir, file, version)
  try {
    await fs.access(run)
  } catch {
    return await failState(workDir, version ?? "latest", `Update script not found: ${run}`, { action: "recover" })
  }
  const cur = await readWebCurrentVersion()
  const state = version && meta?.ok ? await resolveUpdateStatus(os, cur, meta, workDir) : null
  if (version && state?.status !== "downloaded") {
    const message = state?.error || "Update files are not ready. Restart the update from scratch."
    return await failState(workDir, version, message, { action: state?.action ?? "recover" })
  }
  await chmodSafe(run)
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
    await fs.rm(resultPath(workDir), { force: true }).catch(() => undefined)
    spawnRun(os, run, workDir, version)
    return { success: true as const }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return await failState(workDir, next, `Failed to execute update script: ${message}`, { action: "recover" })
  }
}

export async function retryWebUpdateMirror(input: z.infer<typeof WebUpdateMirrorInput>) {
  const os = input.os
  const version = input.version
  const workDir = getWorkDir(os)
  if (!workDir) return failRes("Could not determine aether work directory")
  const dirErr = await mkdirp(workDir)
  if (dirErr) return failRes(dirErr)
  const file = UPDATE_SCRIPT[os]
  if (!file) return failRes(`Update script not configured for ${os}`)
  const state = await readUpdateState(workDir)
  const next = version || state?.version
  if (!next) return failRes("No failed mirror step is available", "recover")
  if (state?.version !== next || state.action !== "mirror") {
    return failRes(state?.error || "Mirror retry is not available for this update.", state?.action ?? "recover")
  }
  const run = await runPath(workDir, file, next)
  try {
    await fs.access(run)
  } catch {
    return await failState(workDir, next, `Update script not found: ${run}`, { action: "recover" })
  }
  const dir = path.join(workDir, `aether_${next}`)
  try {
    await fs.access(dir)
  } catch {
    return await failState(workDir, next, `Installed version directory is missing: ${dir}`, { action: "recover" })
  }
  await chmodSafe(run)
  const cur = await readWebCurrentVersion()
  log.info("retrying update mirror", { os, updater: run, workDir, version: next })
  try {
    await writeUpdateState(
      workDir,
      updateState(next, "installing", undefined, {
        current_version: cur,
        script_path: run,
        action: "mirror",
      }),
    )
    await fs.rm(resultPath(workDir), { force: true }).catch(() => undefined)
    spawnRun(os, run, workDir, next, { AETHER_MIRROR_ONLY: "1" })
    return { success: true as const }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return await failState(workDir, next, `Failed to execute mirror retry: ${message}`, { action: "mirror" })
  }
}

export const WebUpdateTest = {
  fetchManifest,
  getWorkDir,
  manifestUrl: async (os: z.infer<typeof WebUpdateOS>, version?: string) =>
    manifestUrl(os, version)(await getUpdateBase()),
  packageMatch,
  parseManifest,
  readResult,
  readUpdateState,
  resetUpdateBase: () => {
    cachedBaseUrl = undefined
  },
  resetUpdate,
  resolveUpdateStatus,
  updateState,
  verifyDownload,
  verifyInstall,
  versioned,
  writeUpdateState,
}
