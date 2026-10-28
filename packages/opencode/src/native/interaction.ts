import z from "zod"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { PartID, type SessionID } from "@/session/schema"
import { Native } from "./schema"
import { NativeStore } from "./store"
import { Protocol } from "./protocol"
import { NativeDisplay } from "./display"
import { NativeInput } from "./input"

export namespace NativeInteraction {
  const receipt = z.object({ turn: z.string(), thread: z.string(), parent: z.string(), error: z.string().optional() })
  type Run = {
    session: Session.Info
    assistant: MessageV2.Assistant
    signal: AbortSignal
    ended: () => boolean
    steer?: (user: MessageV2.User) => Promise<void>
    mode: Native.Mode
    phase: Native.Active["phase"]
    waiting: number
    supported: boolean
    images?: boolean
    thread?: string
    turn?: string
    client?: Protocol.Client
    error?: string
    queue: Promise<unknown>
    pending: number
  }
  const runs = Instance.state(() => new Map<SessionID, Run>())
  const stopped = (run: Run) => run.signal.aborted || run.ended() || run.phase === "stopping" || run.client?.closed

  export function active(id: SessionID): Native.Active | undefined {
    const run = runs().get(id)
    if (!run) return
    const phase = stopped(run) ? "stopping" : run.waiting ? "waiting" : run.phase
    return {
      phase,
      mode: run.mode,
      threadID: run.thread,
      turnID: run.turn,
      steer: run.supported && !!run.turn && phase !== "starting" && phase !== "stopping",
      ...(run.error ? { error: run.error } : {}),
    }
  }

  export function open(opts: Pick<Run, "session" | "assistant" | "signal" | "ended" | "mode" | "steer">) {
    const entries = runs()
    if (entries.has(opts.session.id)) throw new Error("This Codex session already owns an active interaction")
    const run: Run = { ...opts, phase: "starting", waiting: 0, supported: false, queue: Promise.resolve(), pending: 0 }
    entries.set(opts.session.id, run)
    return {
      ready(client: Protocol.Client, thread: string, turn: string, supported: boolean, images?: boolean) {
        run.client = client
        run.thread = thread
        run.turn = turn
        run.supported = supported
        run.images = images
        run.phase = "running"
      },
      async wait<T>(fn: () => Promise<T>): Promise<T> {
        run.waiting++
        try {
          return await fn()
        } finally {
          run.waiting--
        }
      },
      async close() {
        run.phase = "stopping"
        await run.queue.catch(() => undefined)
        if (entries.get(opts.session.id) === run) entries.delete(opts.session.id)
      },
    }
  }

  export async function steer(value: Native.Steer): Promise<Native.Steered> {
    const input = Native.Steer.parse(value)
    const parts = NativeInput.parts(input)
    NativeInput.check(parts)
    const result = (status: Native.Steered["status"], error?: string): Native.Steered => ({
      status,
      messageID: input.messageID,
      turnID: input.turnID,
      ...(error ? { error } : {}),
    })
    const previous = () => {
      const row = NativeStore.inputs(input.sessionID).find((entry) => entry.id === input.messageID)
      if (!row) return
      const part = row.data.parts.find(
        (part): part is MessageV2.TextPart => part.type === "text" && !!part.metadata?.nativeSteer,
      )
      const tag = receipt.safeParse(part?.metadata?.nativeSteer)
      const original = row.data.parts.filter(
        (part): part is MessageV2.TextPart | MessageV2.FilePart =>
          part.type === "file" || (part.type === "text" && !part.metadata?.nativeSteer?.anchor),
      )
      if (
        part?.type !== "text" ||
        !tag.success ||
        tag.data.turn !== input.turnID ||
        NativeInput.key(original) !== NativeInput.key(parts)
      )
        return result("rejected", "This message ID already belongs to different input.")
      const dispatch = NativeStore.dispatches(input.sessionID).find((entry) => entry.id === input.messageID)
      return result(
        dispatch?.state === "accepted" ? "accepted" : dispatch?.state === "rejected" ? "rejected" : "uncertain",
        dispatch?.state === "accepted"
          ? undefined
          : (tag.data.error ?? "This input was already submitted and will not be sent again."),
      )
    }
    const known = previous()
    if (known) return known
    const run = runs().get(input.sessionID)
    if (!run) return result("rejected", "This service does not own an active Codex turn for this session.")
    if (run.pending >= 16) return result("rejected", "Too many steering requests are pending; the input was not sent.")
    run.pending++
    const work = run.queue.then(async () => {
      const known = previous()
      if (known) return known
      if ((await Config.getGlobal()).native?.codex?.enabled === false)
        return result("rejected", "The native Codex backend is disabled.")
      const session = await Session.get(input.sessionID)
      const valid = () => runs().get(input.sessionID) === run && !stopped(run) && run.turn === input.turnID
      if (
        !valid() ||
        !run.client ||
        !run.thread ||
        session.directory !== run.session.directory ||
        session.engine?.thread !== run.thread
      )
        return result("rejected", "The expected Codex turn is no longer active; the input was not sent.")
      if (!run.supported) return result("rejected", "This Codex version does not support safely tracked steering.")
      if (run.images === false && parts.some((part) => part.type === "file" && part.mime.startsWith("image/")))
        return result("rejected", `Codex model ${run.assistant.modelID} does not support image input.`)
      const payload = {
        threadId: run.thread,
        expectedTurnId: input.turnID,
        clientUserMessageId: input.messageID,
        input: await NativeInput.build(parts, input.sessionID, run.signal),
      }
      Protocol.check("turn/steer", payload)
      if (!valid()) return result("rejected", "The expected Codex turn ended before the input was sent.")
      const user: MessageV2.User = {
        id: input.messageID,
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "codex",
        model: { providerID: run.assistant.providerID, modelID: run.assistant.modelID },
        variant: run.assistant.variant,
      }
      const tag = { thread: run.thread, turn: input.turnID, parent: run.assistant.parentID, status: "sending" }
      const content: MessageV2.Part[] = parts.map((part) =>
        part.type === "text" ? { ...part, metadata: { ...part.metadata, nativeSteer: tag } } : part,
      )
      if (!content.some((part) => part.type === "text"))
        content.unshift({
          id: PartID.ascending(),
          sessionID: input.sessionID,
          messageID: input.messageID,
          type: "text",
          text: "",
          ignored: true,
          synthetic: true,
          metadata: { nativeSteer: { ...tag, anchor: true } },
        })
      NativeStore.steer({ info: user, parts: content }, NativeDisplay.id(user.id), run.thread, input.turnID)
      let dispatched = false
      let status: Native.Steered["status"] = "accepted"
      let error: string | undefined
      try {
        await Session.updateMessage(user)
        for (const part of content) await Session.updatePart(part)
        if (!valid()) throw new Error("The expected Codex turn ended before the input was sent.")
        dispatched = true
        const accepted = z
          .object({ turnId: z.string() })
          .parse(await run.client.request("turn/steer", payload, { timeout: 15_000, signal: run.signal }))
        if (accepted.turnId !== input.turnID) throw new Error("Codex accepted steering for an unexpected turn.")
        await run.client.drain()
        await run.steer?.(user)
      } catch (cause) {
        status = !dispatched || cause instanceof Protocol.RpcError ? "rejected" : "uncertain"
        error = cause instanceof Error ? cause.message : "Unable to determine whether Codex accepted the input."
      }
      run.error = error
      const saved = NativeStore.delivery(input.sessionID, input.messageID, status, error)
      for (const part of saved.parts) await Session.updatePart(part)
      return result(status, error)
    })
    const finished = work.finally(() => {
      run.pending--
    })
    run.queue = finished.catch(() => undefined)
    return finished
  }
}
