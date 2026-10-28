import z from "zod"
import { and, eq } from "drizzle-orm"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { SessionStatus } from "@/session/status"
import { Database } from "@/storage/db"
import { Codex } from "./codex"
import { NativeHistory } from "./history"
import { NativeLock } from "./lock"
import { NativeStore } from "./store"

export namespace NativeSync {
  export const Status = z
    .object({
      state: z.enum(["synced", "partial", "unavailable", "busy", "disabled", "pending"]),
      messages: z.number().int().nonnegative(),
      updated: z.number().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeHistoryStatus" })
  export type Status = z.infer<typeof Status>
  const cache = Instance.state(() => new Map<SessionID, { at: number; value: Status }>())

  /** Materialize a replaceable view; pending input and research metadata live elsewhere. */
  export async function apply(session: Session.Info, snapshot: NativeHistory.Snapshot) {
    if (snapshot.thread && session.engine?.thread && snapshot.thread.id !== session.engine.thread)
      throw new Error("Native history belongs to another thread")
    const existing = await NativeStore.history(session.id)
    const inputs = NativeStore.inputs(session.id)
    const ledger = NativeStore.dispatches(session.id)
    const projection = NativeHistory.project(snapshot, {
      sessionID: session.id,
      scope: session.id,
      cwd: session.directory,
      existing: [
        ...existing,
        ...inputs.filter((entry) => !existing.some((item) => item.info.id === entry.id)).map((entry) => entry.data),
      ],
      receipts: ledger.flatMap((entry) => (entry.assistant ? [entry.assistant] : [])),
    })
    const steered = inputs.filter((entry) =>
      entry.data.parts.some((part) => part.type === "text" && part.metadata?.nativeSteer),
    )
    for (const row of steered) {
      const entry = ledger.find((entry) => entry.id === row.id)
      const links = projection.links.filter((link) => link.client === row.id)
      if (
        !entry ||
        entry.state === "rejected" ||
        links.length !== 1 ||
        entry.thread_id !== snapshot.thread?.id ||
        entry.turn_id !== links[0].turn
      )
        continue
      if (entry.state !== "accepted") row.data = NativeStore.delivery(session.id, row.id, "accepted")
      entry.state = "accepted"
    }
    const missing = ledger.filter(
      (entry) =>
        entry.state !== "rejected" && entry.turn_id && !snapshot.turns.some((turn) => turn.id === entry.turn_id),
    )
    if (missing.length) {
      projection.complete = false
      projection.issues.push({
        code: "unconfirmed",
        message: "Previously dispatched turns are absent from this snapshot; existing records were preserved.",
      })
    }
    if (
      ledger.some(
        (entry) =>
          entry.state !== "rejected" &&
          (entry.state !== "accepted" || steered.some((row) => row.id === entry.id)) &&
          projection.links.filter((link) => link.client === entry.id).length !== 1,
      )
    ) {
      projection.complete = false
      projection.issues.push({
        code: "uncertain",
        message: "Some dispatched inputs have no confirmed native turn; they will not be resent automatically.",
      })
    }
    const original = new Map(inputs.map((entry) => [entry.id, entry]))
    const used = new Set<MessageID>()
    const messages = projection.messages.flatMap((item) => {
      if (item.info.role === "assistant") {
        const receipt = ledger.find((entry) => entry.assistant_id === item.info.id && entry.assistant)
        return [
          {
            ...item,
            parts: [...item.parts, ...(receipt?.reviews ?? []).map((part) => ({ ...part, messageID: item.info.id }))],
          },
        ]
      }
      const row = original.get(item.info.id)
      if (item.info.role !== "user" || !row) return [item]
      used.add(row.id)
      const context = inputs.filter((entry) => entry.context && entry.dispatch_id === row.id && entry.id !== row.id)
      context.forEach((entry) => used.add(entry.id))
      // Preserve original citations and image data instead of displaying the
      // textual wrappers that were sent to the agent as research context.
      return [
        ...context.map((entry) => entry.data),
        {
          info: item.info,
          parts: [...row.data.parts, ...item.parts.filter((part) => part.type === "text" && part.ignored)],
        },
      ]
    })
    const uncertain = new Set(
      ledger.filter((entry) => entry.state !== "accepted" && entry.state !== "rejected").map((entry) => entry.id),
    )
    const local = inputs.filter(
      (entry) =>
        !used.has(entry.id) &&
        (entry.state !== "consumed" ||
          steered.includes(entry) ||
          (entry.dispatch_id && uncertain.has(entry.dispatch_id))),
    )
    messages.push(
      ...local.flatMap((entry) => [
        entry.data,
        ...existing.filter((item) => item.info.role === "assistant" && item.info.parentID === entry.id),
      ]),
    )

    // Legacy noReply entries lack a dispatch ID. Retain them as research metadata
    // until their original association can be proved, rather than deleting them.
    messages.push(
      ...inputs
        .filter((entry) => entry.context && !entry.dispatch_id && !used.has(entry.id) && !local.includes(entry))
        .map((entry) => entry.data),
    )
    const known = new Map(existing.map((entry) => [entry.info.id, entry]))
    const identity = (part: MessageV2.Part) => {
      const metadata = "metadata" in part ? part.metadata : undefined
      const native = z.object({ turn: z.string(), item: z.string() }).safeParse(metadata?.native)
      return native.success
        ? JSON.stringify([native.data.turn, native.data.item, part.type, metadata?.content])
        : part.id.replace(/^prt_zz\d{8}_/, "")
    }
    const selected = projection.complete
      ? messages
      : messages.map((entry) => {
          const previous = known.get(entry.info.id)
          if (!previous) return entry
          const ids = new Set(previous.parts.map(identity))
          // A partial read cannot reorder old streaming parts safely. New evidence
          // is appended; a complete snapshot restores the authoritative item order.
          const additions = entry.parts
            .filter((part) => !ids.has(identity(part)))
            .map((part, index) => ({
              ...part,
              id: PartID.make(`prt_zz${String(previous.parts.length + index).padStart(8, "0")}_${part.id}`),
            }))
          const parts = previous.parts.map((part) => {
            if (part.type !== "text" || !part.metadata?.nativeSteer) return part
            const next = entry.parts.find((item) => identity(item) === identity(part))
            if (next?.type !== "text" || !next.metadata?.nativeSteer) return part
            return { ...part, metadata: { ...part.metadata, nativeSteer: next.metadata.nativeSteer } }
          })
          return { info: previous.info, parts: [...parts, ...additions] }
        })
    const unique = new Map<MessageID, MessageV2.WithParts>()
    let time = 0
    selected.forEach((entry) => {
      const item = MessageV2.WithParts.parse(entry)
      if (unique.has(item.info.id))
        throw new Error("Native history maps multiple messages to the same display identity")
      time = Math.max(time + 1, item.info.time.created)
      item.info.time.created = time
      if (item.info.role === "assistant" && item.info.time.completed !== undefined)
        item.info.time.completed = Math.max(time, item.info.time.completed)
      unique.set(item.info.id, item)
    })
    const removed = projection.complete ? existing.filter((entry) => !unique.has(entry.info.id)) : []
    const changed = [...unique.values()].filter(
      (entry) => JSON.stringify(entry) !== JSON.stringify(known.get(entry.info.id)),
    )
    Database.transactionProject(Instance.project.id, (db) => {
      if (!db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, session.id)).get())
        throw new Error("The session was removed while native history was being read")
      removed.forEach((entry) =>
        db
          .delete(MessageTable)
          .where(and(eq(MessageTable.session_id, session.id), eq(MessageTable.id, entry.info.id)))
          .run(),
      )
      changed.forEach((entry) => {
        const { id, sessionID, ...data } = entry.info
        db.insert(MessageTable)
          .values({ id, session_id: sessionID, time_created: entry.info.time.created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data, time_created: entry.info.time.created } })
          .run()
        db.delete(PartTable)
          .where(and(eq(PartTable.session_id, session.id), eq(PartTable.message_id, id)))
          .run()
        entry.parts.forEach((part) => {
          const { id, messageID, sessionID, ...data } = part
          db.insert(PartTable)
            .values({ id, message_id: messageID, session_id: sessionID, data, time_created: entry.info.time.created })
            .run()
        })
      })
      projection.links
        .filter((link) => link.client && projection.links.filter((item) => item.client === link.client).length === 1)
        .forEach((link) => {
          const entry = ledger.find((row) => row.id === link.client && row.thread_id === snapshot.thread?.id)
          if (entry && entry.state !== "rejected" && (!entry.turn_id || entry.turn_id === link.turn))
            NativeStore.accept(session.id, entry.id, link.turn)
        })
      if (projection.complete) NativeStore.synced(session.id)
    })
    await Promise.all(
      removed.map((entry) => Bus.publish(MessageV2.Event.Removed, { sessionID: session.id, messageID: entry.info.id })),
    )
    for (const entry of changed) {
      const ids = new Set(entry.parts.map((part) => part.id))
      for (const part of known.get(entry.info.id)?.parts ?? []) {
        if (!ids.has(part.id))
          await Bus.publish(MessageV2.Event.PartRemoved, {
            sessionID: session.id,
            messageID: entry.info.id,
            partID: part.id,
          })
      }
      await Bus.publish(MessageV2.Event.Updated, { sessionID: session.id, info: entry.info })
      for (const part of entry.parts)
        await Bus.publish(MessageV2.Event.PartUpdated, { sessionID: session.id, part, time: Date.now() })
    }
    return {
      state: projection.complete ? "synced" : snapshot.thread ? "partial" : "unavailable",
      messages: projection.messages.length,
      updated: NativeStore.state(session.id)?.time_synced ?? undefined,
      ...(!projection.complete
        ? {
            error:
              projection.issues
                .map((issue) => issue.message)
                .join("; ")
                .slice(0, 2000) || "Native history is incomplete; previous records were preserved.",
          }
        : {}),
    } satisfies Status
  }

  export async function refresh(id: SessionID, force = false): Promise<Status> {
    const session = await Session.get(id)
    if (session.directory !== Instance.directory)
      return Instance.provide({ directory: session.directory, fn: () => refresh(id, force) })
    if (!session.engine?.thread) return { state: "pending", messages: 0 }
    if (NativeLock.busy(id) || (await SessionStatus.get(id)).type !== "idle") return { state: "busy", messages: 0 }
    const cfg = await Config.getGlobal()
    if (cfg.native?.codex?.enabled === false) return { state: "disabled", messages: 0 }
    const previous = cache().get(id)
    if (!force && previous && Date.now() - previous.at < 10_000) return previous.value
    if (NativeLock.busy(id)) return { state: "busy", messages: 0 }
    return NativeLock.run(id, async () => {
      const value = await (async () => {
        await NativeStore.migrate(session)
        const connection = await Codex.connect({
          executable: cfg.native?.codex?.path,
          cwd: session.directory,
          signal: AbortSignal.timeout(40_000),
        })
        try {
          NativeStore.bind(id, connection.home, false)
          const snapshot = await NativeHistory.read(connection.client, session.engine!.thread!)
          if (snapshot.thread) NativeStore.bind(id, connection.home)
          return await apply(session, snapshot)
        } finally {
          await connection.client.close()
        }
      })().catch(
        (error: unknown): Status => ({
          state: "unavailable",
          messages: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      cache().set(id, { at: Date.now(), value })
      return value
    })
  }
}
