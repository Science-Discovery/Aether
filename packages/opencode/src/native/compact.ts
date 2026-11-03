import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Filesystem } from "@/util/filesystem"
import { Codex } from "./codex"
import { NativeAnswers } from "./answers"
import { NativeHistory } from "./history"
import { NativeInteraction } from "./interaction"
import { NativeLock } from "./lock"
import { NativeQueue } from "./queue"
import { NativeOwnership } from "./ownership"
import { NativeStore } from "./store"
import { NativeSync } from "./sync"
import { Protocol } from "./protocol"

/** Compact only on explicit request; transport retries never repeat native work. */
export namespace NativeCompact {
  export const Input = z.object({ sessionID: SessionID.zod, id: z.string().uuid() }).strict()
  export const Status = Input.extend({
    threadID: z.string(),
    state: z.enum(["pending", "complete", "failed", "uncertain"]),
    updated: z.number(),
    error: z.string().optional(),
  })
    .strip()
    .meta({ ref: "NativeCompactStatus" })
  type Status = z.infer<typeof Status>
  const Saved = Status.extend({
    home: z.string().optional(),
    history: NativeHistory.Turn.array(),
    closed: z.boolean().optional(),
  })
  type Saved = z.infer<typeof Saved>
  const state = Instance.state(
    () => ({ active: new Map<SessionID, AbortController>(), closed: new Set<SessionID>() }),
    async (value) => {
      value.active.forEach((abort) => abort.abort())
      await Promise.all([...value.active.keys()].map((id) => NativeLock.run(id, async () => undefined)))
    },
  )
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const signature = (turns: NativeHistory.Turn[]) =>
    turns.map((turn) => ({ id: turn.id, status: turn.status, items: turn.items }))
  const markers = (turns: NativeHistory.Turn[]) =>
    turns.flatMap((turn) =>
      turn.status === "completed"
        ? turn.items
            .filter(
              (item) => item.type === "contextCompaction" && (item.status === undefined || item.status === "completed"),
            )
            .map((item) => `${turn.id}\n${item.id}`)
        : [],
    )

  function file(id: SessionID, operation?: string) {
    const root = path.join(Global.Path.data, "native-compactions", Instance.project.id)
    const session = SessionID.zod.parse(id)
    return operation
      ? path.join(root, session, `${z.string().uuid().parse(operation)}.json`)
      : path.join(root, `${session}.json`)
  }

  async function read(id: SessionID) {
    const text = await fs.readFile(file(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    return text === undefined ? undefined : Saved.parse(JSON.parse(text))
  }

  async function receipt(input: z.infer<typeof Input>) {
    const text = await fs.readFile(file(input.sessionID, input.id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (!text) return
    const result = Status.parse(JSON.parse(text))
    return {
      ...result,
      state: result.state === "pending" && !state().active.has(input.sessionID) ? ("uncertain" as const) : result.state,
    }
  }

  async function remember(target: string, value: unknown) {
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await fs.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  async function write(saved: Saved) {
    if (state().closed.has(saved.sessionID)) throw new Error("This conversation is being removed.")
    // Retain small operation tombstones after replacing the current journal.
    // A delayed retry of an older UUID must never become a new compaction.
    await remember(file(saved.sessionID, saved.id), Status.parse(saved))
    if (state().closed.has(saved.sessionID)) throw new Error("This conversation is being removed.")
    await remember(file(saved.sessionID), saved)
  }

  async function home<T>(id: SessionID, run: (session: Session.Info) => Promise<T>): Promise<T> {
    const session = await Session.getGlobal(id)
    if (Filesystem.resolve(session.directory) !== Instance.directory)
      return Instance.provide({ directory: session.directory, fn: () => home(id, run) })
    if (session.engine?.type !== "codex") throw new Error("This conversation does not use Codex.")
    return run(session)
  }

  export async function guard(id: SessionID) {
    if (state().closed.has(id)) throw new Error("This conversation is being removed.")
    const saved = await read(id)
    if (state().active.has(id) || saved?.state === "pending" || saved?.state === "uncertain")
      throw new Error("Codex context compaction is awaiting completion. Open /compact to check its result.")
  }

  async function available(session: Session.Info) {
    const current = await Session.get(session.id)
    if (current.engine?.thread !== session.engine?.thread || !session.engine?.thread)
      throw new Error("This conversation has no matching Codex history to compact.")
    if (
      state().closed.has(session.id) ||
      NativeInteraction.active(session.id) ||
      (await SessionStatus.get(session.id)).type !== "idle"
    )
      throw new Error("Wait for this Codex task to finish before compacting context.")
    if (
      NativeAnswers.active(session.id) ||
      NativeQueue.active(session.id) ||
      (await NativeQueue.list(session.id)).items.length
    )
      throw new Error("Finish submitting answers and clear queued messages before compacting context.")
    if ((await NativeAnswers.pending(session.id)).length)
      throw new Error("Answer or skip the remaining questions before compacting context.")
    if ((await Config.getGlobal()).native?.codex?.enabled === false)
      throw new Error("Enable Codex before compacting context.")
  }

  /** Acknowledgement is insufficient: track only a new, completed compaction turn. */
  export function track(thread: string, before: string[]) {
    const done = Promise.withResolvers<void>()
    const turns = new Set<string>()
    let armed = false
    let finished = false
    const reject = (error: Error) => {
      if (!finished) {
        finished = true
        done.reject(error)
      }
    }
    const notify = (method: string, value: unknown) => {
      if (!armed || finished) return
      const data = z.object({ threadId: z.string() }).passthrough().safeParse(value)
      if (!data.success || data.data.threadId !== thread) return
      const turn = z
        .object({ id: z.string(), status: z.string().optional(), items: NativeHistory.Item.array().optional() })
        .passthrough()
        .safeParse(data.data.turn)
      const id = turn.success ? turn.data.id : typeof data.data.turnId === "string" ? data.data.turnId : undefined
      if (!id || before.includes(id)) return
      const item = NativeHistory.Item.safeParse(data.data.item)
      if (
        (item.success && item.data.type === "contextCompaction") ||
        (turn.success && turn.data.items?.some((item) => item.type === "contextCompaction"))
      )
        turns.add(id)
      if (method !== "turn/completed") return
      if (!turn.success || turn.data.status !== "completed")
        return reject(new Error("Codex did not complete context compaction."))
      if (!turns.has(id))
        return reject(new Error("Codex completed another operation while context compaction was pending."))
      finished = true
      done.resolve()
    }
    // A request can fail before the caller starts waiting for its completion event.
    void done.promise.catch(() => undefined)
    return {
      promise: done.promise,
      notify,
      arm: () => {
        armed = true
      },
      reject,
    }
  }

  async function reconcile(session: Session.Info, saved: Saved, client: Protocol.Client) {
    const snapshot = await NativeHistory.read(client, saved.threadID, { terminal: true })
    const previous = markers(saved.history)
    if (!snapshot.complete || !snapshot.thread || !markers(snapshot.turns).some((id) => !previous.includes(id))) {
      // Only a connection we positively closed may be released as unchanged.
      // After a server crash the process outcome remains unknown, so retain the guard.
      if (
        saved.closed &&
        snapshot.complete &&
        snapshot.thread &&
        isDeepStrictEqual(signature(saved.history), signature(snapshot.turns))
      ) {
        const confirmed = await NativeHistory.read(client, saved.threadID, { terminal: true })
        if (confirmed.complete && isDeepStrictEqual(snapshot, confirmed)) {
          saved.state = "failed"
          saved.error =
            "No completed compaction was saved before the connection closed. The verified original history is retained."
          saved.updated = Date.now()
          await write(saved)
          return Status.parse(saved)
        }
      }
      saved.state = "uncertain"
      saved.error = "No completed compaction could be verified yet. No repeat request was sent."
      await write(saved)
      return Status.parse(saved)
    }
    if (snapshot.turns.some((turn) => !NativeHistory.terminal(turn)))
      throw new Error("Codex context is still changing.")
    const result = await NativeSync.reconcile(session, snapshot, client)
    if (result.state !== "synced") throw new Error(result.error ?? "The compacted history could not be displayed.")
    saved.state = "complete"
    saved.updated = Date.now()
    saved.error = undefined
    saved.history = []
    await write(saved)
    return Status.parse(saved)
  }

  export async function start(value: z.infer<typeof Input>): Promise<Status> {
    const input = Input.parse(value)
    return home(input.sessionID, async (session) => {
      const known = await receipt(input)
      if (known) return known
      const old = await read(session.id)
      if (old?.id === input.id)
        return Status.parse({
          ...old,
          state: old.state === "pending" && !state().active.has(session.id) ? "uncertain" : old.state,
        })
      const { NativeRevert } = await import("./revert")
      await NativeRevert.guard(session.id)
      await guard(session.id)
      await available(session)
      if (NativeLock.busy(session.id)) throw new Error("Codex history is being updated. Try again shortly.")
      return NativeLock.run(session.id, async () => {
        const known = await receipt(input)
        if (known) return known
        await NativeRevert.guard(session.id)
        await guard(session.id)
        await available(session)
        const cfg = (await Config.getGlobal()).native?.codex
        const abort = new AbortController()
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)])
        state().active.set(session.id, abort)
        let connection: Awaited<ReturnType<typeof Codex.connect>> | undefined
        let saved: Saved | undefined
        let sent = false
        let busy = false
        try {
          await NativeStore.migrate(session)
          await NativeOwnership.handoff(session)
          connection = await Codex.connect({ executable: cfg?.path, cwd: session.directory, signal })
          NativeStore.bind(session.id, connection.home, false)
          const snapshot = await NativeHistory.read(connection.client, session.engine!.thread!, {
            terminal: true,
            signal,
          })
          if (!snapshot.complete || !snapshot.thread)
            throw new Error("Refresh this conversation's complete history before compacting context.")
          const goal = await connection.client
            .request("thread/goal/get", { threadId: snapshot.thread.id }, { timeout: 10_000 })
            .catch((error: unknown) => {
              if (error instanceof Protocol.RpcError && error.code === -32601) return { goal: null }
              throw error
            })
          const target = z.object({ goal: z.object({ status: z.string() }).nullable() }).parse(goal).goal
          if (target && target.status !== "complete")
            throw new Error("Finish or clear the Codex goal before compacting context.")
          const resumed = z
            .object({ thread: NativeHistory.Thread })
            .parse(await NativeOwnership.resume(connection.client, snapshot.thread.id, {}, { timeout: 15_000, signal }))
          if (resumed.thread.id !== snapshot.thread.id || resumed.thread.status.type !== "idle")
            throw new Error("The Codex thread is not idle.")
          const current = await NativeHistory.read(connection.client, snapshot.thread.id, { terminal: true, signal })
          if (!current.complete || !isDeepStrictEqual(signature(snapshot.turns), signature(current.turns)))
            throw new Error("Codex history changed while preparing compaction. Try again after it finishes.")
          await available(session)
          saved = {
            ...input,
            threadID: snapshot.thread.id,
            home: connection.home,
            state: "pending",
            history: snapshot.turns,
            updated: Date.now(),
          }
          await write(saved)
          await SessionStatus.set(session.id, { type: "busy" })
          busy = true
          const tracker = track(
            snapshot.thread.id,
            snapshot.turns.map((turn) => turn.id),
          )
          let usage: { input?: number; contextWindow?: number; total?: number; updatedAt: number } | undefined
          connection.client.listen({
            onNotification: (method, value) => {
              tracker.notify(method, value)
              if (method !== "thread/tokenUsage/updated") return
              const data = z
                .object({
                  threadId: z.literal(snapshot.thread!.id),
                  tokenUsage: z.object({
                    last: z.object({
                      inputTokens: z.number().finite().nonnegative(),
                      totalTokens: z.number().finite().nonnegative(),
                    }),
                    modelContextWindow: z.number().finite().positive().nullable().optional(),
                  }),
                })
                .safeParse(value)
              if (data.success)
                usage = {
                  input: data.data.tokenUsage.last.inputTokens,
                  total: data.data.tokenUsage.last.totalTokens,
                  contextWindow: data.data.tokenUsage.modelContextWindow ?? undefined,
                  updatedAt: Date.now(),
                }
            },
          })
          const off = connection.client.onExit(() => tracker.reject(new Error("Codex disconnected during compaction.")))
          const stop = () => tracker.reject(new Error("Context compaction timed out or the service closed."))
          signal.addEventListener("abort", stop, { once: true })
          try {
            tracker.arm()
            sent = true
            await connection.client.request(
              "thread/compact/start",
              { threadId: snapshot.thread.id },
              { timeout: 15_000, signal },
            )
            await tracker.promise
            await connection.client.drain()
            const result = await reconcile(session, saved, connection.client)
            if (result.state === "complete" && usage) {
              const last = (await NativeStore.history(session.id)).findLast((entry) => entry.info.role === "assistant")
              if (last?.info.role === "assistant") {
                const message = { ...last.info, nativeUsage: usage }
                NativeStore.receipt(message)
                await Session.updateMessage(message)
              }
            }
            return result
          } finally {
            off()
            signal.removeEventListener("abort", stop)
          }
        } catch (error) {
          if (!saved) throw error
          if (saved.state !== "complete")
            saved.state = sent && !(error instanceof Protocol.RpcError) ? "uncertain" : "failed"
          saved.error =
            error instanceof Protocol.RpcError && error.code === -32601
              ? "This Codex version does not support manual compaction. Update Codex first."
              : message(error)
          saved.updated = Date.now()
          await write(saved)
          return Status.parse(saved)
        } finally {
          try {
            const closed = await connection?.client.close().then(
              () => true,
              () => false,
            )
            if (saved?.state === "uncertain" && closed && !state().closed.has(session.id)) {
              saved.closed = true
              await write(saved)
            }
          } finally {
            state().active.delete(session.id)
            if (busy) await SessionStatus.set(session.id, { type: "idle" })
          }
        }
      })
    })
  }

  export async function status(id: SessionID, refresh = false, operation?: string): Promise<Status | null> {
    return home(id, async (session) => {
      const saved = await read(id)
      if (!saved || (operation && saved.id !== operation))
        return operation ? ((await receipt({ sessionID: id, id: operation })) ?? null) : null
      if (state().active.has(id)) return Status.parse(saved)
      if (saved.state === "pending") saved.state = "uncertain"
      if (!refresh || saved.state !== "uncertain") return Status.parse(saved)
      if (NativeLock.busy(id)) return Status.parse(saved)
      return NativeLock.run(id, async () => {
        if (session.engine?.thread !== saved.threadID)
          throw new Error("This compaction belongs to another native thread.")
        const cfg = (await Config.getGlobal()).native?.codex
        if (cfg?.enabled === false) throw new Error("Enable Codex to check compaction.")
        const connection = await Codex.connect({
          executable: cfg?.path,
          cwd: session.directory,
          signal: AbortSignal.timeout(40_000),
        })
        try {
          await NativeStore.migrate(session)
          NativeStore.bind(id, connection.home, false)
          if (connection.home !== saved.home)
            throw new Error("Restore the original Codex home before checking compaction.")
          return await reconcile(session, saved, connection.client)
        } finally {
          await connection.client.close()
        }
      })
    })
  }

  export async function clear(id: SessionID) {
    state().closed.add(id)
    state().active.get(id)?.abort()
    await NativeLock.run(id, async () => {
      await fs.rm(file(id), { force: true })
      // The directory is derived only from the validated session ID beneath our data root.
      await fs.rm(path.dirname(file(id, "00000000-0000-4000-8000-000000000000")), { recursive: true, force: true })
    })
  }

  export async function cancel(id: SessionID) {
    const abort = state().active.get(id)
    if (!abort) return
    abort.abort()
    // Do not let the ordinary stop path publish idle before the owner settles.
    await NativeLock.run(id, async () => undefined)
  }
}
