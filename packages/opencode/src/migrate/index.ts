import { Database as SQLite } from "bun:sqlite"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { MigrateError } from "./error"
import { contentText, list as array, obj, str, titleText, uuid } from "./util"
import type { ParsedSession, SessionRef, SourceFormat } from "./model"
import * as claude from "./adapters/claude"
import * as codebuddy from "./adapters/codebuddy"
import * as codex from "./adapters/codex"
import * as copilot from "./adapters/copilot"
import * as grok from "./adapters/grok"
import * as kilo from "./adapters/kilo"
import * as kimi from "./adapters/kimi"
import * as muse from "./adapters/muse"
import * as omp from "./adapters/omp"
import * as opencode from "./adapters/opencode"
import * as openhands from "./adapters/openhands"
import * as pi from "./adapters/pi"
import * as qoder from "./adapters/qoder"
import * as qodercn from "./adapters/qodercn"
import * as qwen from "./adapters/qwen"
import * as vibe from "./adapters/vibe"

export type Context = {
  home?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type Cli = {
  cli?: string
  env?: NodeJS.ProcessEnv
}

export type Root = {
  path: string
  origin: "default" | "environment" | "project" | "explicit"
}

export type Detected = {
  id: SourceFormat
  name: string
  roots: Root[]
  sessions?: number
}

type Descriptor = {
  id: SourceFormat
  name: string
  roots: (ctx: Required<Context>) => Root[]
  marker: (root: string) => Promise<boolean>
  files?: (root: string, opts?: { titles?: boolean }) => Promise<SessionRef[]>
  meta?: (path: string) => Promise<{ title?: string; cwd?: string; parentID?: string }>
  parse?: (path: string) => Promise<ParsedSession>
  virtual?: boolean
}

const descriptors: Descriptor[] = [
  {
    id: "claude",
    name: "Claude Code",
    roots: (ctx) => roots(ctx, "CLAUDE_CONFIG_DIR", ".claude", ".claude"),
    marker: (root) => isDir(join(root, "projects")),
    files: async (root) => {
      const projects = join(root, "projects")
      const result: SessionRef[] = []
      for (const project of await directories(projects)) {
        for (const name of await files(project)) {
          if (!name.endsWith(".jsonl")) continue
          const path = join(project, name)
          result.push({ source: "claude", id: name.slice(0, -6), path, updated: await mtime(path) })
        }
      }
      return result
    },
    meta: readMeta,
    parse: claude.parse,
  },
  {
    id: "qoder",
    name: "Qoder",
    roots: (ctx) => roots(ctx, "QODER_CONFIG_DIR", ".qoder", ".qoder"),
    marker: (root) => isDir(join(root, "projects")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const project of await directories(join(root, "projects"))) {
        for (const name of await files(project)) {
          if (!name.endsWith(".jsonl")) continue
          const path = join(project, name)
          result.push({ source: "qoder", id: name.slice(0, -6), path, updated: await mtime(path) })
        }
      }
      return result
    },
    meta: readMeta,
    parse: qoder.parse,
  },
  {
    id: "qodercn",
    name: "Qoder CN",
    roots: (ctx) => roots(ctx, "QODER_CN_CONFIG_DIR", ".qoder-cn", ".qoder-cn"),
    marker: (root) => isDir(join(root, "projects")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const project of await directories(join(root, "projects"))) {
        for (const name of await files(project)) {
          if (!name.endsWith(".jsonl")) continue
          const path = join(project, name)
          result.push({ source: "qodercn", id: name.slice(0, -6), path, updated: await mtime(path) })
        }
      }
      return result
    },
    meta: readMeta,
    parse: qodercn.parse,
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    roots: (ctx) => roots(ctx, "CODEBUDDY_HOME", ".codebuddy", ".codebuddy"),
    marker: (root) => isDir(join(root, "projects")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const project of await directories(join(root, "projects"))) {
        for (const name of await files(project)) {
          if (!name.endsWith(".jsonl")) continue
          const path = join(project, name)
          result.push({ source: "codebuddy", id: name.slice(0, -6), path, updated: await mtime(path) })
        }
      }
      return result
    },
    meta: readMeta,
    parse: codebuddy.parse,
  },
  {
    id: "codex",
    name: "Codex CLI",
    roots: (ctx) => roots(ctx, "CODEX_HOME", ".codex", ".codex"),
    marker: async (root) => (await isDir(join(root, "sessions"))) || (await isDir(join(root, "archived_sessions"))),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const path of await walk(join(root, "sessions"), 5)) {
        if (!path.endsWith(".jsonl") || !basename(path).startsWith("rollout-")) continue
        result.push({ source: "codex", id: codexID(path), path, updated: await mtime(path) })
      }
      for (const name of await files(join(root, "archived_sessions"))) {
        if (!name.endsWith(".jsonl") || !name.startsWith("rollout-")) continue
        const path = join(root, "archived_sessions", name)
        result.push({ source: "codex", id: codexID(path), path, updated: await mtime(path) })
      }
      return result
    },
    meta: codex.meta,
    parse: codex.parse,
  },
  {
    id: "pi",
    name: "Pi",
    roots: (ctx) => roots(ctx, "PI_CODING_AGENT_DIR", ".pi/agent", ".pi/agent"),
    marker: (root) => isDir(join(root, "sessions")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const directory of await directories(join(root, "sessions"))) {
        for (const name of await files(directory)) {
          if (!name.endsWith(".jsonl")) continue
          const path = join(directory, name)
          if (!(await piHeader(path))) continue
          result.push({ source: "pi", id: name.slice(0, -6).split("_").at(-1) ?? name, path, updated: await mtime(path) })
        }
      }
      return result
    },
    meta: readMeta,
    parse: pi.parse,
  },
  {
    id: "omp",
    name: "Oh My Pi",
    roots: (ctx) => roots(ctx, "PI_CODING_AGENT_DIR", ".omp/agent", ".omp/agent"),
    marker: (root) => isDir(join(root, "sessions")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const directory of await directories(join(root, "sessions"))) {
        for (const name of await files(directory)) {
          if (!name.endsWith(".jsonl")) continue
          const path = join(directory, name)
          if (!(await ompHeader(path, root))) continue
          result.push({ source: "omp", id: name.slice(0, -6).split("_").at(-1) ?? name, path, updated: await mtime(path) })
        }
      }
      return result
    },
    meta: readMeta,
    parse: omp.parse,
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    roots: (ctx) => roots(ctx, "COPILOT_HOME", ".copilot", ".copilot"),
    marker: (root) => isDir(join(root, "session-state")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const directory of await directories(join(root, "session-state"))) {
        const path = join(directory, "events.jsonl")
        if (!(await isFile(path))) continue
        result.push({ source: "copilot", id: basename(directory), path, updated: await mtime(path) })
      }
      return result
    },
    meta: readMeta,
    parse: copilot.parse,
  },
  {
    id: "qwen",
    name: "Qwen Code",
    roots: (ctx) => roots(ctx, "QWEN_HOME", ".qwen", ".qwen"),
    marker: (root) => isDir(join(root, "projects")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const project of await directories(join(root, "projects"))) {
        for (const name of await files(join(project, "chats"))) {
          if (!name.endsWith(".jsonl")) continue
          const path = join(project, "chats", name)
          result.push({ source: "qwen", id: name.slice(0, -6), path, updated: await mtime(path) })
        }
      }
      return result
    },
    meta: readMeta,
    parse: qwen.parse,
  },
  {
    id: "kimi",
    name: "Kimi Code",
    roots: (ctx) => roots(ctx, "KIMI_CODE_HOME", ".kimi-code", ".kimi-code"),
    marker: (root) => isDir(join(root, "sessions")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const bucket of await directories(join(root, "sessions"))) {
        for (const directory of await directories(bucket)) {
          const path = join(directory, "agents/main/wire.jsonl")
          if (!(await isFile(path))) continue
          const state = await readJson(join(directory, "state.json"))
          const updated = typeof state?.updatedAt === "number" ? state.updatedAt : await mtime(path)
          result.push({ source: "kimi", id: basename(directory), title: typeof state?.title === "string" ? state.title : undefined, path: directory, updated })
        }
      }
      return result
    },
    meta: kimiMeta,
    parse: kimi.parse,
  },
  {
    id: "vibe",
    name: "Mistral Vibe",
    roots: (ctx) => roots(ctx, "VIBE_HOME", ".vibe", ".vibe"),
    marker: (root) => isDir(join(root, "logs/session")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const directory of await directories(join(root, "logs/session"))) {
        const path = join(directory, "messages.jsonl")
        if (!(await isFile(path)) || !(await isFile(join(directory, "meta.json")))) continue
        const meta = await readJson(join(directory, "meta.json"))
        const id = typeof meta?.session_id === "string" ? meta.session_id : basename(directory).split("_").at(-1)
        if (!id) continue
        result.push({ source: "vibe", id, title: typeof meta?.title === "string" ? meta.title : undefined, path: directory, updated: await mtime(path) })
      }
      return result
    },
    meta: vibeMeta,
    parse: vibe.parse,
  },
  {
    id: "muse",
    name: "Muse Code",
    roots: (ctx) => [dataRoot(ctx, "muse")],
    marker: (root) => isDir(join(root, "sessions")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const path of await walk(join(root, "sessions"), 5)) {
        if (basename(path) !== "session.jsonl") continue
        result.push({ source: "muse", id: basename(dirname(path)), path, updated: await mtime(path) })
      }
      return result
    },
    meta: readMeta,
    parse: muse.parse,
  },
  {
    id: "grok",
    name: "Grok",
    roots: (ctx) => roots(ctx, "GROK_HOME", ".grok", ".grok"),
    marker: (root) => isDir(join(root, "sessions")),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const bucket of await directories(join(root, "sessions"))) {
        for (const directory of await directories(bucket)) {
          if (!(await isFile(join(directory, "summary.json")))) continue
          const summary = await readJson(join(directory, "summary.json"))
          const info = summary?.info
          const id = info && typeof info === "object" && typeof (info as Record<string, unknown>).id === "string" ? String((info as Record<string, unknown>).id) : basename(directory)
          result.push({ source: "grok", id, title: typeof summary?.generated_title === "string" ? summary.generated_title : undefined, path: directory, updated: await mtime(join(directory, "updates.jsonl")) })
        }
      }
      return result
    },
    meta: grokMeta,
    parse: grok.parse,
  },
  {
    id: "openhands",
    name: "OpenHands",
    roots: (ctx) => roots(ctx, "OPENHANDS_CONVERSATIONS_DIR", ".openhands/conversations", ".openhands/conversations"),
    marker: (root) => isDir(root),
    files: async (root) => {
      const result: SessionRef[] = []
      for (const directory of await directories(root)) {
        const events = join(directory, "events")
        if (!(await isDir(events))) continue
        const id = uuid(basename(directory))
        if (!id) continue
        result.push({ source: "openhands", id, path: directory, updated: await mtime(events) })
      }
      return result
    },
    meta: openhandsMeta,
    parse: openhands.parse,
  },
  {
    id: "opencode",
    name: "OpenCode",
    roots: (ctx) => [dataRoot(ctx, "opencode")],
    marker: async (root) => (await isDir(root)) && ((await isFile(join(root, "opencode.db"))) || (await isDir(join(root, "storage")))),
    virtual: true,
  },
  {
    id: "kilo",
    name: "Kilo Code",
    roots: (ctx) => [dataRoot(ctx, "kilo")],
    marker: async (root) => (await isDir(root)) && ((await isFile(join(root, "kilo.db"))) || (await isDir(join(root, "storage")))),
    virtual: true,
  },
]

export async function detect(ctx: Context = {}): Promise<Detected[]> {
  const context = normalize(ctx)
  const result: Detected[] = []
  for (const descriptor of descriptors) {
    const roots = await available(descriptor, context)
    if (!roots.length) continue
    let sessions: number | undefined
    if (descriptor.files) {
      sessions = 0
      for (const root of roots) sessions += (await descriptor.files(root.path, { titles: false })).length
    } else if (descriptor.virtual) {
      sessions = (await virtualList(descriptor.id as "opencode" | "kilo", roots)).length
    }
    result.push({ id: descriptor.id, name: descriptor.name, roots, sessions })
  }
  return result
}

export async function list(
  source: SourceFormat,
  ctx: Context = {},
  options: Cli & { root?: string; limit?: number; titles?: boolean } = {},
): Promise<SessionRef[]> {
  const descriptor = descriptorFor(source)
  const context = normalize(ctx)
  if (descriptor.virtual) {
    const roots = options.root
      ? [{ path: resolve(options.root), origin: "explicit" as const }]
      : await available(descriptor, context)
    const native = await virtualList(source as "opencode" | "kilo", roots)
    if (native.length) return native
    if (source === "opencode") return await opencode.list("opencode", { cli: options.cli, env: options.env ?? context.env })
    return await kilo.list({ cli: options.cli, env: options.env ?? context.env })
  }
  if (!descriptor.files) return []
  const roots = options.root
    ? [{ path: resolve(options.root), origin: "explicit" as const }]
    : await available(descriptor, context)
  const result: SessionRef[] = []
  for (const root of roots) result.push(...(await descriptor.files(root.path)))
  result.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  const limited = options.limit ? result.slice(0, options.limit) : result
  if (options.titles && descriptor.meta) {
    for (const ref of limited) {
      const meta = await descriptor.meta(ref.path)
      ref.title = meta.title
      ref.cwd = meta.cwd
      ref.parentID = meta.parentID
    }
  }
  return limited
}

export async function read(
  source: SourceFormat,
  options: { path?: string; id?: string; root?: string; ctx?: Context; cli?: string; env?: NodeJS.ProcessEnv },
): Promise<ParsedSession> {
  const descriptor = descriptorFor(source)
  if (options.path) {
    let path = options.path
    if (await isDir(path)) {
      if (source === "copilot") path = join(path, "events.jsonl")
      else if (source === "muse") path = join(path, "session.jsonl")
      else if (source !== "kimi" && source !== "vibe" && source !== "grok" && source !== "openhands") {
        throw new MigrateError(`${source} --path must be a session file`)
      }
    }
    if (descriptor.virtual) {
      if (source === "opencode") return await opencode.parse(path, "opencode")
      return await kilo.parse(path)
    }
    if (!descriptor.parse) throw new MigrateError(`${source} does not support file import`)
    return await descriptor.parse(path)
  }
  if (!options.id) throw new MigrateError("a session ID or --path is required")
  if (descriptor.virtual) {
    if (source === "opencode") return await opencode.exportSession(options.id, "opencode", { cli: options.cli, env: options.env })
    return await kilo.exportSession(options.id, { cli: options.cli, env: options.env })
  }
  const id =
    source === "kimi"
      ? options.id.startsWith("session_")
        ? `session_${uuid(options.id.slice(8)) ?? options.id.slice(8)}`
        : `session_${uuid(options.id) ?? options.id}`
      : uuid(options.id) ?? options.id
  const refs = (await list(source, options.ctx, { root: options.root })).filter((ref) => ref.id === id)
  if (!refs.length) throw new MigrateError(`no ${source} session found for ${options.id}`)
  if (refs.length > 1) throw new MigrateError(`multiple ${source} sessions matched ${options.id}`)
  if (!descriptor.parse) throw new MigrateError(`${source} does not support file import`)
  return await descriptor.parse(refs[0]!.path)
}

export async function inspect(path: string, source?: SourceFormat) {
  const format = source ?? (await detectFile(path))
  if (!format) throw new MigrateError("cannot detect the source format; pass --source")
  return await read(format, { path })
}

export async function detectFile(path: string): Promise<SourceFormat | undefined> {
  const info = await stat(path).catch(() => undefined)
  if (!info) throw new MigrateError(`source path does not exist: ${path}`)
  if (info.isDirectory()) {
    if (await isFile(join(path, "events.jsonl"))) return "copilot"
    if ((await isFile(join(path, "agents/main/wire.jsonl"))) && (await isFile(join(path, "state.json")))) return "kimi"
    if ((await isFile(join(path, "meta.json"))) && (await isFile(join(path, "messages.jsonl")))) return "vibe"
    if ((await isFile(join(path, "summary.json"))) && (await isFile(join(path, "updates.jsonl")))) return "grok"
    if (await isDir(join(path, "events"))) return "openhands"
    if (await isFile(join(path, "session.jsonl"))) return "muse"
    return undefined
  }
  const name = basename(path)
  if (path.includes("/.qoder-cn/") || path.includes("\\.qoder-cn\\")) return "qodercn"
  if (path.includes("/.qoder/") || path.includes("\\.qoder\\")) return "qoder"
  if (path.includes("/.codebuddy/") || path.includes("\\.codebuddy\\")) return "codebuddy"
  if (name === "state.json") return "kimi"
  if (name === "summary.json") return "grok"
  if (path.endsWith(".json")) {
    const value = await Bun.file(path)
      .json()
      .catch(() => undefined)
    if (value && typeof value === "object" && "info" in value && "messages" in value) {
      return path.includes("/kilo/") || path.includes("\\kilo\\") ? "kilo" : "opencode"
    }
  }
  if (path.endsWith(".jsonl")) {
    const name = basename(path)
    if (name === "wire.jsonl") return "kimi"
    if (name === "messages.jsonl") return "vibe"
    if (name === "summary.json" || name === "updates.jsonl") return "grok"
    if (name === "session.jsonl") return "muse"
    if (/^event-\d{5}-/.test(name)) return "openhands"
    const first = (await Bun.file(path).slice(0, 64 * 1024).text()).split("\n").find((line) => line.trim())
    if (!first) return undefined
    let value: Record<string, unknown>
    try {
      value = JSON.parse(first)
    } catch {
      return undefined
    }
    if (value.sessionId && value.role && Array.isArray(value.content) && value.type === "message") return "codebuddy"
    if (value.sessionId && value.cwd && value.version && value.provenance) return "qwen"
    if (value.type === "session.start") return "copilot"
    if (value.type === "title") return "omp"
    if (value.type === "session" && value.version === 3) return "pi"
    if (value.type === "metadata" && value.protocol_version === "1.5") return "kimi"
    if (value.type === "session_meta" || basename(path).startsWith("rollout-")) return "codex"
    if (value.record_type === "event" || value.stream) return "muse"
    if (value.sessionId && value.uuid && value.type === "user" && value.message && typeof value.message === "object" && Array.isArray((value.message as Record<string, unknown>).parts)) return "qwen"
    if (value.sessionId && value.uuid && (value.type === "user" || value.type === "assistant")) return "claude"
  }
  return undefined
}

export function name(source: SourceFormat) {
  return descriptorFor(source).name
}

function descriptorFor(source: SourceFormat) {
  const descriptor = descriptors.find((item) => item.id === source)
  if (!descriptor) throw new MigrateError(`unknown source: ${source}`)
  return descriptor
}

function normalize(ctx: Context): Required<Context> {
  const env = ctx.env ?? process.env
  return {
    home: ctx.home ?? defaultHome(env),
    cwd: ctx.cwd ?? process.cwd(),
    env,
  }
}

function defaultHome(env: NodeJS.ProcessEnv) {
  // Git Bash may expose HOME as /c/Users/...; USERPROFILE is the native root.
  if (process.platform === "win32") return env.USERPROFILE ?? homedir()
  return env.HOME ?? homedir()
}

function roots(ctx: Required<Context>, env: string, fallback: string, project: string): Root[] {
  const result: Root[] = []
  const configured = ctx.env[env]
  if (configured) result.push({ path: resolve(expand(configured, ctx.home)), origin: "environment" })
  else result.push({ path: join(ctx.home, fallback), origin: "default" })
  let cursor = resolve(ctx.cwd)
  while (true) {
    result.push({ path: join(cursor, project), origin: "project" })
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return result
}

function dataRoot(ctx: Required<Context>, name: string): Root {
  const xdg = ctx.env.XDG_DATA_HOME
  return {
    path: xdg ? join(resolve(expand(xdg, ctx.home)), name) : join(ctx.home, ".local/share", name),
    origin: xdg ? "environment" : "default",
  }
}

async function available(descriptor: Descriptor, ctx: Required<Context>) {
  const seen = new Set<string>()
  const result: Root[] = []
  for (const root of descriptor.roots(ctx)) {
    if (seen.has(root.path)) continue
    seen.add(root.path)
    if (await descriptor.marker(root.path)) result.push(root)
  }
  return result
}

function expand(path: string, home: string) {
  if (path === "~") return home
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2))
  return path
}

async function directories(path: string) {
  return (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(path, entry.name))
}

async function files(path: string) {
  return (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
}

async function walk(path: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  const result: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) result.push(...(await walk(child, depth - 1)))
    else if (entry.isFile()) result.push(child)
  }
  return result
}

async function isDir(path: string) {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false
}

async function isFile(path: string) {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false
}

async function mtime(path: string) {
  return (await stat(path).catch(() => undefined))?.mtimeMs
}

async function virtualList(source: "opencode" | "kilo", roots: Root[]) {
  const result: SessionRef[] = []
  for (const root of roots) {
    const path = join(root.path, source === "opencode" ? "opencode.db" : "kilo.db")
    if (!(await isFile(path))) continue
    try {
      const db = new SQLite(path, { readonly: true })
      try {
        const rows = db
          .query("select id, title, directory, time_updated from session order by time_updated desc")
          .all() as Array<Record<string, unknown>>
        for (const row of rows) {
          const id = str(row.id)
          if (!id) continue
          result.push({
            source,
            id,
            path: `${source}:${id}`,
            title: str(row.title),
            cwd: str(row.directory),
            updated: typeof row.time_updated === "number" ? row.time_updated : undefined,
          })
        }
      } finally {
        db.close()
      }
    } catch {
      continue
    }
  }
  return result.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
}

async function ompHeader(path: string, root: string) {
  const text = await Bun.file(path)
    .slice(0, 64 * 1024)
    .text()
    .catch(() => "")
  const line = text.split("\n").find((value) => value.trim())
  if (!line) return false
  try {
    const value = JSON.parse(line)
    if (value?.type === "title") return true
    return value?.type === "session" && value?.version === 3 && root.includes(".omp")
  } catch {
    return false
  }
}

async function readMeta(path: string) {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return {}
  const head = await Bun.file(path)
    .slice(0, Math.min(info.size, 2 * 1024 * 1024))
    .text()
    .catch(() => "")
  const tail =
    info.size > 2 * 1024 * 1024
      ? await Bun.file(path)
          .slice(Math.max(0, info.size - 64 * 1024))
          .text()
          .catch(() => "")
      : ""
  let title: string | undefined
  let cwd: string | undefined
  for (const line of [...head.split("\n"), ...tail.split("\n")]) {
    if (!line.trim()) continue
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const payload = obj(value.payload)
    const data = obj(value.data)
    const record = obj(payload.record)
    cwd ??=
      str(value.cwd) ??
      str(payload.cwd) ??
      str(obj(data.context).cwd) ??
      str(record.workspace_root) ??
      str(value.workspace_root)
    if (value.type === "ai-title") title = str(value.aiTitle) ?? title
    else if (value.type === "custom-title") title = str(value.customTitle) ?? title
    else if (value.type === "session_info") title = str(value.name) ?? title
    else if (value.type === "session.title_changed") title = str(data.title) ?? title
    else {
      title ??= str(value.title) ?? str(payload.thread_name) ?? str(payload.name) ?? str(record.title)
    }
    if (!title && value.subtype === "custom_title") title = str(obj(value.systemPayload).customTitle) ?? title
    if (!title) {
      const text = titleText(userText(value))
      if (text) title = text
    }
  }
  return { title, cwd }
}

function userText(value: Record<string, unknown>) {
  const payload = obj(value.payload)
  const message = obj(value.message)
  if (value.type === "user.message") return str(obj(value.data).content)
  if (value.type === "user") return contentText(message.content ?? message.parts)
  if (value.type === "message" && (value.role === "user" || message.role === "user")) {
    return contentText(value.content ?? message.content)
  }
  if (value.type === "response_item" && payload.type === "message" && payload.role === "user") {
    return contentText(payload.content)
  }
  if (value.type === "event_msg" && payload.type === "user_message") return str(payload.message)
  if (value.payload_type === "runtime.user_intent.accepted") {
    for (const item of array(payload.model_messages)) {
      const text = contentText(obj(item).content)
      if (text) return text
    }
  }
  return undefined
}

async function kimiMeta(path: string) {
  const state = await readJson(join(path, "state.json"))
  return { title: str(state?.title), cwd: str(state?.cwd) }
}

async function vibeMeta(path: string) {
  const meta = await readJson(join(path, "meta.json"))
  return { title: str(meta?.title), cwd: str(obj(meta?.environment).working_directory) }
}

async function grokMeta(path: string) {
  const summary = await readJson(join(path, "summary.json"))
  const info = obj(summary?.info)
  return {
    title: str(summary?.generated_title) ?? str(summary?.session_summary),
    cwd: str(info.cwd),
  }
}

async function openhandsMeta(path: string) {
  const base = await readJson(join(path, "base_state.json"))
  const workspace = obj(base?.workspace)
  return { cwd: str(workspace.working_dir) ?? str(workspace.cwd) }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await Bun.file(path).json()
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function piHeader(path: string) {
  const text = await Bun.file(path)
    .slice(0, 64 * 1024)
    .text()
    .catch(() => "")
  const line = text.split("\n").find((value) => value.trim())
  if (!line) return false
  try {
    const value = JSON.parse(line)
    return value?.type === "session" && value?.version === 3
  } catch {
    return false
  }
}

function codexID(path: string) {
  return basename(path).match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? basename(path, ".jsonl")
}
