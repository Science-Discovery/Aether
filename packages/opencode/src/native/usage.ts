import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Codex } from "./codex"

export namespace NativeUsage {
  const Window = z.object({
    usedPercent: z.number().finite().nonnegative(),
    windowDurationMins: z.number().int().positive().optional(),
    resetsAt: z.number().int().nonnegative().optional(),
  })
  const Limit = z.object({
    id: z.string(),
    name: z.string().optional(),
    primary: Window.optional(),
    secondary: Window.optional(),
  })
  export const Status = z
    .object({
      enabled: z.boolean(),
      state: z.enum(["available", "unavailable", "disabled"]),
      updatedAt: z.number().optional(),
      limits: z.array(Limit),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeUsageStatus" })
  export type Status = z.infer<typeof Status>

  const object = z.record(z.string(), z.unknown())
  const cache: { key?: string; value?: { promise: Promise<Status>; expires: number } } = {}

  function window(value: unknown) {
    const raw = object.safeParse(value)
    if (!raw.success) return
    const parsed = Window.safeParse({
      usedPercent: raw.data.usedPercent,
      windowDurationMins: raw.data.windowDurationMins ?? undefined,
      resetsAt: raw.data.resetsAt ?? undefined,
    })
    return parsed.success ? parsed.data : undefined
  }

  export function parse(value: unknown): Status {
    const parsed = object.safeParse(value)
    const buckets = object.safeParse(parsed.success ? parsed.data.rateLimitsByLimitId : undefined)
    const entries = buckets.success
      ? Object.entries(buckets.data)
      : [["codex", parsed.success ? parsed.data.rateLimits : undefined]]
    const limits = entries.flatMap(([id, value]) => {
      const raw = object.safeParse(value)
      if (!raw.success) return []
      const primary = window(raw.data.primary)
      const secondary = window(raw.data.secondary)
      if (!primary && !secondary) return []
      return [
        {
          id: buckets.success ? String(id) : typeof raw.data.limitId === "string" ? raw.data.limitId : "codex",
          name: typeof raw.data.limitName === "string" ? raw.data.limitName : undefined,
          primary,
          secondary,
        },
      ]
    })
    return { enabled: true, state: limits.length ? "available" : "unavailable", limits, updatedAt: Date.now() }
  }

  export function invalidate() {
    cache.key = undefined
    cache.value = undefined
  }

  async function probe(file?: string): Promise<Status> {
    const opened = await Codex.connect({ executable: file, signal: AbortSignal.timeout(20_000) })
    return opened.client
      .request("account/rateLimits/read", {}, { timeout: 15_000 })
      .then(parse)
      .finally(() => opened.client.close())
  }

  export async function read(opts: { refresh?: boolean } = {}): Promise<Status> {
    const cfg = (await Config.getGlobal()).native?.codex
    if (cfg?.enabled === false) {
      invalidate()
      return { enabled: false, state: "disabled", limits: [] }
    }
    const key = JSON.stringify([Global.Path.config, process.env.CODEX_HOME ?? "", cfg?.path?.trim() ?? ""])
    const previous = cache.key === key ? cache.value : undefined
    const value =
      previous && (previous.expires === Infinity || (!opts.refresh && previous.expires > Date.now()))
        ? previous
        : {
            expires: Infinity,
            promise: probe(cfg?.path).catch(
              (): Status => ({
                enabled: true,
                state: "unavailable",
                limits: [],
                error: "Codex account usage is unavailable. Check the connection or try again.",
              }),
            ),
          }
    cache.key = key
    cache.value = value
    const result = await value.promise
    if (value.expires === Infinity) value.expires = Date.now() + (result.state === "available" ? 60_000 : 5_000)
    const current = (await Config.getGlobal()).native?.codex
    if (current?.enabled === false) return { enabled: false, state: "disabled", limits: [] }
    if (key !== JSON.stringify([Global.Path.config, process.env.CODEX_HOME ?? "", current?.path?.trim() ?? ""]))
      return { enabled: true, state: "unavailable", limits: [] }
    return result
  }
}
