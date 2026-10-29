import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { registerDisposer } from "@/effect/instance-registry"
import { Instance } from "@/project/instance"
import { Codex } from "./codex"
import { Protocol } from "./protocol"
import { NativeUsage } from "./usage"

export namespace NativeAuth {
  export const Input = z.object({ id: z.string().uuid(), method: z.enum(["browser", "device"]) }).strict()
  export const Status = z
    .object({
      id: z.string().uuid(),
      method: z.enum(["browser", "device"]),
      state: z.enum(["starting", "pending", "complete", "failed", "cancelled", "expired"]),
      url: z.string().optional(),
      code: z.string().optional(),
      expiresAt: z.number().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeAuthStatus" })
  export type Status = z.infer<typeof Status>

  const response = z.discriminatedUnion("type", [
    z.object({ type: z.literal("chatgpt"), loginId: z.string().min(1), authUrl: z.string() }),
    z.object({
      type: z.literal("chatgptDeviceCode"),
      loginId: z.string().min(1),
      verificationUrl: z.string(),
      userCode: z.string().min(1).max(128),
    }),
  ])
  const notification = z.object({ loginId: z.string(), success: z.boolean() })
  type Settings = { enabled?: boolean; path?: string; key: string }
  type Entry = {
    status: Status
    controller: AbortController
    key?: string
    directory?: string
    client?: Protocol.Client
    login?: string
    early: Map<string, boolean>
    timer?: ReturnType<typeof setTimeout>
    off?: () => void
    pending?: Promise<Status>
    closing?: Promise<void>
  }

  function active(entry: Entry) {
    return entry.status.state === "starting" || entry.status.state === "pending"
  }

  function url(value: string) {
    const parsed = new URL(value)
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(parsed.hostname)
    )
      throw new Error("Codex returned an unsupported login URL.")
    return parsed.href
  }

  // Separate managers are used only by isolated tests. Production shares one
  // login across projects because credentials belong to the Codex installation.
  export function create(opts: {
    read: () => Promise<Settings>
    open: (opts: {
      executable?: string
      signal: AbortSignal
      onNotification: Protocol.Options["onNotification"]
    }) => Promise<Protocol.Client>
    changed: () => void
    timeout?: number
    retain?: number
  }) {
    const entries = new Map<string, Entry>()

    function remember(entry: Entry) {
      entries.set(entry.status.id, entry)
      for (const [id, old] of entries) {
        if (entries.size <= 20) break
        if (active(old) || old.closing) continue
        clearTimeout(old.timer)
        entries.delete(id)
      }
    }

    function finish(entry: Entry, state: Status["state"], error?: string) {
      if (!active(entry)) return entry.closing ?? Promise.resolve()
      clearTimeout(entry.timer)
      entry.off?.()
      entry.early.clear()
      entry.status = { id: entry.status.id, method: entry.status.method, state, ...(error ? { error } : {}) }
      entry.timer = setTimeout(() => entries.delete(entry.status.id), opts.retain ?? 30 * 60_000)
      entry.timer.unref()
      if (state === "complete") opts.changed()
      entry.closing = (async () => {
        if (entry.client && entry.login && state !== "complete")
          await entry.client
            .request("account/login/cancel", { loginId: entry.login }, { timeout: 3_000 })
            .catch(() => undefined)
        entry.controller.abort()
        await entry.client?.close().catch(() => undefined)
      })().finally(() => {
        entry.closing = undefined
      })
      return entry.closing
    }

    async function complete(entry: Entry, success: boolean) {
      if (!active(entry)) return
      // The completion event is authoritative even if the process exits while
      // we verify that the user has not changed the selected installation.
      entry.off?.()
      const cfg = await opts.read().catch(() => undefined)
      if (!active(entry)) return
      if (!cfg || cfg.enabled === false || cfg.key !== entry.key)
        return finish(entry, "cancelled", "Codex settings changed. Start sign-in again.")
      return finish(
        entry,
        success ? "complete" : "failed",
        success ? undefined : "Codex sign-in was not completed. Try again or sign in with codex login.",
      )
    }

    async function begin(entry: Entry) {
      const cfg = await opts.read()
      if (!active(entry)) return entry.status
      if (cfg.enabled === false) {
        await finish(entry, "failed", "Enable Codex before signing in.")
        return entry.status
      }
      entry.key = cfg.key
      entry.client = await opts.open({
        executable: cfg.path,
        signal: entry.controller.signal,
        onNotification(method, value) {
          if (method !== "account/login/completed" || !active(entry)) return
          const parsed = notification.safeParse(value)
          if (!parsed.success) return
          if (!entry.login) {
            if (entry.early.size < 4) entry.early.set(parsed.data.loginId, parsed.data.success)
            return
          }
          if (parsed.data.loginId === entry.login) void complete(entry, parsed.data.success)
        },
      })
      if (!active(entry)) {
        await entry.client.close().catch(() => undefined)
        return entry.status
      }
      entry.off = entry.client.onExit(() => {
        void finish(entry, "failed", "Codex closed before sign-in completed. Please try again.")
      })
      const current = await opts.read()
      if (!active(entry)) return entry.status
      if (current.enabled === false || current.key !== entry.key) {
        await finish(entry, "cancelled", "Codex settings changed. Start sign-in again.")
        return entry.status
      }
      const result = response.parse(
        await entry.client.request(
          "account/login/start",
          { type: entry.status.method === "browser" ? "chatgpt" : "chatgptDeviceCode" },
          { timeout: 30_000 },
        ),
      )
      entry.login = result.loginId
      if (!active(entry)) {
        await entry.client.close().catch(() => undefined)
        return entry.status
      }
      if ((entry.status.method === "browser") !== (result.type === "chatgpt"))
        throw new Error("Codex returned a different login method.")
      const address = url(result.type === "chatgpt" ? result.authUrl : result.verificationUrl)
      const early = entry.early.get(result.loginId)
      entry.early.clear()
      entry.status = {
        ...entry.status,
        state: "pending",
        url: address,
        ...(result.type === "chatgptDeviceCode" ? { code: result.userCode } : {}),
      }
      if (early !== undefined) await complete(entry, early)
      return { ...entry.status }
    }

    function start(input: z.infer<typeof Input>, directory?: string) {
      const previous = entries.get(input.id)
      if (previous) {
        if (active(previous) && previous.status.method !== input.method)
          return Promise.reject(new Error("Cancel the current Codex sign-in before changing its method."))
        return previous.pending ?? Promise.resolve({ ...previous.status })
      }
      if ([...entries.values()].some((entry) => active(entry) || entry.closing))
        return Promise.reject(new Error("Another Codex sign-in is already in progress. Complete or cancel it first."))
      const entry: Entry = {
        status: { ...input, state: "starting", expiresAt: Date.now() + (opts.timeout ?? 10 * 60_000) },
        controller: new AbortController(),
        directory,
        early: new Map(),
      }
      remember(entry)
      entry.timer = setTimeout(() => void finish(entry, "expired"), opts.timeout ?? 10 * 60_000)
      entry.timer.unref()
      entry.pending = begin(entry)
        .catch(async () => {
          await finish(
            entry,
            "failed",
            "Unable to start Codex sign-in. Check the installation, update Codex, or use codex login.",
          )
          return { ...entry.status }
        })
        .finally(() => {
          entry.pending = undefined
        })
      return entry.pending
    }

    async function read(id: string) {
      const entry = entries.get(id)
      if (!entry) throw new Error("This Codex sign-in is no longer available. Start again.")
      if (active(entry) && entry.key) {
        const cfg = await opts.read().catch(() => undefined)
        if (!cfg) {
          await finish(entry, "failed", "Unable to read Codex settings. Check the configuration and try again.")
          return { ...entry.status }
        }
        if (cfg.enabled === false || cfg.key !== entry.key)
          await finish(entry, "cancelled", "Codex settings changed. Start sign-in again.")
      }
      return { ...entry.status }
    }

    async function cancel(id: string) {
      const entry = entries.get(id)
      if (entry) {
        await finish(entry, "cancelled")
        return { ...entry.status }
      }
      // A cancel request can reach the server before the corresponding POST.
      // Retain its identity so a delayed POST cannot reopen the login flow.
      const cancelled: Entry = {
        status: { id, method: "browser", state: "starting" },
        controller: new AbortController(),
        early: new Map(),
      }
      remember(cancelled)
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
    open: (opts) => Codex.connect(opts).then((opened) => opened.client),
    changed() {
      Codex.invalidate()
      NativeUsage.invalidate()
    },
  })
  export const start = (input: z.infer<typeof Input>) => manager.start(input, Instance.directory)
  export const read = manager.read
  export const cancel = manager.cancel
  export const dispose = manager.dispose
  registerDisposer(dispose)
}
