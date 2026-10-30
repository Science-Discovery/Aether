import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import launch from "cross-spawn"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Shell } from "@/shell/shell"
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

/** A durable operation identity separates destructive native work from retryable local reconciliation. */
export namespace NativeRevert {
  export const Prepare = z.object({ sessionID: SessionID.zod, messageID: MessageID.zod })
  export const Commit = z.object({ sessionID: SessionID.zod, id: z.string().uuid() })
  export const Prepared = Prepare.extend({
    id: z.string().uuid(),
    threadID: z.string(),
    turnID: z.string(),
    turns: z.number().int().positive(),
  }).meta({ ref: "NativeRevertPrepared" })
  export const Status = Prepared.extend({
    state: z.enum(["pending", "applied", "uncertain"]),
    error: z.string().optional(),
  }).meta({ ref: "NativeRevertStatus" })
  export const Result = z
    .object({
      state: z.enum(["applied", "uncertain"]),
      session: Session.Info,
      error: z.string().optional(),
    })
    .meta({ ref: "NativeRevertResult" })
  const Saved = Prepared.extend({
    phase: z.enum(["prepared", "pending", "applied", "uncertain", "failed"]),
    home: z.string().optional(),
    history: NativeHistory.Turn.array(),
    error: z.string().optional(),
  })
  type Saved = z.infer<typeof Saved>
  const state = Instance.state(() => ({ busy: new Set<SessionID>(), closed: new Set<SessionID>() }))
  const capabilities = new Map<string, Promise<boolean>>()
  const response = z.object({ thread: NativeHistory.Thread })
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const signature = (turns: NativeHistory.Turn[]) =>
    turns.map((turn) => ({ id: turn.id, status: turn.status, items: turn.items }))

  function file(id: SessionID) {
    return path.join(Global.Path.data, "native-reverts", Instance.project.id, `${SessionID.zod.parse(id)}.json`)
  }

  async function read(id: SessionID) {
    const text = await fs.readFile(file(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    return text === undefined ? undefined : Saved.parse(JSON.parse(text))
  }

  async function write(saved: Saved) {
    if (state().closed.has(saved.sessionID)) throw new Error("This conversation is being removed.")
    const target = file(saved.sessionID)
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await fs.writeFile(temp, JSON.stringify(saved), { flag: "wx", mode: 0o600 })
      if (state().closed.has(saved.sessionID)) throw new Error("This conversation is being removed.")
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  async function home<T>(id: SessionID, run: (session: Session.Info) => Promise<T>): Promise<T> {
    const session = await Session.getGlobal(id)
    if (Filesystem.resolve(session.directory) !== Instance.directory)
      return Instance.provide({ directory: session.directory, fn: () => home(id, run) })
    if (session.engine?.type !== "codex") throw new Error("This conversation does not use Codex.")
    return run(session)
  }

  export async function guard(id: SessionID, opts: { child?: string } = {}) {
    const { NativeCompact } = await import("./compact")
    await NativeCompact.guard(id)
    const { NativeTasks } = await import("./tasks")
    await NativeTasks.guard(id, opts.child)
    if (state().closed.has(id)) throw new Error("This conversation is being removed.")
    if (state().busy.has(id)) throw new Error("This conversation is being reverted. Wait for it to finish.")
    const saved = await read(id)
    if (state().closed.has(id)) throw new Error("This conversation is being removed.")
    if (state().busy.has(id) || saved?.phase === "pending" || saved?.phase === "uncertain")
      throw new Error("A Codex history revert is awaiting verification. Check its result before continuing.")
  }

  async function available(session: Session.Info) {
    const current = await Session.get(session.id)
    if (current.engine?.type !== "codex" || current.engine.thread !== session.engine?.thread)
      throw new Error("The Codex conversation changed before it could be reverted.")
    if (
      state().closed.has(session.id) ||
      NativeInteraction.active(session.id) ||
      (await SessionStatus.get(session.id)).type !== "idle"
    )
      throw new Error("Wait for this Codex task to finish before editing its history.")
    if (
      NativeAnswers.active(session.id) ||
      NativeQueue.active(session.id) ||
      (await NativeQueue.list(session.id)).items.length
    )
      throw new Error("Finish submitting answers and clear queued messages before editing this conversation.")
    if ((await Config.getGlobal()).native?.codex?.enabled === false)
      throw new Error("Enable Codex before editing its history.")
  }

  async function goal(client: Protocol.Client, id: string) {
    const value = z
      .object({ goal: z.object({ status: z.string() }).nullable() })
      .parse(await client.request("thread/goal/get", { threadId: id }, { timeout: 10_000 })).goal
    if (value && value.status !== "complete")
      throw new Error("Finish or clear this Codex goal before editing its history.")
  }

  export function supports(params: unknown, requests: unknown) {
    const shape = z
      .object({ required: z.string().array(), properties: z.record(z.string(), z.unknown()) })
      .safeParse(params)
    const methods = z
      .object({
        oneOf: z.array(
          z
            .object({
              properties: z.object({
                method: z.object({ const: z.string().optional(), enum: z.string().array().optional() }),
              }),
            })
            .passthrough(),
        ),
      })
      .safeParse(requests)
    if (!shape.success || !methods.success) return false
    const names = methods.data.oneOf.flatMap((entry) => entry.properties.method.enum ?? [entry.properties.method.const])
    return (
      ["thread/revert", "thread/resume", "thread/goal/get"].every((name) => names.includes(name)) &&
      ["threadId", "beforeTurnId"].every(
        (key) =>
          shape.data.required.includes(key) &&
          z.object({ type: z.literal("string") }).safeParse(shape.data.properties[key]).success,
      )
    )
  }

  async function capable(executable: string) {
    const stat = await fs.stat(executable)
    const key = `${executable}\n${stat.size}\n${stat.mtimeMs}\n${stat.ctimeMs}`
    const previous = capabilities.get(key)
    if (previous) return previous
    const value = (async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-codex-revert-"))
      try {
        const out = path.join(root, "schema")
        const home = path.join(root, "home")
        await fs.mkdir(home)
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(key),
          ),
        )
        const child = launch(executable, ["app-server", "generate-json-schema", "--out", out, "--experimental"], {
          env: { ...env, CODEX_HOME: home },
          cwd: root,
          stdio: "ignore",
          windowsHide: true,
        })
        const done = Promise.withResolvers<void>()
        child.once("error", done.reject)
        child.once("exit", (code) =>
          code === 0 ? done.resolve() : done.reject(new Error("Codex schema export failed")),
        )
        const exited = () => child.exitCode !== null || child.signalCode !== null
        const timer = setTimeout(() => done.reject(new Error("Codex schema export timed out")), 10_000)
        try {
          await done.promise
        } finally {
          clearTimeout(timer)
          if (!exited())
            await Promise.race([Shell.killTree(child, { exited }), Bun.sleep(2_000)]).catch(() => undefined)
          if (!exited()) child.kill("SIGKILL")
        }
        return supports(
          await Bun.file(path.join(out, "v2", "ThreadRevertParams.json")).json(),
          await Bun.file(path.join(out, "ClientRequest.json")).json(),
        )
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
      }
    })().catch(() => false)
    capabilities.set(key, value)
    if (capabilities.size > 8) capabilities.delete(capabilities.keys().next().value!)
    const result = await value
    if (!result) capabilities.delete(key)
    return result
  }

  async function connect(session: Session.Info) {
    const cfg = await Config.getGlobal()
    if (cfg.native?.codex?.enabled === false) throw new Error("Enable Codex before editing its history.")
    const executable = await Codex.discover(cfg.native?.codex?.path)
    if (!executable || !(await capable(executable)))
      throw new Error("This Codex version does not support native history editing. Update Codex before retrying.")
    return Codex.connect({ executable, cwd: session.directory, signal: AbortSignal.timeout(60_000) })
  }

  function prefix(saved: Saved) {
    const index = saved.history.findIndex((turn) => turn.id === saved.turnID)
    if (index < 0) throw new Error("The saved revert boundary is invalid.")
    return saved.history.slice(0, index)
  }

  export async function prepare(value: z.infer<typeof Prepare>): Promise<z.infer<typeof Prepared>> {
    const input = Prepare.parse(value)
    return home(input.sessionID, async (session) => {
      await guard(session.id)
      await available(session)
      if (!session.engine?.thread) throw new Error("This conversation has no native history to edit.")
      if (NativeLock.busy(session.id)) throw new Error("Codex history is being updated. Try again shortly.")
      return NativeLock.run(session.id, async () => {
        await guard(session.id)
        await available(session)
        await NativeStore.migrate(session)
        const connection = await connect(session)
        try {
          NativeStore.bind(session.id, connection.home, false)
          const snapshot = await NativeHistory.read(connection.client, session.engine!.thread!, { terminal: true })
          if (!snapshot.complete || !snapshot.thread)
            throw new Error("Codex history is incomplete or still changing. Refresh it before editing.")
          await goal(connection.client, snapshot.thread.id)
          const history = await NativeStore.history(session.id)
          const ledger = NativeStore.dispatches(session.id)
          if (
            ledger.some(
              (entry) => entry.state !== "rejected" && !snapshot.turns.some((turn) => turn.id === entry.turn_id),
            )
          )
            throw new Error("Previously delivered Codex turns are absent from this history. Refresh it before editing.")
          const projection = NativeHistory.project(snapshot, {
            sessionID: session.id,
            scope: session.id,
            cwd: session.directory,
            existing: history,
            receipts: ledger.flatMap((entry) => (entry.assistant ? [entry.assistant] : [])),
            terminal: true,
          })
          const selected = projection.messages.find((entry) => entry.info.id === input.messageID)
          const link = projection.links.find((entry) => entry.message === input.messageID)
          const index = snapshot.turns.findIndex((turn) => turn.id === link?.turn)
          if (
            selected?.info.role !== "user" ||
            !link ||
            projection.links.filter((entry) => entry.message === input.messageID).length !== 1 ||
            index < 0 ||
            link.item !== snapshot.turns[index].items.find((item) => item.type === "userMessage")?.id
          )
            throw new Error("Codex can edit only the first question of a native turn, not an in-turn follow-up.")
          const retained = snapshot.turns.slice(0, index)
          if (
            !NativeHistory.project(
              { ...snapshot, turns: retained },
              { sessionID: session.id, scope: session.id, cwd: session.directory, existing: history, terminal: true },
            ).complete
          )
            throw new Error("The retained Codex history contains unsupported items and cannot be edited safely.")
          NativeStore.prefix(
            session,
            retained.map((turn) => turn.id),
          )
          const saved: Saved = {
            ...input,
            id: crypto.randomUUID(),
            threadID: snapshot.thread.id,
            turnID: link.turn,
            turns: snapshot.turns.length - index,
            phase: "prepared",
            history: snapshot.turns,
            home: connection.home,
          }
          await available(session)
          await write(saved)
          return Prepared.parse(saved)
        } finally {
          await connection.client.close()
        }
      })
    })
  }

  async function reconcile(
    session: Session.Info,
    saved: Saved,
    client: Protocol.Client,
    rejected?: Error,
  ): Promise<z.infer<typeof Result>> {
    const snapshot = await NativeHistory.read(client, saved.threadID, { terminal: true })
    if (
      rejected &&
      snapshot.complete &&
      snapshot.thread &&
      isDeepStrictEqual(signature(snapshot.turns), signature(saved.history))
    ) {
      await write({ ...saved, phase: "failed", error: rejected.message })
      saved.phase = "failed"
      throw rejected
    }
    if (
      !snapshot.complete ||
      !snapshot.thread ||
      !isDeepStrictEqual(signature(snapshot.turns), signature(prefix(saved)))
    ) {
      saved.phase = "uncertain"
      saved.error = "The native revert result cannot be verified yet. No repeat revert was sent."
      await write(saved)
      return { state: "uncertain", session: await Session.get(session.id), error: saved.error }
    }
    await available(session)
    await NativeAnswers.reset(session.id)
    const result = await NativeSync.revert(session, snapshot)
    if (result.state !== "synced") throw new Error(result.error ?? "The reverted history could not be displayed.")
    // Discard the removed transcript once local reconciliation has committed.
    await write({ ...saved, phase: "applied", error: undefined, history: [] })
    saved.phase = "applied"
    return { state: "applied", session: await Session.get(session.id) }
  }

  export async function commit(value: z.infer<typeof Commit>): Promise<z.infer<typeof Result>> {
    const input = Commit.parse(value)
    return home(input.sessionID, async (session) => {
      if (NativeLock.busy(session.id)) throw new Error("Codex history is being updated. Try again shortly.")
      return NativeLock.run(session.id, async () => {
        const saved = await read(session.id)
        if (!saved || saved.id !== input.id) throw new Error("This edit request has expired. Prepare it again.")
        if (saved.phase === "applied") return { state: "applied", session }
        if (saved.phase === "failed") throw new Error(saved.error ?? "Prepare this edit again before continuing.")
        if (session.engine?.thread !== saved.threadID)
          throw new Error("This edit request belongs to a different native thread.")
        state().busy.add(session.id)
        let connection: Awaited<ReturnType<typeof connect>> | undefined
        try {
          await available(session)
          await NativeOwnership.handoff(session)
          connection = await connect(session)
          NativeStore.bind(session.id, connection.home, false)
          if (saved.home !== connection.home)
            throw new Error("Restore this conversation's original Codex home before editing.")
          if (saved.phase !== "prepared") return await reconcile(session, saved, connection.client)
          const snapshot = await NativeHistory.read(connection.client, saved.threadID, { terminal: true })
          if (!snapshot.complete || !isDeepStrictEqual(signature(snapshot.turns), signature(saved.history)))
            throw new Error("This conversation changed after the edit was prepared. Review it and try again.")
          NativeStore.prefix(
            session,
            prefix(saved).map((turn) => turn.id),
          )
          await goal(connection.client, saved.threadID)
          const resumed = response.parse(
            await NativeOwnership.resume(connection.client, saved.threadID, {}, { timeout: 15_000 }),
          )
          if (resumed.thread.id !== saved.threadID || resumed.thread.status.type !== "idle")
            throw new Error("The Codex thread is not idle and cannot be edited.")
          await goal(connection.client, saved.threadID)
          const current = await NativeHistory.read(connection.client, saved.threadID, { terminal: true })
          if (!current.complete || !isDeepStrictEqual(signature(current.turns), signature(saved.history)))
            throw new Error("The native conversation changed while preparing the edit.")
          await available(session)
          await write({ ...saved, phase: "pending" })
          saved.phase = "pending"
          try {
            const result = response.parse(
              await connection.client.request(
                "thread/revert",
                { threadId: saved.threadID, beforeTurnId: saved.turnID },
                { timeout: 15_000 },
              ),
            )
            if (result.thread.id !== saved.threadID) throw new Error("Codex returned a different reverted thread.")
          } catch (error) {
            if (error instanceof Protocol.RpcError) {
              return await reconcile(session, saved, connection.client, error)
            }
            saved.phase = "uncertain"
            saved.error = message(error)
            await write(saved)
            if (connection.client.closed) {
              await connection.client.close()
              connection = await connect(session)
              if (connection.home !== saved.home) throw new Error("The original Codex home is unavailable.")
            }
          }
          return await reconcile(session, saved, connection.client)
        } catch (error) {
          // Reconciliation can finish the journal before a later read fails.
          if (["applied"].includes(saved.phase)) throw error
          if (saved.phase === "pending" || saved.phase === "uncertain") {
            saved.phase = "uncertain"
            saved.error = message(error)
            await write(saved)
            return { state: "uncertain", session: await Session.get(session.id), error: saved.error }
          }
          saved.phase = "failed"
          saved.error = message(error)
          await write(saved)
          throw error
        } finally {
          try {
            await connection?.client.close()
          } finally {
            state().busy.delete(session.id)
          }
        }
      })
    })
  }

  export async function status(id: SessionID, operation?: string): Promise<z.infer<typeof Status> | null> {
    return home(id, async () => {
      const saved = await read(id)
      if (!saved || (operation && saved.id !== operation) || saved.phase === "prepared" || saved.phase === "failed")
        return null
      return Status.parse({
        ...saved,
        state: saved.phase === "applied" ? "applied" : state().busy.has(id) ? "pending" : "uncertain",
      })
    })
  }

  export async function clear(id: SessionID) {
    state().closed.add(id)
    await NativeLock.run(id, () => fs.rm(file(id), { force: true }))
  }
}
