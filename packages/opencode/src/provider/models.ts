import { Global } from "../global"
import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "../util/filesystem"
import { apply } from "./models-local"
import { Hash } from "@/util/hash"
import { ProviderModels } from "./models-event"

declare const OPENCODE_MODELS_DEV: Record<string, ModelsDev.Provider> | undefined

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const ttl = 5 * 60 * 1000

  // Mirrors the API output contract in models.dev/packages/core/src/schema.ts.
  type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

  const JsonValue: z.ZodType<Json> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
  )
  const DateString = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/)
  const Modality = z.enum(["text", "audio", "image", "video", "pdf"])
  const Modalities = z
    .object({
      input: z.array(Modality),
      output: z.array(Modality),
    })
    .strict()
  const Cost = z.object({
    input: z.number().min(0),
    output: z.number().min(0),
    reasoning: z.number().min(0).optional(),
    cache_read: z.number().min(0).optional(),
    cache_write: z.number().min(0).optional(),
    input_audio: z.number().min(0).optional(),
    output_audio: z.number().min(0).optional(),
  })
  const Tier = Cost.extend({
    tier: z
      .object({
        type: z.literal("context").default("context"),
        size: z.number().int().min(0),
      })
      .strict(),
  }).strict()
  const OutputCost = Cost.extend({
    context_over_200k: Cost.optional(),
    tiers: z.array(Tier).optional(),
  })
  const ReasoningOption = z.discriminatedUnion("type", [
    z.object({ type: z.literal("toggle") }).strict(),
    z
      .object({
        type: z.literal("effort"),
        values: z.array(
          z.union([z.null(), z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"])]),
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("budget_tokens"),
        min: z.number().min(-1).optional(),
        max: z.number().min(0).optional(),
      })
      .strict(),
  ])
  const RemoteExperimental = z
    .object({
      modes: z
        .record(
          z.string(),
          z.object({
            cost: Cost.optional(),
            provider: z
              .object({
                body: z.record(z.string(), JsonValue).optional(),
                headers: z.record(z.string(), z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .strict()
  const RemoteModelProvider = z
    .object({
      npm: z.string().optional(),
      api: z.string().optional(),
      shape: z.enum(["responses", "completions"]).optional(),
      body: z.record(z.string(), JsonValue).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict()
  const Body = z.record(z.string(), z.unknown())
  const Experimental = z
    .object({
      modes: z
        .record(
          z.string(),
          z.object({
            cost: Cost.optional(),
            provider: z
              .object({
                body: Body.optional(),
                headers: z.record(z.string(), z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .strict()
  const ModelProvider = z
    .object({
      npm: z.string().optional(),
      api: z.string().optional(),
      shape: z.enum(["responses", "completions"]).optional(),
      body: Body.optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict()

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    family: z.string().optional(),
    release_date: z.string(),
    last_updated: z.string().optional(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    reasoning_options: z.array(ReasoningOption).optional(),
    temperature: z.boolean().default(false),
    tool_call: z.boolean(),
    structured_output: z.boolean().optional(),
    knowledge: z.string().optional(),
    open_weights: z.boolean().optional(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: OutputCost.optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: Modalities.optional(),
    experimental: Experimental.optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()).default({}),
    headers: z.record(z.string(), z.string()).optional(),
    provider: ModelProvider.optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    doc: z.string().optional(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })
  export type Provider = z.infer<typeof Provider>

  const Database = z.record(z.string(), Provider)
  const RemoteModel = z
    .object({
      id: z.string(),
      name: z.string().min(1),
      description: z.string().min(1),
      family: z.string().optional(),
      attachment: z.boolean(),
      reasoning: z.boolean(),
      reasoning_options: z.array(ReasoningOption).optional(),
      tool_call: z.boolean(),
      interleaved: Model.shape.interleaved,
      structured_output: z.boolean().optional(),
      temperature: z.boolean().optional(),
      knowledge: DateString.optional(),
      release_date: DateString,
      last_updated: DateString,
      modalities: Modalities,
      open_weights: z.boolean(),
      limit: z
        .object({
          context: z.number().min(0),
          input: z.number().min(0).optional(),
          output: z.number().min(0),
        })
        .strict(),
      status: Model.shape.status,
      experimental: RemoteExperimental.optional(),
      provider: RemoteModelProvider.optional(),
      cost: OutputCost.optional(),
    })
    .strict()
  const RemoteProvider = z
    .object({
      id: z.string(),
      env: z.array(z.string()).min(1),
      npm: z.string().min(1),
      api: z.string().optional(),
      name: z.string().min(1),
      doc: z.string().min(1),
      models: z.record(z.string(), RemoteModel),
    })
    .strict()
  const RemoteDatabase = z.record(z.string(), RemoteProvider)

  export const Source = z.enum(["path", "cache", "embedded", "remote", "none"])
  export type Source = z.infer<typeof Source>

  export const Status = z
    .object({
      source: Source,
      checkedAt: z.number().nullable(),
      updatedAt: z.number().nullable(),
      etag: z.string().nullable(),
      hash: z.string().nullable(),
      error: z.string().nullable(),
    })
    .meta({ ref: "ModelsDevStatus" })
  export type Status = z.infer<typeof Status>

  export const Refresh = Status.extend({ changed: z.boolean() })
  export type Refresh = z.infer<typeof Refresh>

  const Meta = Status.omit({ source: true })

  export const Event = ProviderModels.Event

  const empty: Status = {
    source: "none",
    checkedAt: null,
    updatedAt: null,
    etag: null,
    hash: null,
    error: null,
  }

  let current: Status | undefined
  let task: Promise<Refresh> | undefined
  const listeners = new Set<() => void>()

  function url() {
    return Flag.OPENCODE_MODELS_URL || "https://models.dev"
  }

  function filepath() {
    if (!Flag.OPENCODE_MODELS_URL) return path.join(Global.Path.cache, "models.json")
    return path.join(Global.Path.cache, `models-${Hash.fast(url())}.json`)
  }

  function metapath(file: string) {
    return `${file}.meta.json`
  }

  function missing(e: unknown) {
    return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "ENOENT"
  }

  function message(e: unknown) {
    if (e instanceof Error) return e.message
    return String(e)
  }

  function parse(content: string) {
    return Database.parse(RemoteDatabase.parse(JSON.parse(content)))
  }

  async function read(file: string, cache: boolean, validate = true) {
    return Filesystem.readText(file)
      .then((content) => (validate ? parse(content) : (JSON.parse(content) as Record<string, Provider>)))
      .catch(async (e) => {
        if (missing(e)) return undefined
        if (cache) await fs.rm(file, { force: true }).catch(() => {})
        log.warn("failed to read models.dev data", {
          error: e,
          file,
        })
        return undefined
      })
  }

  async function meta(file: string) {
    return Filesystem.readJson<unknown>(metapath(file))
      .then((value) => Meta.parse(value))
      .catch((e) => {
        if (!missing(e)) log.warn("failed to read models.dev metadata", { error: e, file })
        return undefined
      })
  }

  async function write(file: string, content: string) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await Filesystem.write(tmp, content)
    await fs.rename(tmp, file).catch(async (e) => {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    })
  }

  async function writemeta(file: string, value: Status) {
    await write(
      metapath(file),
      JSON.stringify({
        checkedAt: value.checkedAt,
        updatedAt: value.updatedAt,
        etag: value.etag,
        hash: value.hash,
        error: value.error,
      }),
    )
  }

  function fresh(file: string) {
    const stat = Filesystem.stat(file)
    if (!stat) return false
    return Date.now() - Number(stat.mtimeMs) < ttl
  }

  async function hash(file: string) {
    return Filesystem.readText(file)
      .then(Hash.fast)
      .catch(() => null)
  }

  async function initial(): Promise<Status> {
    if (Flag.OPENCODE_MODELS_PATH) {
      const file = Flag.OPENCODE_MODELS_PATH
      const stat = Filesystem.stat(file)
      return {
        ...empty,
        source: "path",
        updatedAt: stat ? Number(stat.mtimeMs) : null,
        hash: await hash(file),
      }
    }

    const file = filepath()
    const saved = await meta(file)
    const stat = Filesystem.stat(file)
    if (stat) {
      return {
        source: "cache",
        checkedAt: saved?.checkedAt ?? null,
        updatedAt: saved?.updatedAt ?? Number(stat.mtimeMs),
        etag: saved?.etag ?? null,
        hash: saved?.hash ?? (await hash(file)),
        error: saved?.error ?? null,
      }
    }

    if (typeof OPENCODE_MODELS_DEV !== "undefined") {
      return {
        source: "embedded",
        checkedAt: saved?.checkedAt ?? null,
        updatedAt: saved?.updatedAt ?? null,
        etag: saved?.etag ?? null,
        hash: saved?.hash ?? Hash.fast(JSON.stringify(OPENCODE_MODELS_DEV)),
        error: saved?.error ?? null,
      }
    }
    return empty
  }

  export async function status() {
    if (current) return current
    current = await initial()
    return current
  }

  export const Data = lazy(async () => {
    const file = Flag.OPENCODE_MODELS_PATH ?? filepath()
    const result = await read(file, !Flag.OPENCODE_MODELS_PATH, !Flag.OPENCODE_MODELS_PATH)
    if (result) return result
    const fallback = typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : Database.parse(OPENCODE_MODELS_DEV)
    if (fallback) return fallback
    if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
    const response = await fetch(`${url()}/api.json`, {
      headers: { "User-Agent": Installation.USER_AGENT },
      signal: AbortSignal.timeout(10 * 1000),
    })
    if (!response.ok) throw new Error(`Failed to fetch models.dev: ${response.status}`)
    return parse(await response.text())
  })

  export async function get(): Promise<Record<string, Provider>> {
    return apply(await Data())
  }

  export function onUpdated(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  function snapshot(result: Refresh): Status {
    return {
      source: result.source,
      checkedAt: result.checkedAt,
      updatedAt: result.updatedAt,
      etag: result.etag,
      hash: result.hash,
      error: result.error,
    }
  }

  type Input = {
    file: string
    url: string
    force: boolean
    previous: Status
    fetcher: typeof fetch
    timeout?: number
  }

  async function download(input: Input): Promise<Refresh> {
    if (!input.force && fresh(input.file)) return { ...input.previous, changed: false }

    const checkedAt = Date.now()
    const headers: Record<string, string> = { "User-Agent": Installation.USER_AGENT }
    if (input.previous.etag) headers["If-None-Match"] = input.previous.etag

    const response = await input
      .fetcher(`${input.url}/api.json`, {
        headers,
        signal: AbortSignal.timeout(input.timeout ?? 10 * 1000),
      })
      .catch((e) => {
        throw new Error(`Failed to fetch models.dev: ${message(e)}`)
      })

    if (response.status === 304) {
      return {
        ...input.previous,
        source: Filesystem.stat(input.file) ? "cache" : input.previous.source,
        checkedAt,
        etag: response.headers.get("etag") ?? input.previous.etag,
        error: null,
        changed: false,
      }
    }
    if (!response.ok) throw new Error(`Failed to fetch models.dev: ${response.status}`)

    const content = await response.text()
    parse(content)
    const digest = Hash.fast(content)
    const previous = input.previous.hash ?? (await hash(input.file))
    const etag = response.headers.get("etag")
    if (digest === previous) {
      return {
        ...input.previous,
        source: Filesystem.stat(input.file) ? "cache" : input.previous.source,
        checkedAt,
        etag,
        hash: digest,
        error: null,
        changed: false,
      }
    }

    await write(input.file, content)
    return {
      source: "remote",
      checkedAt,
      updatedAt: checkedAt,
      etag,
      hash: digest,
      error: null,
      changed: true,
    }
  }

  async function run(force: boolean): Promise<Refresh> {
    if (Flag.OPENCODE_MODELS_PATH) return { ...(await status()), changed: false }
    const file = filepath()
    const previous = await status()

    try {
      const result = await download({
        file,
        url: url(),
        force,
        previous,
        fetcher: fetch,
      })
      current = snapshot(result)
      await writemeta(file, result).catch((e) => log.warn("failed to write models.dev metadata", { error: e }))
      if (!result.changed || !result.hash || !result.updatedAt || !result.checkedAt) return result

      Data.reset()
      for (const fn of listeners) fn()
      ProviderModels.emit({
        checkedAt: result.checkedAt,
        updatedAt: result.updatedAt,
        hash: result.hash,
        source: "models.dev",
      })
      return result
    } catch (e) {
      const result: Refresh = {
        ...previous,
        checkedAt: Date.now(),
        error: message(e),
        changed: false,
      }
      current = snapshot(result)
      await writemeta(file, result).catch((err) => log.warn("failed to write models.dev metadata", { error: err }))
      log.error("failed to refresh models.dev", { error: e })
      return result
    }
  }

  function once(fn: () => Promise<Refresh>) {
    if (task) return task
    task = fn().finally(() => {
      task = undefined
    })
    return task
  }

  export function refresh(options?: { force?: boolean }) {
    return once(() => run(options?.force ?? false))
  }

  export const Test = {
    download,
    once,
  }
}

if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
  void ModelsDev.refresh()
  setInterval(
    async () => {
      await ModelsDev.refresh()
    },
    60 * 1000 * 60,
  ).unref()
}
