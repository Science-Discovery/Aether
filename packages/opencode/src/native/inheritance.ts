import { and, eq, sql } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"
import { SessionTable } from "@/session/session.sql"
import { SessionStatus } from "@/session/status"
import { Database } from "@/storage/db"
import { NativeHistory } from "./history"
import { NativeLock } from "./lock"
import type { Protocol } from "./protocol"
import { NativeStore } from "./store"

/** Recover only telemetry for identical native turns; never synthesize usage from the thread's current model. */
export namespace NativeInheritance {
  export type Source = { session: Session.Info; snapshot: NativeHistory.Snapshot }
  type Projection = ReturnType<typeof NativeHistory.project>
  const attempts = Instance.state(() => new Map<string, number>())
  const empty = (message: MessageV2.Assistant) =>
    !message.nativeUsage &&
    message.tokens.total === undefined &&
    !message.tokens.input &&
    !message.tokens.output &&
    !message.tokens.reasoning &&
    !message.tokens.cache.read &&
    !message.tokens.cache.write

  export function missing(projection: Projection) {
    const turns = new Map<string, MessageV2.Assistant[]>()
    for (const entry of projection.messages) {
      const info = entry.info
      if (info.role !== "assistant") continue
      if (info.modelID === "unknown") return true
      const turn = projection.links.find((link) => link.message === info.parentID)?.turn
      if (turn) turns.set(turn, [...(turns.get(turn) ?? []), info])
    }
    return [...turns.values()].some((messages) => messages.every(empty))
  }

  async function load(
    session: Session.Info,
    thread: string,
    client: Pick<Protocol.Client, "request">,
    provided?: Source,
  ) {
    const rows = provided
      ? [{ id: provided.session.id }]
      : Database.useProject(Instance.project.id, (db) =>
          db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.project_id, session.projectID),
                eq(sql<string>`json_extract(${SessionTable.engine}, '$.type')`, "codex"),
                eq(sql<string>`json_extract(${SessionTable.engine}, '$.thread')`, thread),
              ),
            )
            .limit(2)
            .all(),
        )
    if (rows.length !== 1) return
    const source = provided?.session ?? (await Session.get(rows[0].id))
    if (source.engine?.thread !== thread || source.projectID !== session.projectID) return
    const home = NativeStore.state(session.id)?.home
    const origin = NativeStore.state(source.id)?.home
    if (home && origin && home !== origin) return
    if (!provided && (NativeLock.busy(source.id) || (await SessionStatus.get(source.id)).type !== "idle")) return
    const snapshot = provided?.snapshot ?? (await NativeHistory.read(client, thread, { terminal: true }))
    if (!snapshot.complete || snapshot.thread?.id !== thread) return
    if (!provided && (NativeLock.busy(source.id) || (await SessionStatus.get(source.id)).type !== "idle")) return
    return { session: source, snapshot }
  }

  export async function collect(
    session: Session.Info,
    snapshot: NativeHistory.Snapshot,
    client: Pick<Protocol.Client, "request">,
    opts: { source?: Source; force?: boolean } = {},
  ) {
    const key = `${session.id}\n${snapshot.thread?.id}`
    const previous = attempts().get(key)
    if (!opts.force && previous !== undefined && Date.now() - previous < 60_000) return []
    attempts().set(key, Date.now())
    if (attempts().size > 64) attempts().delete(attempts().keys().next().value!)
    const sources: Source[] = []
    const seen = new Set([snapshot.thread?.id])
    for (let index = 0; index < 8; index++) {
      const current = sources.at(-1) ?? { session, snapshot }
      const thread = current.snapshot.thread?.forkedFromId
      if (typeof thread !== "string" || !thread || seen.has(thread)) break
      seen.add(thread)
      const provided = index === 0 && opts.source?.snapshot.thread?.id === thread ? opts.source : undefined
      // Source metadata is optional: its failure must not invalidate the target's verified history.
      const source = await load(session, thread, client, provided).catch(() => undefined)
      if (!source) break
      sources.push(source)
    }
    return sources
  }

  function merge(snapshot: NativeHistory.Snapshot, projection: Projection, source: Source, origin: Projection) {
    if (
      !snapshot.thread ||
      !source.snapshot.thread ||
      !source.snapshot.complete ||
      source.snapshot.thread?.id !== snapshot.thread.forkedFromId ||
      source.session.engine?.thread !== source.snapshot.thread.id
    )
      return
    const turns = new Set(
      snapshot.turns
        .filter((turn) => {
          const previous = source.snapshot.turns.find((item) => item.id === turn.id)
          return (
            NativeHistory.terminal(turn) &&
            previous &&
            previous.status === turn.status &&
            isDeepStrictEqual(previous.items, turn.items) &&
            !origin.issues.some((issue) => !issue.turn || issue.turn === turn.id)
          )
        })
        .map((turn) => turn.id),
    )
    for (const link of projection.links) {
      if (!turns.has(link.turn)) continue
      const entry = projection.messages.find((message) => message.info.id === link.message)
      if (entry?.info.role !== "user") continue
      const match = origin.links.find((item) => item.turn === link.turn && item.item === link.item)
      const parent = match && origin.messages.find((message) => message.info.id === match.message)
      if (parent?.info.role !== "user") continue
      if (entry.info.model.modelID === "unknown" && parent.info.model.modelID !== "unknown")
        entry.info.model = { ...parent.info.model }
      const direct = projection.messages.find(
        (message) => message.info.role === "assistant" && message.info.parentID === entry.info.id,
      )
      const prior = origin.messages.find(
        (message) => message.info.role === "assistant" && message.info.parentID === parent.info.id,
      )
      if (prior?.info.role !== "assistant") continue
      if (direct?.info.role === "assistant") {
        if (direct.info.modelID === "unknown") direct.info.modelID = prior.info.modelID
        direct.info.variant ??= prior.info.variant
      }
      const replies = projection.messages.filter((message) => {
        const info = message.info
        return (
          info.role === "assistant" &&
          projection.links.some((item) => item.turn === link.turn && item.message === info.parentID)
        )
      })
      if (empty(prior.info) || replies.some((message) => message.info.role === "assistant" && !empty(message.info)))
        continue
      // Native persistence can omit a pre-steer reply. Keep that turn's observed usage once on a visible reply.
      const target = direct ?? replies[0]
      if (target?.info.role !== "assistant") continue
      target.info.tokens = structuredClone(prior.info.tokens)
      if (prior.info.nativeUsage) target.info.nativeUsage = { ...prior.info.nativeUsage }
    }
  }

  /** Partial synchronization preserves execution state and text, but can still fill verified telemetry gaps. */
  export function patch(previous: MessageV2.Info, current: MessageV2.Info): MessageV2.Info {
    if (previous.role === "user" && current.role === "user")
      return previous.model.modelID === "unknown" ? { ...previous, model: current.model } : previous
    if (previous.role !== "assistant" || current.role !== "assistant") return previous
    return {
      ...previous,
      modelID: previous.modelID === "unknown" ? current.modelID : previous.modelID,
      variant: previous.variant ?? current.variant,
      ...(empty(previous) && !empty(current) ? { tokens: current.tokens, nativeUsage: current.nativeUsage } : {}),
    }
  }

  export async function apply(snapshot: NativeHistory.Snapshot, projection: Projection, sources: Source[]) {
    const values: { source: Source; projection: Projection }[] = []
    for (const source of sources.toReversed()) {
      const current = await (async () =>
        NativeHistory.project(source.snapshot, {
          sessionID: source.session.id,
          scope: source.session.id,
          cwd: source.session.directory,
          existing: await NativeStore.history(source.session.id),
          receipts: NativeStore.dispatches(source.session.id).flatMap((entry) =>
            entry.state === "accepted" &&
            entry.thread_id === source.snapshot.thread?.id &&
            source.snapshot.turns.some(
              (turn) => turn.id === entry.turn_id && turn.items.some((item) => item.clientId === entry.id),
            ) &&
            entry.assistant
              ? [entry.assistant]
              : [],
          ),
          terminal: true,
        }))().catch(() => undefined)
      if (!current) return
      const previous = values.at(-1)
      if (previous) merge(source.snapshot, current, previous.source, previous.projection)
      values.push({ source, projection: current })
    }
    const source = values.at(-1)
    if (source) merge(snapshot, projection, source.source, source.projection)
  }
}
