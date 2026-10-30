import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { registerDisposer } from "@/effect/instance-registry"
import { Instance } from "@/project/instance"
import { Codex } from "./codex"
import { NativeMcp } from "./mcp"
import { NativeRuntime } from "./runtime"
import type { Protocol } from "./protocol"

export namespace NativeMcpAuth {
  export const Input = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(200) }).strict()
  export const Status = z
    .object({
      id: z.string().uuid(),
      name: z.string().optional(),
      state: z.enum(["starting", "pending", "complete", "failed", "cancelled", "expired"]),
      url: z.string().optional(),
      expiresAt: z.number().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeMcpAuthStatus" })
  export type Status = z.infer<typeof Status>
  const response = z.object({ authorizationUrl: z.string(), loginId: z.string().min(1).nullish() })
  const notification = z.object({
    name: z.string(),
    success: z.boolean(),
    loginId: z.string().nullish(),
    threadId: z.string().nullish(),
  })
  type Settings = { enabled?: boolean; path?: string; key: string }
  type Entry = {
    status: Status
    directory: string
    controller: AbortController
    key?: string
    client?: Protocol.Client
    home?: string
    login?: string | null
    early: z.infer<typeof notification>[]
    timer?: ReturnType<typeof setTimeout>
    off?: () => void
    pending?: Promise<Status>
    closing?: Promise<void>
    completing?: boolean
  }
  const active = (entry: Entry) => entry.status.state === "starting" || entry.status.state === "pending"

  function url(value: string) {
    const parsed = new URL(value)
    if (
      value.length > 16_384 ||
      /[\u0000-\u0020\u007f]/.test(value) ||
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Codex returned an invalid MCP authorization URL.")
    return parsed.href
  }

  export function create(opts: {
    read: () => Promise<Settings>
    open: (opts: {
      executable?: string
      cwd: string
      signal: AbortSignal
      onNotification: Protocol.Options["onNotification"]
    }) => Promise<{ client: Protocol.Client; home?: string }>
    changed?: (input: { directory: string; home: string }) => Promise<boolean>
    timeout?: number
    retain?: number
  }) {
    const entries = new Map<string, Entry>()

    function finish(entry: Entry, state: Status["state"], error?: string) {
      if (!active(entry)) return entry.closing ?? Promise.resolve()
      clearTimeout(entry.timer)
      entry.off?.()
      entry.early.length = 0
      entry.status = { id: entry.status.id, name: entry.status.name, state, ...(error ? { error } : {}) }
      entry.timer = setTimeout(() => entries.delete(entry.status.id), opts.retain ?? 30 * 60_000)
      entry.timer.unref()
      // MCP has no cancel-login RPC. This connection belongs only to this
      // authorization attempt; closing it must never interrupt a chat client.
      entry.controller.abort()
      entry.closing = Promise.resolve(entry.client?.close())
        .catch(() => undefined)
        .finally(() => {
          entry.closing = undefined
        })
      return entry.closing
    }

    async function complete(entry: Entry, success: boolean) {
      if (!active(entry) || entry.completing) return
      entry.completing = true
      entry.off?.()
      const cfg = await opts.read().catch(() => undefined)
      if (!active(entry)) return
      if (!cfg || cfg.enabled === false || cfg.key !== entry.key)
        return finish(entry, "cancelled", "Codex settings changed. Start MCP sign-in again.")
      const refreshed =
        success && entry.home && opts.changed
          ? await opts.changed({ directory: entry.directory, home: entry.home }).catch(() => false)
          : true
      if (!active(entry)) return
      return finish(
        entry,
        success ? "complete" : "failed",
        !success
          ? "MCP sign-in was not completed."
          : refreshed
            ? undefined
            : "Authorization completed, but existing conversations could not refresh their MCP tools. Finish active work, then use /release and continue the conversation to reconnect.",
      )
    }

    async function begin(entry: Entry) {
      const cfg = await opts.read()
      if (!active(entry)) return { ...entry.status }
      if (cfg.enabled === false) {
        await finish(entry, "failed", "Enable Codex before signing in to an MCP service.")
        return { ...entry.status }
      }
      entry.key = cfg.key
      const opened = await opts.open({
        executable: cfg.path,
        cwd: entry.directory,
        signal: entry.controller.signal,
        onNotification(method, value) {
          if (method !== "mcpServer/oauthLogin/completed" || !active(entry)) return
          const parsed = notification.safeParse(value)
          if (!parsed.success || parsed.data.name !== entry.status.name || parsed.data.threadId != null) return
          if (entry.login === undefined) {
            if (entry.early.length < 8) entry.early.push(parsed.data)
            return
          }
          if ((parsed.data.loginId ?? null) === entry.login) void complete(entry, parsed.data.success)
        },
      })
      entry.client = opened.client
      entry.home = opened.home
      if (!active(entry)) {
        await entry.client.close().catch(() => undefined)
        return { ...entry.status }
      }
      entry.off = entry.client.onExit(() => {
        void finish(entry, "failed", "Codex closed before MCP sign-in completed. Try again.")
      })
      const catalog = await NativeMcp.list(entry.client)
      const server = catalog.servers.find((server) => server.name === entry.status.name)
      if (!active(entry)) return { ...entry.status }
      if (!server || !["notLoggedIn", "oAuth"].includes(server.auth)) {
        await finish(entry, "failed", "This configured MCP service does not report OAuth sign-in support.")
        return { ...entry.status }
      }
      const current = await opts.read()
      if (!active(entry)) return { ...entry.status }
      if (current.enabled === false || current.key !== entry.key) {
        await finish(entry, "cancelled", "Codex settings changed. Start MCP sign-in again.")
        return { ...entry.status }
      }
      const result = response.parse(
        await entry.client.request(
          "mcpServer/oauth/login",
          { name: entry.status.name, timeoutSecs: Math.ceil((opts.timeout ?? 10 * 60_000) / 1000) },
          { timeout: 30_000 },
        ),
      )
      entry.login = result.loginId ?? null
      if (!active(entry)) {
        await entry.client.close().catch(() => undefined)
        return { ...entry.status }
      }
      const address = url(result.authorizationUrl)
      const early = entry.early.find((event) => (event.loginId ?? null) === entry.login)
      entry.early.length = 0
      entry.status = { ...entry.status, state: "pending", url: address }
      if (early) await complete(entry, early.success)
      return { ...entry.status }
    }

    function scoped(id: string, directory: string) {
      const entry = entries.get(id)
      if (entry && entry.directory !== directory) throw new Error("This MCP sign-in belongs to another project.")
      return entry
    }

    function start(input: z.infer<typeof Input>, directory: string) {
      const previous = scoped(input.id, directory)
      if (previous) {
        if (previous.status.name && previous.status.name !== input.name)
          return Promise.reject(new Error("This MCP sign-in identity belongs to another service."))
        return previous.pending ?? Promise.resolve({ ...previous.status })
      }
      if ([...entries.values()].some((entry) => active(entry) || entry.closing))
        return Promise.reject(new Error("Another MCP sign-in is already in progress. Complete or cancel it first."))
      const entry: Entry = {
        status: { ...input, state: "starting", expiresAt: Date.now() + (opts.timeout ?? 10 * 60_000) },
        directory,
        controller: new AbortController(),
        early: [],
      }
      entries.set(input.id, entry)
      entry.timer = setTimeout(() => void finish(entry, "expired"), opts.timeout ?? 10 * 60_000)
      entry.timer.unref()
      entry.pending = begin(entry)
        .catch(async () => {
          await finish(
            entry,
            "failed",
            "Unable to start MCP sign-in. Check the service configuration and Codex version.",
          )
          return { ...entry.status }
        })
        .finally(() => {
          entry.pending = undefined
        })
      return entry.pending
    }

    async function read(id: string, directory: string) {
      const entry = scoped(id, directory)
      if (!entry) throw new Error("This MCP sign-in is no longer available. Start again.")
      if (active(entry) && entry.key) {
        const cfg = await opts.read().catch(() => undefined)
        if (!cfg || cfg.enabled === false || cfg.key !== entry.key)
          await finish(entry, "cancelled", "Codex settings changed. Start MCP sign-in again.")
      }
      return { ...entry.status }
    }

    async function cancel(id: string, directory: string) {
      const entry = scoped(id, directory)
      if (entry) {
        await finish(entry, "cancelled")
        return { ...entry.status }
      }
      // Keep an identity tombstone if DELETE overtakes POST, so a delayed
      // network response cannot start another authorization flow.
      const cancelled: Entry = {
        status: { id, state: "starting" },
        directory,
        controller: new AbortController(),
        early: [],
      }
      entries.set(id, cancelled)
      await finish(cancelled, "cancelled")
      return { ...cancelled.status }
    }

    async function dispose(directory?: string) {
      const selected = [...entries.values()].filter((entry) => directory === undefined || entry.directory === directory)
      await Promise.all(selected.map((entry) => finish(entry, "cancelled")))
      await Promise.all(selected.map((entry) => entry.pending))
      selected.forEach((entry) => {
        clearTimeout(entry.timer)
        entries.delete(entry.status.id)
      })
    }
    return { start, read, cancel, dispose }
  }

  const manager = create({
    async read() {
      const cfg = (await Config.getGlobal()).native?.codex
      return {
        enabled: cfg?.enabled,
        path: cfg?.path,
        key: JSON.stringify([Global.Path.config, process.env.CODEX_HOME ?? "", cfg?.path?.trim() ?? ""]),
      }
    },
    open: (opts) => Codex.connect(opts),
    changed: (input) => NativeRuntime.refresh(input),
  })
  export const start = (input: z.infer<typeof Input>) => manager.start(input, Instance.directory)
  export const read = (id: string) => manager.read(id, Instance.directory)
  export const cancel = (id: string) => manager.cancel(id, Instance.directory)
  registerDisposer(manager.dispose)
}
