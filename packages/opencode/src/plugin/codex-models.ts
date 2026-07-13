import fs from "fs/promises"
import path from "path"
import semver from "semver"
import z from "zod"
import { Global } from "../global"
import { Installation } from "../installation"
import { ProviderModels } from "../provider/models-event"
import { Filesystem } from "../util/filesystem"
import { Hash } from "../util/hash"
import { Log } from "../util/log"

export namespace CodexModels {
  const log = Log.create({ service: "plugin.codex.models" })
  const ttl = 5 * 60 * 1000
  const interval = 60 * 60 * 1000
  export const VERSION = "0.144.0"
  export const URL = `https://chatgpt.com/backend-api/codex/models?client_version=${VERSION}`

  const Model = z
    .object({
      slug: z.string().min(1),
      visibility: z.string(),
      minimal_client_version: z.string().nullable().optional(),
    })
    .passthrough()
  const Response = z.object({ models: z.array(Model) }).passthrough()

  export const Source = z.enum(["none", "fallback", "cache", "remote"])
  export const Status = z
    .object({
      enabled: z.boolean(),
      source: Source,
      checkedAt: z.number().nullable(),
      updatedAt: z.number().nullable(),
      etag: z.string().nullable(),
      hash: z.string().nullable(),
      error: z.string().nullable(),
    })
    .meta({ ref: "CodexModelsStatus" })
  export type Status = z.infer<typeof Status>

  export const Refresh = Status.extend({ changed: z.boolean() })
  export type Refresh = z.infer<typeof Refresh>

  const Cache = z
    .object({
      version: z.literal(1),
      clientVersion: z.literal(VERSION),
      checkedAt: z.number().nullable(),
      updatedAt: z.number().nullable(),
      etag: z.string().nullable(),
      hash: z.string(),
      error: z.string().nullable(),
      models: z.array(z.string()).min(1),
    })
    .strict()

  type Request = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  type Entry = {
    key: string
    disk: boolean
    fetcher: Request
    status: Status
    models?: string[]
  }
  type Input = {
    identity?: string
    seed: string
    fetcher: Request
  }
  type Download = {
    previous: Status
    models?: string[]
    fetcher: Request
    timeout?: number
  }

  const empty: Status = {
    enabled: false,
    source: "none",
    checkedAt: null,
    updatedAt: null,
    etag: null,
    hash: null,
    error: null,
  }

  const entries = new Map<string, Entry>()
  const loads = new Map<string, Promise<Entry>>()
  const tasks = new Map<string, { task: Promise<Refresh>; force: boolean; network: boolean }>()
  const listeners = new Set<() => void>()
  let active: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  function message(err: unknown) {
    if (err instanceof Error) return err.message
    return String(err)
  }

  function filepath(key: string) {
    return path.join(Global.Path.cache, `codex-models-${key}.json`)
  }

  function compatible(version?: string | null) {
    if (!version) return true
    if (!semver.valid(version)) return false
    return semver.lte(version, VERSION)
  }

  function parse(content: string) {
    const data = Response.parse(JSON.parse(content))
    return [...new Set(data.models.filter((x) => x.visibility === "list" && compatible(x.minimal_client_version)).map((x) => x.slug))].sort()
  }

  async function read(key: string) {
    return Filesystem.readJson<unknown>(filepath(key))
      .then(Cache.parse)
      .catch(() => undefined)
  }

  async function write(entry: Entry) {
    if (!entry.disk || !entry.models?.length || !entry.status.hash) return
    const file = filepath(entry.key)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await Filesystem.writeJson(tmp, {
      version: 1,
      clientVersion: VERSION,
      checkedAt: entry.status.checkedAt,
      updatedAt: entry.status.updatedAt,
      etag: entry.status.etag,
      hash: entry.status.hash,
      error: entry.status.error,
      models: entry.models,
    })
    await fs.rename(tmp, file).catch(async (err) => {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    })
  }

  async function download(input: Download) {
    const checkedAt = Date.now()
    const headers = new Headers({ "User-Agent": Installation.USER_AGENT })
    if (input.previous.etag) headers.set("If-None-Match", input.previous.etag)
    const response = await input
      .fetcher(URL, {
        headers,
        signal: AbortSignal.timeout(input.timeout ?? 10 * 1000),
      })
      .catch((err) => {
        throw new Error(`Failed to fetch Codex models: ${message(err)}`)
      })

    if (response.status === 304) {
      if (!input.models?.length || !input.previous.hash) throw new Error("Codex models returned 304 without a cache")
      return {
        status: {
          ...input.previous,
          enabled: true,
          checkedAt,
          etag: response.headers.get("etag") ?? input.previous.etag,
          error: null,
        },
        models: input.models,
        changed: false,
      }
    }
    if (!response.ok) throw new Error(`Failed to fetch Codex models: ${response.status}`)

    const models = parse(await response.text())
    if (models.length === 0) throw new Error("Codex models returned no compatible visible models")
    const hash = Hash.fast(models.join("\n"))
    const changed = hash !== input.previous.hash
    return {
      status: {
        enabled: true,
        source: "remote" as const,
        checkedAt,
        updatedAt: changed ? checkedAt : input.previous.updatedAt,
        etag: response.headers.get("etag"),
        hash,
        error: null,
      },
      models,
      changed,
    }
  }

  async function load(input: Input, key: string, disk: boolean) {
    const existing = entries.get(key)
    if (existing) {
      existing.fetcher = input.fetcher
      return existing
    }

    const saved = disk ? await read(key) : undefined
    const entry: Entry = {
      key,
      disk,
      fetcher: input.fetcher,
      status: saved
        ? {
            enabled: true,
            source: "cache",
            checkedAt: saved.checkedAt,
            updatedAt: saved.updatedAt,
            etag: saved.etag,
            hash: saved.hash,
            error: saved.error,
          }
        : { ...empty, enabled: true, source: "fallback" },
      models: saved?.models,
    }
    entries.set(key, entry)
    return entry
  }

  function start() {
    if (timer) return
    timer = setInterval(() => void refresh(), interval)
    timer.unref()
  }

  function select(entry: Entry) {
    return entry.models ? new Set(entry.models) : undefined
  }

  function fresh(entry: Entry) {
    return !!entry.status.checkedAt && Date.now() - entry.status.checkedAt < ttl
  }

  async function run(entry: Entry, force: boolean): Promise<Refresh> {
    if (!force && fresh(entry)) {
      return { ...entry.status, changed: false }
    }

    try {
      const result = await download({
        previous: entry.status,
        models: entry.models,
        fetcher: entry.fetcher,
      })
      entry.status = result.status
      entry.models = result.models
      await write(entry).catch((err) => log.warn("failed to write Codex models cache", { error: err }))
      if (!result.changed || active !== entry.key || !result.status.hash || !result.status.updatedAt) {
        return { ...result.status, changed: result.changed }
      }

      for (const fn of listeners) fn()
      ProviderModels.emit({
        checkedAt: result.status.checkedAt!,
        updatedAt: result.status.updatedAt,
        hash: result.status.hash,
        source: "codex",
      })
      return { ...result.status, changed: true }
    } catch (err) {
      entry.status = {
        ...entry.status,
        enabled: true,
        checkedAt: Date.now(),
        error: message(err),
      }
      await write(entry).catch((cause) => log.warn("failed to write Codex models cache", { error: cause }))
      log.warn("failed to refresh Codex models", { error: err })
      return { ...entry.status, changed: false }
    }
  }

  function once(entry: Entry, force: boolean): Promise<Refresh> {
    const pending = tasks.get(entry.key)
    if (pending) {
      if (!force || pending.force || pending.network) return pending.task
      return pending.task.then(() => once(entry, true))
    }
    const task = run(entry, force).finally(() => tasks.delete(entry.key))
    tasks.set(entry.key, { task, force, network: force || !fresh(entry) })
    return task
  }

  export async function activate(input: Input) {
    const disk = !!input.identity
    const key = Hash.fast(input.identity ?? input.seed)
    active = key
    const pending = loads.get(key) ?? load(input, key, disk).finally(() => loads.delete(key))
    loads.set(key, pending)
    const entry = await pending
    entry.fetcher = input.fetcher
    start()
    void once(entry, false)
    return select(entry)
  }

  export function refresh(options?: { force?: boolean }) {
    const entry = active ? entries.get(active) : undefined
    if (!entry) return Promise.resolve({ ...empty, changed: false })
    return once(entry, options?.force ?? false)
  }

  export function status(enabled = !!active): Status {
    if (!enabled) return empty
    const entry = active ? entries.get(active) : undefined
    return entry?.status ?? { ...empty, enabled: true, source: "fallback" }
  }

  export function onUpdated(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  export const Test = {
    parse,
    download,
    once,
    filepath,
    key: Hash.fast,
    prime(input: { identity?: string; seed: string; models: string[] }) {
      const key = Hash.fast(input.identity ?? input.seed)
      const hash = Hash.fast(input.models.slice().sort().join("\n"))
      active = key
      entries.set(key, {
        key,
        disk: !!input.identity,
        fetcher: fetch,
        status: {
          enabled: true,
          source: "remote",
          checkedAt: Date.now(),
          updatedAt: Date.now(),
          etag: null,
          hash,
          error: null,
        },
        models: input.models.slice().sort(),
      })
    },
    reset() {
      active = undefined
      entries.clear()
      loads.clear()
      tasks.clear()
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
