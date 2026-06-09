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

declare const OPENCODE_MODELS_DEV: Record<string, ModelsDev.Provider> | undefined

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const ttl = 5 * 60 * 1000

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
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
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  function url() {
    return Flag.OPENCODE_MODELS_URL || "https://models.dev"
  }

  function filepath() {
    if (!Flag.OPENCODE_MODELS_URL) return path.join(Global.Path.cache, "models.json")
    return path.join(Global.Path.cache, `models-${Hash.fast(url())}.json`)
  }

  function missing(e: unknown) {
    return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "ENOENT"
  }

  async function read(file: string, cache: boolean) {
    return Filesystem.readJson<Record<string, Provider>>(file).catch(async (e) => {
      if (missing(e)) return undefined
      if (cache) await fs.rm(file, { force: true }).catch(() => {})
      log.warn("failed to read models.dev data", {
        error: e,
        file,
      })
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

  function fresh(file: string) {
    const stat = Filesystem.stat(file)
    if (!stat) return false
    return Date.now() - Number(stat.mtimeMs) < ttl
  }

  export const Data = lazy(async () => {
    const file = Flag.OPENCODE_MODELS_PATH ?? filepath()
    const result = await read(file, !Flag.OPENCODE_MODELS_PATH)
    if (result) return result
    const fallback = typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : OPENCODE_MODELS_DEV
    if (fallback) return fallback
    if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
    const json = await fetch(`${url()}/api.json`).then((x) => x.text())
    return JSON.parse(json)
  })

  export async function get(): Promise<Record<string, Provider>> {
    const result = (await Data()) as Record<string, Provider>
    return apply(result)
  }

  export async function refresh() {
    if (Flag.OPENCODE_MODELS_PATH) return
    const file = filepath()
    if (fresh(file)) return
    const result = await fetch(`${url()}/api.json`, {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
    if (result && result.ok) {
      await write(file, await result.text())
      ModelsDev.Data.reset()
    }
  }
}

if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
  ModelsDev.refresh()
  setInterval(
    async () => {
      await ModelsDev.refresh()
    },
    60 * 1000 * 60,
  ).unref()
}
