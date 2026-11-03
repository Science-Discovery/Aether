import { and, eq, inArray, ne, notInArray } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Instance } from "@/project/instance"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session"
import { NativeDispatchTable, NativeInputTable, NativeStateTable } from "./store.sql"

export namespace NativeStore {
  export async function history(session: SessionID) {
    const result: MessageV2.WithParts[] = []
    for await (const item of MessageV2.stream(session)) result.push(item)
    return result.reverse()
  }

  export function state(session: SessionID) {
    return Database.useProject(Instance.project.id, (db) =>
      db.select().from(NativeStateTable).where(eq(NativeStateTable.session_id, session)).get(),
    )
  }

  export function inputs(session: SessionID, opts: { retired?: boolean } = {}) {
    const rows = Database.useProject(Instance.project.id, (db) =>
      db
        .select()
        .from(NativeInputTable)
        .where(eq(NativeInputTable.session_id, session))
        .orderBy(NativeInputTable.time_created, NativeInputTable.id)
        .all(),
    )
    if (opts.retired) return rows
    const retired = new Set(
      dispatches(session, { retired: true })
        .filter((row) => row.state === "retired")
        .map((row) => row.id),
    )
    return rows.filter((row) => !row.dispatch_id || !retired.has(row.dispatch_id))
  }

  export function pending(session: SessionID) {
    return inputs(session).filter((entry) => entry.state === "pending")
  }

  export function dispatches(session: SessionID, opts: { retired?: boolean } = {}) {
    const rows = Database.useProject(Instance.project.id, (db) =>
      db.select().from(NativeDispatchTable).where(eq(NativeDispatchTable.session_id, session)).all(),
    )
    return opts.retired ? rows : rows.filter((row) => row.state !== "retired")
  }

  /** Keep removed delivery evidence as tombstones so retries cannot resend it. */
  export function reconcile(session: Session.Info, turns: string[]) {
    const ledger = dispatches(session.id)
    const rows = inputs(session.id)
    if (
      ledger.some(
        (row) =>
          row.thread_id !== session.engine?.thread ||
          (row.state !== "accepted" && row.state !== "rejected") ||
          (row.state === "accepted" && !row.turn_id),
      )
    )
      throw new Error("Resolve unconfirmed Codex inputs before replacing its history.")
    const retired = ledger.filter((row) => row.state === "accepted" && !turns.includes(row.turn_id!))
    if (rows.some((row) => retired.some((entry) => entry.id === row.dispatch_id) && row.state !== "consumed"))
      throw new Error("Removed Codex input has an inconsistent delivery state.")
    return {
      retired,
      ledger: ledger.filter((row) => !retired.includes(row)),
      inputs: rows.filter((row) => !retired.some((entry) => entry.id === row.dispatch_id)),
    }
  }

  export function retire(session: Session.Info, turns: string[], db: Database.TxOrDb) {
    const ids = reconcile(session, turns).retired.map((row) => row.id)
    if (!ids.length) return
    db.update(NativeDispatchTable)
      .set({ state: "retired", time_updated: Date.now() })
      .where(and(eq(NativeDispatchTable.session_id, session.id), inArray(NativeDispatchTable.id, ids)))
      .run()
  }

  /** A confirmed revert must not discard inputs whose native delivery is unknown. */
  export function prefix(session: Session.Info, turns: string[]) {
    const ledger = dispatches(session.id)
    const rows = inputs(session.id)
    const rejected = new Set(ledger.filter((row) => row.state === "rejected").map((row) => row.id))
    if (
      ledger.some(
        (row) =>
          (row.state !== "accepted" && row.state !== "rejected") ||
          (row.state === "accepted" && !row.turn_id) ||
          (row.state === "rejected" &&
            !rows.some((input) => input.state === "failed" && input.dispatch_id === row.id)) ||
          row.thread_id !== session.engine?.thread,
      ) ||
      rows.some((row) => {
        if (row.state === "failed")
          return row.dispatch_id ? !rejected.has(row.dispatch_id) : ledger.some((entry) => entry.id === row.id)
        return (
          row.state !== "consumed" ||
          !row.dispatch_id ||
          !ledger.some((entry) => entry.id === row.dispatch_id && entry.state === "accepted")
        )
      })
    )
      throw new Error("Resolve pending or unconfirmed Codex inputs before reverting this conversation.")
    // Confirmed failures have no native history to revert. Preserve their text
    // and rejection receipts without making them eligible for replay.
    const retained = ledger.filter((row) => row.state === "rejected" || turns.includes(row.turn_id!))
    return {
      ledger: retained,
      inputs: rows.filter((row) => row.state === "failed" || retained.some((entry) => entry.id === row.dispatch_id)),
    }
  }

  /** Called inside the same transaction that replaces the display projection. */
  export function prune(session: Session.Info, turns: string[], db: Database.TxOrDb) {
    const kept = prefix(session, turns)
    const retired = dispatches(session.id, { retired: true }).filter((row) => row.state === "retired")
    kept.ledger.push(...retired)
    kept.inputs.push(
      ...inputs(session.id, { retired: true }).filter((row) => retired.some((entry) => entry.id === row.dispatch_id)),
    )
    db.delete(NativeInputTable)
      .where(
        and(
          eq(NativeInputTable.session_id, session.id),
          kept.inputs.length
            ? notInArray(
                NativeInputTable.id,
                kept.inputs.map((row) => row.id),
              )
            : undefined,
        ),
      )
      .run()
    db.delete(NativeDispatchTable)
      .where(
        and(
          eq(NativeDispatchTable.session_id, session.id),
          kept.ledger.length
            ? notInArray(
                NativeDispatchTable.id,
                kept.ledger.map((row) => row.id),
              )
            : undefined,
        ),
      )
      .run()
  }

  // Run before replacing any legacy display cache. Preserve all original inputs,
  // including noReply research context and failed messages that must not replay.
  export async function migrate(session: Session.Info) {
    if (state(session.id)) return
    const messages = await history(session.id)
    const cursor = session.engine?.cursor
    const boundary = cursor ? messages.findIndex((entry) => entry.info.role === "user" && entry.info.id === cursor) : -1
    if (cursor && boundary === -1)
      throw new Error("The native input cursor is missing; legacy input was preserved without replay.")
    if (!cursor && session.engine?.thread && messages.some((entry) => entry.info.role === "assistant"))
      throw new Error("This native thread has no input cursor; legacy input was preserved without replay.")
    const answered = new Set(
      messages.flatMap((entry) => (entry.info.role === "assistant" ? [entry.info.parentID] : [])),
    )
    Database.transactionProject(Instance.project.id, (db) => {
      if (db.select().from(NativeStateTable).where(eq(NativeStateTable.session_id, session.id)).get()) return
      messages.forEach((entry, index) => {
        if (entry.info.role !== "user") return
        const assistant =
          index <= boundary && session.engine?.thread
            ? messages.find((item) => item.info.role === "assistant" && item.info.parentID === entry.info.id)?.info
            : undefined
        db.insert(NativeInputTable)
          .values({
            id: entry.info.id,
            session_id: session.id,
            data: entry,
            context: !answered.has(entry.info.id),
            state: index <= boundary ? "consumed" : answered.has(entry.info.id) ? "failed" : "pending",
            dispatch_id: assistant ? entry.info.id : undefined,
            time_created: entry.info.time.created,
          })
          .run()
        if (assistant?.role === "assistant" && session.engine?.thread)
          db.insert(NativeDispatchTable)
            .values({
              id: entry.info.id,
              session_id: session.id,
              assistant_id: assistant.id,
              assistant,
              thread_id: session.engine.thread,
              state: "uncertain",
              time_created: entry.info.time.created,
              time_updated: Date.now(),
            })
            .run()
      })
      db.insert(NativeStateTable).values({ session_id: session.id, version: 1 }).run()
    })
  }

  export function add(message: MessageV2.WithParts, context: boolean) {
    if (
      dispatches(message.info.sessionID, { retired: true }).some(
        (row) => row.id === message.info.id && row.state === "retired",
      )
    )
      throw new Error("This input belongs to removed Codex history and cannot be sent again with the same ID.")
    Database.useProject(Instance.project.id, (db) =>
      db
        .insert(NativeInputTable)
        .values({
          id: message.info.id,
          session_id: message.info.sessionID,
          data: message,
          context,
          state: "pending",
          time_created: message.info.time.created,
        })
        .run(),
    )
  }

  export function fail(session: SessionID, id: MessageID) {
    Database.useProject(Instance.project.id, (db) =>
      db
        .update(NativeInputTable)
        .set({ state: "failed" })
        .where(
          and(
            eq(NativeInputTable.session_id, session),
            eq(NativeInputTable.id, id),
            eq(NativeInputTable.state, "pending"),
          ),
        )
        .run(),
    )
  }

  export function begin(session: SessionID, id: MessageID, assistant: MessageID, thread: string, ids: MessageID[]) {
    Database.transactionProject(Instance.project.id, (db) => {
      const rows = db
        .select()
        .from(NativeInputTable)
        .where(and(eq(NativeInputTable.session_id, session), inArray(NativeInputTable.id, ids)))
        .all()
      if (!ids.length || rows.length !== ids.length || rows.some((row) => row.state !== "pending"))
        throw new Error("Native input has already been dispatched or changed.")
      db.insert(NativeDispatchTable)
        .values({
          id,
          session_id: session,
          assistant_id: assistant,
          thread_id: thread,
          state: "sending",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
      db.update(NativeInputTable)
        .set({ state: "consumed", dispatch_id: id })
        .where(and(eq(NativeInputTable.session_id, session), inArray(NativeInputTable.id, ids)))
        .run()
    })
  }

  export function accept(session: SessionID, id: MessageID, turn: string) {
    Database.transactionProject(Instance.project.id, (db) => {
      const row = db
        .select()
        .from(NativeDispatchTable)
        .where(and(eq(NativeDispatchTable.session_id, session), eq(NativeDispatchTable.id, id)))
        .get()
      if (!row || row.state === "retired") return
      if (row.turn_id && row.turn_id !== turn) throw new Error("Native dispatch refers to a different turn")
      db.update(NativeDispatchTable)
        .set({ state: "accepted", turn_id: turn, time_updated: Date.now() })
        .where(and(eq(NativeDispatchTable.session_id, session), eq(NativeDispatchTable.id, id)))
        .run()
    })
  }

  /** Steering is consumed atomically: it must never enter the next-turn outbox. */
  export function steer(message: MessageV2.WithParts, assistant: MessageID, thread: string, turn: string) {
    if (
      dispatches(message.info.sessionID, { retired: true }).some(
        (row) => row.id === message.info.id && row.state === "retired",
      )
    )
      throw new Error("This input belongs to removed Codex history and cannot be sent again with the same ID.")
    Database.transactionProject(Instance.project.id, (db) => {
      db.insert(NativeInputTable)
        .values({
          id: message.info.id,
          session_id: message.info.sessionID,
          data: message,
          context: false,
          state: "consumed",
          dispatch_id: message.info.id,
          time_created: message.info.time.created,
        })
        .run()
      db.insert(NativeDispatchTable)
        .values({
          id: message.info.id,
          session_id: message.info.sessionID,
          assistant_id: assistant,
          thread_id: thread,
          turn_id: turn,
          state: "sending",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
    })
  }

  export function delivery(
    session: SessionID,
    id: MessageID,
    status: "accepted" | "rejected" | "uncertain",
    error?: string,
  ) {
    return Database.transactionProject(Instance.project.id, (db) => {
      const row = db
        .select()
        .from(NativeInputTable)
        .where(and(eq(NativeInputTable.session_id, session), eq(NativeInputTable.id, id)))
        .get()
      if (!row) throw new Error("The native steering input is missing")
      if (
        db
          .select()
          .from(NativeDispatchTable)
          .where(and(eq(NativeDispatchTable.session_id, session), eq(NativeDispatchTable.id, id)))
          .get()?.state === "retired"
      )
        return row.data
      const data = {
        ...row.data,
        parts: row.data.parts.map((part) =>
          part.type === "text"
            ? {
                ...part,
                metadata: {
                  ...part.metadata,
                  nativeSteer: {
                    ...(typeof part.metadata?.nativeSteer === "object" && part.metadata.nativeSteer !== null
                      ? part.metadata.nativeSteer
                      : {}),
                    status,
                    ...(error ? { error } : { error: undefined }),
                  },
                },
              }
            : part,
        ),
      }
      db.update(NativeInputTable)
        .set({ data, state: status === "rejected" ? "failed" : "consumed" })
        .where(and(eq(NativeInputTable.session_id, session), eq(NativeInputTable.id, id)))
        .run()
      db.update(NativeDispatchTable)
        .set({ state: status, time_updated: Date.now() })
        .where(and(eq(NativeDispatchTable.session_id, session), eq(NativeDispatchTable.id, id)))
        .run()
      return data
    })
  }

  export function review(session: SessionID, id: MessageID, part: MessageV2.ToolPart) {
    Database.transactionProject(Instance.project.id, (db) => {
      const row = db
        .select()
        .from(NativeDispatchTable)
        .where(and(eq(NativeDispatchTable.session_id, session), eq(NativeDispatchTable.id, id)))
        .get()
      if (!row || row.state === "retired") return
      db.update(NativeDispatchTable)
        .set({ reviews: [...row.reviews.filter((item) => item.id !== part.id), part] })
        .where(and(eq(NativeDispatchTable.session_id, session), eq(NativeDispatchTable.id, id)))
        .run()
    })
  }

  export function receipt(assistant: MessageV2.Assistant) {
    Database.useProject(Instance.project.id, (db) =>
      db
        .update(NativeDispatchTable)
        .set({ assistant })
        .where(
          and(
            eq(NativeDispatchTable.session_id, assistant.sessionID),
            eq(NativeDispatchTable.id, assistant.parentID),
            eq(NativeDispatchTable.assistant_id, assistant.id),
            ne(NativeDispatchTable.state, "retired"),
          ),
        )
        .run(),
    )
  }

  export function uncertain(session: SessionID, id: MessageID) {
    Database.useProject(Instance.project.id, (db) =>
      db
        .update(NativeDispatchTable)
        .set({ state: "uncertain", time_updated: Date.now() })
        .where(
          and(
            eq(NativeDispatchTable.session_id, session),
            eq(NativeDispatchTable.id, id),
            eq(NativeDispatchTable.state, "sending"),
          ),
        )
        .run(),
    )
  }

  export function bind(session: SessionID, home?: string, record = true) {
    if (!home) return
    Database.transactionProject(Instance.project.id, (db) => {
      const row = db.select().from(NativeStateTable).where(eq(NativeStateTable.session_id, session)).get()
      if (!row) throw new Error("Native input storage was not initialized.")
      if (row.home && row.home !== home)
        throw new Error(
          "This session belongs to a different Codex home. Restore the original connection before continuing.",
        )
      if (!row.home && record)
        db.update(NativeStateTable).set({ home }).where(eq(NativeStateTable.session_id, session)).run()
    })
  }

  export function synced(session: SessionID) {
    Database.useProject(Instance.project.id, (db) =>
      db
        .update(NativeStateTable)
        .set({ time_synced: Date.now() })
        .where(eq(NativeStateTable.session_id, session))
        .run(),
    )
  }
}
