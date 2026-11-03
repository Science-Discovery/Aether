import { createHash } from "node:crypto"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { NativeForm } from "./elicitation-schema"

/** Pending MCP requests stay on their originating connection, never in the chat transcript. */
export namespace NativeElicitation {
  const Action = z.enum(["accept", "decline", "cancel"])
  const base = {
    id: z.string(),
    sessionID: SessionID.zod,
    threadID: z.string(),
    server: z.string(),
    message: z.string(),
    expires: z.number(),
  }
  export const Info = z
    .discriminatedUnion("mode", [
      z.object({ ...base, mode: z.literal("form"), fields: z.array(NativeForm.Field) }),
      z.object({ ...base, mode: z.literal("url"), url: z.string() }),
    ])
    .meta({ ref: "NativeElicitation" })
  export const List = z.array(Info).meta({ ref: "NativeElicitations" })
  export const Input = z.object({
    sessionID: SessionID.zod,
    id: z.string().uuid(),
    action: Action,
    content: NativeForm.Content.nullish(),
  })
  export const Receipt = z.object({ id: z.string(), action: Action }).meta({ ref: "NativeElicitationReceipt" })
  export const Changed = BusEvent.define("native.elicitation.changed", z.object({ sessionID: SessionID.zod }))
  const Request = z.object({
    threadId: z.string().min(1),
    serverName: z.string().min(1).max(500),
    mode: z.enum(["form", "url"]),
    message: z.string().max(50_000),
    requestedSchema: z.unknown().optional(),
    url: z.string().max(10_000).optional(),
    elicitationId: z.string().optional(),
    nativeAgent: z.object({ threadId: z.string() }).passthrough().optional(),
  })
  type Result = { action: z.infer<typeof Action>; content: z.infer<typeof NativeForm.Content> | null }
  type Pending = { info: z.infer<typeof Info>; finish: (result: Result) => void }
  const state = Instance.state(
    () => ({
      pending: new Map<string, Pending>(),
      receipts: new Map<string, { session: SessionID; hash: string; time: number; action: z.infer<typeof Action> }>(),
    }),
    async (value) => {
      value.pending.forEach((item) => item.finish({ action: "cancel", content: null }))
      value.receipts.clear()
    },
  )

  async function session(id: SessionID) {
    const value = await Session.get(id)
    if (value.engine?.type !== "codex" || value.directory !== Instance.directory)
      throw new Error("This MCP request is not available in this project.")
    return value
  }

  export function active(id: SessionID) {
    return [...state().pending.values()].some((item) => item.info.sessionID === id)
  }

  export async function list(id: SessionID) {
    await session(id)
    return [...state().pending.values()].filter((item) => item.info.sessionID === id).map((item) => item.info)
  }

  export async function ask(id: SessionID, value: unknown, signal: AbortSignal) {
    const parsed = Request.safeParse(value)
    if (!parsed.success) throw new Error("This MCP elicitation format is not supported.")
    const data = parsed.data
    const owner = await session(id)
    if (owner.engine?.thread !== data.threadId) throw new Error("MCP request belongs to a different Codex thread.")
    signal.throwIfAborted()
    const common = {
      id: crypto.randomUUID(),
      sessionID: id,
      threadID: data.nativeAgent?.threadId ?? data.threadId,
      server: data.serverName,
      message: data.message,
      expires: Date.now() + 15 * 60_000,
    }
    const info = Info.parse(
      data.mode === "form"
        ? { ...common, mode: "form", fields: NativeForm.parse(data.requestedSchema) }
        : { ...common, mode: "url", url: data.url },
    )
    if (info.mode === "url") {
      const url = URL.parse(info.url)
      if (!data.elicitationId || !url || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error("The MCP authorization URL is not supported.")
    }
    const current = state()
    if (current.pending.size >= 64) throw new Error("Too many pending MCP requests.")
    const result = Promise.withResolvers<Result>()
    const abort = () => finish({ action: "cancel", content: null })
    const timer = setTimeout(abort, Math.max(0, info.expires - Date.now()))
    timer.unref()
    const notify = () => {
      void Bus.publish(Changed, { sessionID: id }).catch(() => undefined)
    }
    function finish(value: Result) {
      if (!current.pending.delete(info.id)) return
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      result.resolve(value)
      notify()
    }
    current.pending.set(info.id, { info, finish })
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    notify()
    return result.promise
  }

  export async function reply(input: z.infer<typeof Input>) {
    await session(input.sessionID)
    const current = state()
    const response = { action: input.action, content: input.content ?? null }
    if (input.action !== "accept" && response.content !== null)
      throw new Error("Declined or cancelled forms cannot contain answers.")
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          action: input.action,
          content:
            response.content === null ? null : Object.entries(response.content).sort(([a], [b]) => a.localeCompare(b)),
        }),
      )
      .digest("hex")
    current.receipts.forEach((item, id) => {
      if (Date.now() - item.time > 60_000) current.receipts.delete(id)
    })
    const saved = current.receipts.get(input.id)
    if (saved) {
      if (saved.session !== input.sessionID || saved.hash !== hash)
        throw new Error("This MCP request was already answered.")
      return { id: input.id, action: saved.action }
    }
    const item = current.pending.get(input.id)
    if (!item || item.info.sessionID !== input.sessionID)
      throw new Error("This MCP request has expired or was withdrawn. Refresh the conversation.")
    if (Date.now() >= item.info.expires) {
      item.finish({ action: "cancel", content: null })
      throw new Error("This MCP request has expired.")
    }
    if (input.action === "accept") {
      if (item.info.mode === "form") response.content = NativeForm.content(item.info.fields, input.content)
      if (item.info.mode === "url" && response.content !== null)
        throw new Error("URL authorization cannot include form answers.")
    }
    current.receipts.set(input.id, { session: input.sessionID, hash, time: Date.now(), action: input.action })
    if (current.receipts.size > 128) current.receipts.delete(current.receipts.keys().next().value!)
    item.finish(response)
    return { id: input.id, action: input.action }
  }
}
