import z from "zod"
import { isDeepStrictEqual } from "node:util"
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
import { Storage } from "@/storage/storage"
import { Codex } from "./codex"
import { NativeHistory } from "./history"
import { NativeLock } from "./lock"
import { NativeStore } from "./store"
import { NativeAnswers } from "./answers"
import { NativeQuestion } from "./questions"
import { NativeInheritance } from "./inheritance"
import { NativeRuntime } from "./runtime"
import type { Protocol } from "./protocol"

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
  const compactions = Instance.state(() => new Map<SessionID, string>())

  /** Materialize a replaceable view; pending input and research metadata live elsewhere. */
  export async function apply(
    session: Session.Info,
    snapshot: NativeHistory.Snapshot,
    opts: { terminal?: boolean; sources?: NativeInheritance.Source[] } = {},
  ) {
    return materialize(session, snapshot, opts)
  }

  /** Import only a prefix already verified after a native thread/revert. */
  export async function revert(session: Session.Info, snapshot: NativeHistory.Snapshot): Promise<Status> {
    if (
      !snapshot.complete ||
      !snapshot.thread ||
      snapshot.thread.id !== session.engine?.thread ||
      snapshot.turns.some((turn) => !NativeHistory.terminal(turn))
    )
      throw new Error("The reverted Codex history could not be read completely.")
    const result = await materialize(session, snapshot, { revert: true })
    cache().set(session.id, { at: Date.now(), value: result })
    return result
  }

  /** Confirm external rewrites on the read-only connection before replacing the view. */
  export async function reconcile(
    session: Session.Info,
    snapshot: NativeHistory.Snapshot,
    client: Pick<Protocol.Client, "request">,
    opts: { sources?: NativeInheritance.Source[] } = {},
  ): Promise<Status> {
    const existing = await NativeStore.history(session.id)
    const ledger = NativeStore.dispatches(session.id)
    const native = existing.flatMap((entry) =>
      entry.parts.flatMap((part) => {
        const metadata = "metadata" in part ? part.metadata : undefined
        if (metadata?.nativeAgent) return []
        const parsed = z
          .object({ turn: z.string(), item: z.string(), type: z.string().optional() })
          .safeParse(metadata?.native)
        return parsed.success ? [parsed.data] : []
      }),
    )
    const turns = [
      ...native.map((part) => part.turn),
      ...ledger.flatMap((row) => (row.state === "accepted" && row.turn_id ? [row.turn_id] : [])),
    ]
    const missing = (value: NativeHistory.Snapshot) =>
      turns.some((turn) => !value.turns.some((entry) => entry.id === turn))
    const compaction = JSON.stringify(
      snapshot.turns.flatMap((turn) =>
        turn.items.filter((item) => item.type === "contextCompaction").map((item) => [turn.id, item]),
      ),
    )
    const compacted =
      compactions().get(session.id) !== compaction &&
      snapshot.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === "contextCompaction" && !native.some((part) => part.turn === turn.id && part.item === item.id),
        ),
      )
    if (!missing(snapshot) && !compacted) return apply(session, snapshot, opts)
    const partial = (error: string): Status => ({ state: "partial", messages: existing.length, error })
    if (!snapshot.thread || snapshot.thread.id !== session.engine?.thread)
      return partial("Native history changed but could not be read completely; previous records were preserved.")
    const candidate =
      !snapshot.complete &&
      snapshot.issues.length &&
      snapshot.issues.every((issue) => issue.code === "unsettled" && issue.turn)
        ? await NativeHistory.read(client, snapshot.thread.id, { terminal: true })
        : snapshot
    if (!candidate.complete || (candidate.turns.length && candidate.turns.at(-1)?.status !== "completed"))
      return partial("Native history has no stable completed boundary; previous records were preserved.")
    const confirmed = await NativeHistory.read(client, snapshot.thread.id, { terminal: true })
    const signature = (value: NativeHistory.Snapshot) => ({
      id: value.thread?.id,
      created: value.thread?.createdAt,
      updated: value.thread?.updatedAt,
      status: value.thread?.status.type,
      turns: value.turns,
    })
    if (!confirmed.complete || !isDeepStrictEqual(signature(candidate), signature(confirmed)))
      return partial("Native history changed while it was being confirmed; previous records were preserved.")
    // Ordinary reads omit interrupted turns. Their presence in the verified
    // history must not repeatedly reset answers or evict an unchanged runtime.
    const removed = missing(confirmed)
    if (!removed && !compacted) return apply(session, snapshot, opts)
    if (NativeAnswers.active(session.id))
      return partial("Wait for the submitted answer before refreshing changed history.")
    const kept = NativeStore.reconcile(
      session,
      confirmed.turns.map((turn) => turn.id),
    )
    const projection = NativeHistory.project(confirmed, {
      sessionID: session.id,
      scope: session.id,
      cwd: session.directory,
      existing,
      receipts: kept.ledger.flatMap((entry) => (entry.assistant ? [entry.assistant] : [])),
      terminal: true,
    })
    if (!projection.complete)
      return partial("Changed native history contains unsupported records; previous records were preserved.")
    using gate = NativeAnswers.block(session.id)
    // A resident process can still contain the history removed by Desktop.
    // The next send must restore the confirmed disk state in a fresh process.
    await NativeRuntime.remove(session.id)
    if (removed) await NativeAnswers.reset(session.id)
    const result = await materialize(session, confirmed, { ...opts, replace: true, reset: removed })
    compactions().set(session.id, compaction)
    return result
  }

  async function materialize(
    session: Session.Info,
    snapshot: NativeHistory.Snapshot,
    opts: {
      terminal?: boolean
      revert?: boolean
      replace?: boolean
      reset?: boolean
      sources?: NativeInheritance.Source[]
    },
  ) {
    if (snapshot.thread && session.engine?.thread && snapshot.thread.id !== session.engine.thread)
      throw new Error("Native history belongs to another thread")
    const existing = await NativeStore.history(session.id)
    const retained = opts.revert
      ? NativeStore.prefix(
          session,
          snapshot.turns.map((turn) => turn.id),
        )
      : opts.replace
        ? NativeStore.reconcile(
            session,
            snapshot.turns.map((turn) => turn.id),
          )
        : undefined
    const inputs = retained?.inputs ?? NativeStore.inputs(session.id)
    const ledger = retained?.ledger ?? NativeStore.dispatches(session.id)
    if (opts.terminal && (existing.length || inputs.length || ledger.length))
      throw new Error("A historical fork snapshot can only be imported into an empty conversation.")
    const projection = NativeHistory.project(snapshot, {
      sessionID: session.id,
      scope: session.id,
      cwd: session.directory,
      existing: [
        ...existing,
        ...inputs.filter((entry) => !existing.some((item) => item.info.id === entry.id)).map((entry) => entry.data),
      ],
      receipts: ledger.flatMap((entry) => (entry.assistant ? [entry.assistant] : [])),
      terminal:
        opts.terminal || opts.revert || (opts.replace && snapshot.turns.some((turn) => turn.status !== "completed")),
    })
    if (opts.sources?.length) await NativeInheritance.apply(snapshot, projection, opts.sources)
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
    const observed = new Map(existing.flatMap((entry) => entry.parts.map((part) => [identity(part), part] as const)))
    const represented = new Map(
      messages.flatMap((entry) =>
        entry.parts.map((part) => [identity(part), { message: entry.info.id, part }] as const),
      ),
    )
    // A complete API page is not proof that Codex saved everything we displayed.
    // In particular, steering can omit earlier output from the persisted turn.
    for (const entry of existing) {
      if (entry.info.role !== "assistant" || entry.info.providerID !== "codex-native") continue
      for (const part of entry.parts) {
        const metadata = "metadata" in part ? part.metadata : undefined
        const native = z.object({ turn: z.string(), item: z.string() }).safeParse(metadata?.native)
        if (!native.success || metadata?.nativeAgent) continue
        if (!snapshot.turns.some((turn) => turn.id === native.data.turn)) continue
        if (
          (part.type === "text" || part.type === "reasoning") &&
          !part.text &&
          !(part.type === "text" && part.nativeQuestion)
        )
          continue
        const next = represented.get(identity(part))?.part
        if (
          next &&
          (!(part.type === "text" || part.type === "reasoning") ||
            ((next.type === "text" || next.type === "reasoning") && next.text.startsWith(part.text)))
        )
          continue
        projection.complete = false
        projection.issues.push({
          code: "observed",
          turn: native.data.turn,
          item: native.data.item,
          message: "Native history omits or changes previously observed output; the displayed content was preserved.",
        })
      }
    }
    if ((opts.revert || opts.replace) && projection.issues.some((issue) => issue.code !== "observed"))
      throw new Error("The reverted Codex history contains unsupported or unconfirmed records.")
    const merge = (part: MessageV2.Part, previous: MessageV2.Part | undefined): MessageV2.Part => {
      if (!previous) return part
      if (part.type === "text" && previous.type === "text" && part.metadata?.nativeSteer)
        return { ...previous, metadata: { ...previous.metadata, nativeSteer: part.metadata.nativeSteer } }
      if (
        (part.type === "text" || part.type === "reasoning") &&
        (previous.type === "text" || previous.type === "reasoning") &&
        part.text !== previous.text &&
        part.text.startsWith(previous.text)
      )
        return { ...part, id: previous.id }
      return previous
    }
    const selected = projection.complete
      ? messages
      : messages.map((entry) => {
          const previous = known.get(entry.info.id)
          if (!previous)
            return {
              ...entry,
              parts: entry.parts.map((part) => ({
                ...merge(part, observed.get(identity(part))),
                id: part.id,
                messageID: entry.info.id,
              })),
            }
          // A formerly aggregated reply may now span several display messages.
          // Move each known native item to its projected owner exactly once.
          const retained = previous.parts.filter((part) => {
            const metadata = "metadata" in part ? part.metadata : undefined
            const native = z.object({ turn: z.string() }).safeParse(metadata?.native)
            if (
              (opts.revert || opts.replace) &&
              native.success &&
              !snapshot.turns.some((turn) => turn.id === native.data.turn)
            )
              return false
            const owner = represented.get(identity(part))?.message
            return !owner || owner === entry.info.id
          })
          const ids = new Set(retained.map(identity))
          // A partial read cannot reorder old streaming parts safely. New evidence
          // is appended; a complete snapshot restores the authoritative item order.
          const additions = entry.parts
            .filter((part) => !ids.has(identity(part)))
            .map((part, index) => ({
              ...merge(part, observed.get(identity(part))),
              id: PartID.make(`prt_zz${String(retained.length + index).padStart(8, "0")}_${part.id}`),
              messageID: entry.info.id,
            }))
          const parts = retained.map((part) => {
            const next = entry.parts.find((item) => identity(item) === identity(part))
            return next ? merge(next, part) : part
          })
          return {
            info: opts.sources?.length ? NativeInheritance.patch(previous.info, entry.info) : previous.info,
            parts: [...parts, ...additions],
          }
        })
    const unique = new Map<MessageID, MessageV2.WithParts>()
    const answers = NativeQuestion.texts(
      snapshot.turns
        .filter(
          (turn) =>
            turn.status === "completed" ||
            ((opts.terminal || opts.revert || opts.replace) && NativeHistory.terminal(turn)),
        )
        .flatMap((turn) => turn.items),
    )
    const view: MessageV2.WithParts[] = []
    for (const entry of selected) {
      if (entry.info.role !== "assistant" || entry.info.providerID !== "codex-native") {
        view.push(entry)
        continue
      }
      const parts: MessageV2.Part[] = []
      for (const part of entry.parts) {
        if (part.type !== "text") {
          parts.push(part)
          continue
        }
        const next = represented.get(identity(part))?.part
        const previous = observed.get(identity(part))
        const question =
          (next?.type === "text" ? next.nativeQuestion : undefined) ??
          part.nativeQuestion ??
          (previous?.type === "text" ? previous.nativeQuestion : undefined)
        const resolved = question
          ? NativeQuestion.answered(
              opts.revert || opts.reset
                ? { ...question, state: "pending", answers: undefined, skipped: undefined, error: undefined }
                : question,
              answers,
            )
          : undefined
        parts.push(
          resolved
            ? {
                ...part,
                nativeQuestion:
                  opts.revert || opts.reset ? resolved : await NativeAnswers.decorate(session.id, resolved),
              }
            : part,
        )
      }
      view.push({ ...entry, parts })
    }
    let time = 0
    view.forEach((entry) => {
      const item = MessageV2.WithParts.parse(entry)
      if (unique.has(item.info.id))
        throw new Error("Native history maps multiple messages to the same display identity")
      time = Math.max(time + 1, item.info.time.created)
      item.info.time.created = time
      if (item.info.role === "assistant" && item.info.time.completed !== undefined)
        item.info.time.completed = Math.max(time, item.info.time.completed)
      unique.set(item.info.id, item)
    })
    const removed =
      projection.complete || opts.revert || opts.replace ? existing.filter((entry) => !unique.has(entry.info.id)) : []
    const changed = [...unique.values()].filter(
      (entry) => JSON.stringify(entry) !== JSON.stringify(known.get(entry.info.id)),
    )
    Database.transactionProject(Instance.project.id, (db) => {
      const current = db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()
      if (!current) throw new Error("The session was removed while native history was being read")
      if (opts.revert || opts.replace) {
        if (!current.engine || current.engine.thread !== snapshot.thread?.id)
          throw new Error("The native session changed while its history was being reverted")
        const turns = snapshot.turns.map((turn) => turn.id)
        if (opts.revert) NativeStore.prune(session, turns, db)
        if (opts.replace) NativeStore.retire(session, turns, db)
        db.update(SessionTable)
          .set({
            engine: {
              ...current.engine,
              cursor: projection.messages.findLast((entry) => entry.info.role === "user")?.info.id,
            },
            summary_additions: null,
            summary_deletions: null,
            summary_files: null,
            summary_diffs: null,
            revert: null,
            time_updated: Date.now(),
          })
          .where(eq(SessionTable.id, session.id))
          .run()
      }
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
      })
      // Remove every old owner before inserting parts under another message;
      // part identities are unique across the session, not per display segment.
      changed.forEach((entry) =>
        db
          .delete(PartTable)
          .where(and(eq(PartTable.session_id, session.id), eq(PartTable.message_id, entry.info.id)))
          .run(),
      )
      changed.forEach((entry) => {
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
      if (projection.complete || opts.revert || opts.replace) NativeStore.synced(session.id)
    })
    if (opts.revert || opts.replace) {
      await Storage.write(["session_diff", session.id], [])
      await Bus.publish(Session.Event.Updated, { sessionID: session.id, info: await Session.get(session.id) })
      await Bus.publish(Session.Event.Diff, { sessionID: session.id, diff: [] })
    }
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
      state:
        projection.complete || opts.revert || opts.replace ? "synced" : snapshot.thread ? "partial" : "unavailable",
      messages: projection.messages.length,
      updated: NativeStore.state(session.id)?.time_synced ?? undefined,
      ...(!projection.complete && !opts.revert && !opts.replace
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
        const { NativeRevert } = await import("./revert")
        await NativeRevert.guard(id)
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
          const projection = NativeHistory.project(snapshot, {
            sessionID: session.id,
            scope: session.id,
            cwd: session.directory,
            existing: await NativeStore.history(session.id),
          })
          const sources = NativeInheritance.missing(projection)
            ? await NativeInheritance.collect(session, snapshot, connection.client, { force })
            : []
          return await reconcile(session, snapshot, connection.client, { sources })
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
