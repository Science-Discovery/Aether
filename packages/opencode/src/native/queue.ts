import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "@/provider/schema"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { NativeSession } from "./session"
import { NativeStore } from "./store"
import { Native } from "./schema"
import { NativeInput } from "./input"

/** Pending user requests, separate from model-visible history and delivered input. */
export namespace NativeQueue {
  export const Input = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    text: z.string().trim().max(65_536),
    parts: Native.Parts.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    effort: z.string().trim().min(1).max(40).optional(),
  })
  const Item = z.object({
    id: MessageID.zod,
    text: Input.shape.text,
    model: Input.shape.model,
    effort: Input.shape.effort,
    attachments: z.array(z.object({ filename: z.string().optional(), mime: z.string() })).optional(),
    state: z.enum(["pending", "dispatching", "uncertain", "failed"]),
    turn: z.string().optional(),
    delivery: Native.Steered.optional(),
    error: z.string().optional(),
    created: z.number(),
  })
  export const Status = z
    .object({
      paused: z.boolean(),
      reason: z.string().optional(),
      items: z.array(Item),
    })
    .meta({ ref: "NativeQueueStatus" })
  export const Send = z
    .object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      turnID: z.string().min(1),
    })
    .strict()
  export const Sent = z.object({ queue: Status, delivery: Native.Steered }).meta({ ref: "NativeQueueSent" })
  type Sent = z.infer<typeof Sent>
  const Saved = Status.extend({ owner: z.string(), items: z.array(Item.extend({ parts: Native.Parts.optional() })) })
  type Saved = z.infer<typeof Saved>
  const log = Log.create({ service: "native.queue" })
  const state = Instance.state(
    () => ({
      owner: crypto.randomUUID(),
      closed: false,
      jobs: new Map<SessionID, Promise<void>>(),
      sends: new Map<SessionID, Map<MessageID, { turn: string; result: Promise<Sent> }>>(),
      wakes: new Set<SessionID>(),
      halted: new Set<SessionID>(),
    }),
    async (value) => {
      value.closed = true
    },
  )

  export async function home<T>(id: SessionID, fn: () => Promise<T>): Promise<T> {
    const session = await Session.getGlobal(id)
    if (session.engine?.type !== "codex") throw new Error("This session does not use Codex.")
    if (Filesystem.resolve(session.directory) !== Instance.directory)
      return Instance.provide({ directory: session.directory, fn })
    return fn()
  }

  function file(id: SessionID) {
    return path.join(Global.Path.data, "native-queue", Instance.project.id, `${SessionID.zod.parse(id)}.json`)
  }

  async function read(id: SessionID): Promise<Saved> {
    const text = await fs.readFile(file(id), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined
      throw err
    })
    if (text === undefined) return { owner: state().owner, paused: false, items: [] }
    const saved = Saved.parse(JSON.parse(text))
    if (saved.owner === state().owner) return saved
    return {
      ...saved,
      owner: state().owner,
      paused: true,
      reason: "The execution service restarted. Review the queue before continuing.",
      items: saved.items.map((item) =>
        item.state !== "dispatching"
          ? item
          : {
              ...item,
              state: "uncertain" as const,
              error: "The service stopped before delivery was confirmed. Check the conversation before resending.",
            },
      ),
    }
  }

  async function write(id: SessionID, saved: Saved) {
    const target = file(id)
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await fs.writeFile(temp, JSON.stringify(saved), { flag: "wx", mode: 0o600 })
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  export async function list(id: SessionID) {
    return home(id, async () => {
      using lock = await Lock.write(file(id))
      return Status.parse(await read(id))
    })
  }

  export async function enqueue(value: z.infer<typeof Input>) {
    const input = Input.parse(value)
    return home(input.sessionID, async () => {
      if ((await Config.getGlobal()).native?.codex?.enabled === false) throw new Error("Codex is disabled.")
      const parts = NativeInput.parts(input)
      NativeInput.check(parts)
      using lock = await Lock.write(file(input.sessionID))
      const saved = await read(input.sessionID)
      const existing = saved.items.find((item) => item.id === input.messageID)
      if (existing) {
        if (
          existing.text !== input.text ||
          existing.model !== input.model ||
          existing.effort !== input.effort ||
          NativeInput.key(NativeInput.parts({ ...input, text: existing.text, parts: existing.parts })) !==
            NativeInput.key(parts)
        )
          throw new Error("This queued message ID has already been used for different input.")
        return Status.parse(saved)
      }
      if (NativeStore.inputs(input.sessionID).some((item) => item.id === input.messageID))
        throw new Error("This message has already been submitted. Check the conversation before sending again.")
      if (saved.items.length >= 20)
        throw new Error("The queue is full. Remove a pending message before adding another.")
      // Only an explicitly owned active run can authorize automatic continuation.
      // An idle/recovered queue needs the separate Resume action.
      if (!saved.items.length && NativeSession.active(input.sessionID) && !state().halted.has(input.sessionID)) {
        saved.paused = false
        delete saved.reason
      }
      if (!NativeSession.active(input.sessionID) || state().halted.has(input.sessionID)) {
        saved.paused = true
        saved.reason = "The current task has ended. Review and resume the queue to send this message."
      }
      saved.items.push({
        id: input.messageID,
        text: input.text,
        model: input.model,
        effort: input.effort,
        ...(input.parts ? { parts } : {}),
        ...(parts.some((part) => part.type === "file")
          ? {
              attachments: parts.flatMap((part) =>
                part.type === "file" ? [{ filename: part.filename?.slice(0, 512), mime: part.mime.slice(0, 256) }] : [],
              ),
            }
          : {}),
        state: "pending",
        created: Date.now(),
      })
      if (Buffer.byteLength(JSON.stringify(saved)) > 64 * 1024 * 1024)
        throw new Error("Queued attachments exceed the 64 MiB queue limit. Remove a pending message first.")
      await write(input.sessionID, saved)
      return Status.parse(saved)
    })
  }

  export async function remove(id: SessionID, message: MessageID) {
    return home(id, async () => {
      using lock = await Lock.write(file(id))
      const saved = await read(id)
      if (saved.items.some((item) => item.id === message && item.state === "dispatching"))
        throw new Error("This message is already being sent. Stop the task to interrupt it.")
      saved.items = saved.items.filter((item) => item.id !== message)
      await write(id, saved)
      return Status.parse(saved)
    })
  }

  /** Reserve one queued identity before steering; never fall back to a new turn. */
  export async function send(value: z.infer<typeof Send>): Promise<Sent> {
    const input = Send.parse(value)
    return home(input.sessionID, async () => {
      const current = state()
      const sends = current.sends.get(input.sessionID) ?? new Map<MessageID, { turn: string; result: Promise<Sent> }>()
      const known = sends.get(input.messageID)
      if (known?.turn === input.turnID) return known.result
      if (known)
        return {
          queue: await list(input.sessionID),
          delivery: {
            status: "rejected",
            messageID: input.messageID,
            turnID: input.turnID,
            error: "This queued message is already being sent to another turn.",
          },
        }
      const result = deliver(input).finally(() => {
        sends.delete(input.messageID)
        if (!sends.size && current.sends.get(input.sessionID) === sends) current.sends.delete(input.sessionID)
      })
      sends.set(input.messageID, { turn: input.turnID, result })
      current.sends.set(input.sessionID, sends)
      return result
    })
  }

  async function deliver(input: z.infer<typeof Send>): Promise<Sent> {
    const current = state()
    const rejected = (error: string): Native.Steered => ({
      status: "rejected",
      messageID: input.messageID,
      turnID: input.turnID,
      error,
    })
    const reserved = await (async (): Promise<{ text: string; parts?: Native.Part[] } | Sent> => {
      using lock = await Lock.write(file(input.sessionID))
      const saved = await read(input.sessionID)
      const item = saved.items.find((item) => item.id === input.messageID)
      const stored = NativeStore.inputs(input.sessionID).find((item) => item.id === input.messageID)
      if (!item) {
        // A lost HTTP response can be retried after the accepted entry was
        // removed. Existing immutable input makes steer a receipt read only.
        const part = stored?.data.parts.find((part) => part.type === "text" && part.metadata?.nativeSteer)
        if (part?.type === "text")
          return {
            text: part.text,
            parts: stored!.data.parts.filter(
              (part): part is MessageV2.TextPart | MessageV2.FilePart =>
                part.type === "file" || (part.type === "text" && !part.metadata?.nativeSteer?.anchor),
            ),
          }
        return {
          queue: Status.parse(saved),
          delivery: rejected("This queued message is no longer pending. Check the conversation before sending again."),
        }
      }
      if (item.state === "dispatching" && !item.turn)
        return {
          queue: Status.parse(saved),
          delivery: rejected("This queued message is already being sent as a new turn."),
        }
      if (item.turn && item.turn !== input.turnID && item.state !== "pending")
        return {
          queue: Status.parse(saved),
          delivery: rejected("This message already has a delivery attempt for another turn. Review its saved result."),
        }
      if (stored) return { text: item.text, parts: item.parts }
      if (item.turn === input.turnID && item.delivery) return { queue: Status.parse(saved), delivery: item.delivery }
      if (item.state !== "pending")
        return {
          queue: Status.parse(saved),
          delivery: {
            status: "uncertain" as const,
            messageID: input.messageID,
            turnID: input.turnID,
            error: item.error ?? "Delivery could not be confirmed. This message will not be sent again automatically.",
          },
        }
      const active = NativeSession.active(input.sessionID)
      if (current.closed || current.halted.has(input.sessionID) || !active?.steer || active.turnID !== input.turnID) {
        const delivery = rejected(
          "The expected Codex turn is no longer available for steering. Review and resume the queue to send this as a new task.",
        )
        item.turn = input.turnID
        item.delivery = delivery
        item.error = delivery.error
        saved.paused = true
        saved.reason = delivery.error
        await write(input.sessionID, saved)
        return { queue: Status.parse(saved), delivery }
      }
      item.state = "dispatching"
      item.turn = input.turnID
      delete item.delivery
      delete item.error
      await write(input.sessionID, saved)
      return { text: item.text, parts: item.parts }
    })()
    if ("delivery" in reserved) return reserved
    const request = { ...input, ...reserved }
    // Do not hold the queue mutex across RPC: cancelling a task pauses its
    // queue before aborting the native turn. The persisted reservation excludes
    // both removal and automatic drain while this await is pending.
    const delivery = await NativeSession.steer(request).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!NativeStore.inputs(input.sessionID).some((item) => item.id === input.messageID)) return rejected(message)
      return NativeSession.steer(request).catch(
        (): Native.Steered => ({
          status: "uncertain",
          messageID: input.messageID,
          turnID: input.turnID,
          error: message,
        }),
      )
    })
    const queue = await (async () => {
      using lock = await Lock.write(file(input.sessionID))
      const saved = await read(input.sessionID)
      const item = saved.items.find((item) => item.id === input.messageID)
      if (!item) return Status.parse(saved)
      if (delivery.status === "accepted") saved.items = saved.items.filter((item) => item.id !== input.messageID)
      if (delivery.status !== "accepted") {
        item.state =
          delivery.status === "uncertain"
            ? "uncertain"
            : NativeStore.inputs(input.sessionID).some((item) => item.id === input.messageID)
              ? "failed"
              : "pending"
        item.delivery = delivery
        item.error = delivery.error
        saved.paused = true
        saved.reason = delivery.error ?? "Review the queued message before continuing."
      }
      await write(input.sessionID, saved)
      return Status.parse(saved)
    })()
    if (delivery.status === "accepted") kick(input.sessionID)
    return { queue, delivery }
  }

  export async function pause(id: SessionID, reason = "The task stopped. Review the queue before continuing.") {
    state().halted.add(id)
    using lock = await Lock.write(file(id))
    const saved = await read(id)
    if (!saved.items.length) return
    saved.paused = true
    saved.reason = reason
    await write(id, saved)
  }

  export async function resume(id: SessionID) {
    return home(id, async () => {
      if ((await Config.getGlobal()).native?.codex?.enabled === false) throw new Error("Codex is disabled.")
      {
        using lock = await Lock.write(file(id))
        const saved = await read(id)
        if (saved.items.some((item) => item.state === "uncertain" || item.state === "failed"))
          throw new Error(
            "Review and remove unresolved queue entries before continuing; they will not be retried automatically.",
          )
        saved.paused = false
        delete saved.reason
        await write(id, saved)
        state().halted.delete(id)
      }
      kick(id)
      return list(id)
    })
  }

  // A new manually submitted task starts a new lifetime. A paused, nonempty
  // persisted queue still requires explicit resume; cancelling this run can
  // synchronously halt it again before any asynchronous queue write finishes.
  export function started(id: SessionID) {
    state().halted.delete(id)
  }

  export function kick(id: SessionID) {
    const current = state()
    if (current.closed || current.halted.has(id)) return
    if (current.jobs.has(id)) {
      current.wakes.add(id)
      return
    }
    const task = drain(id)
      .catch((err: unknown) => {
        log.error("queue stopped", { id, error: err })
        return pause(id, err instanceof Error ? err.message : String(err)).catch(() => undefined)
      })
      .finally(() => {
        current.jobs.delete(id)
        if (current.wakes.delete(id)) kick(id)
      })
    current.jobs.set(id, task)
  }

  async function drain(id: SessionID) {
    const current = state()
    while (!current.closed && !current.halted.has(id)) {
      const item = await (async () => {
        using lock = await Lock.write(file(id))
        const saved = await read(id)
        if (saved.paused || !saved.items.length || (await SessionStatus.get(id)).type !== "idle") return
        if (saved.items.some((item) => item.state === "dispatching" && item.turn)) return
        const item = saved.items[0]
        if (item.state !== "pending") return
        item.state = "dispatching"
        delete item.turn
        delete item.delivery
        delete item.error
        await write(id, saved)
        return { ...item }
      })()
      if (!item) return
      const result = await (async () => {
        const { SessionPrompt } = await import("@/session/prompt")
        return SessionPrompt.queued(
          {
            sessionID: id,
            messageID: item.id,
            ...(item.model
              ? { model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make(item.model) } }
              : {}),
            variant: item.effort,
            parts: item.parts ?? [{ type: "text", text: item.text }],
          },
          () => !current.closed && !current.halted.has(id),
        )
      })().then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      using lock = await Lock.write(file(id))
      const saved = await read(id)
      const entry = saved.items.find((value) => value.id === item.id)
      if (!entry) return
      if (result.value?.info.role === "assistant" && result.value.info.finish === "stop" && !result.value.info.error) {
        saved.items = saved.items.filter((value) => value.id !== item.id)
        await write(id, saved)
        continue
      }
      const delivery = NativeStore.dispatches(id).find((value) => value.id === item.id)
      if (
        !delivery &&
        !NativeStore.inputs(id).some((value) => value.id === item.id) &&
        (current.closed || current.halted.has(id))
      ) {
        entry.state = "pending"
        saved.paused = true
        await write(id, saved)
        return
      }
      entry.state = delivery && delivery.state !== "accepted" && delivery.state !== "rejected" ? "uncertain" : "failed"
      entry.error =
        result.error instanceof Error
          ? result.error.message
          : "The queued task did not finish successfully. Review the conversation."
      saved.paused = true
      saved.reason = entry.error
      await write(id, saved)
      return
    }
  }

  export async function completed(id: SessionID, result?: MessageV2.WithParts) {
    if (result?.info.role === "assistant" && result.info.finish === "stop" && !result.info.error) {
      kick(id)
      return
    }
    await pause(id)
  }

  export async function clear(id: SessionID) {
    state().halted.add(id)
    await state().jobs.get(id)
    await Promise.allSettled([...(state().sends.get(id)?.values() ?? [])].map((item) => item.result))
    using lock = await Lock.write(file(id))
    await fs.rm(file(id), { force: true })
  }
}
