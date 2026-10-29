import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import launch from "cross-spawn"
import z from "zod"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionID, type MessageID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Shell } from "@/shell/shell"
import { Filesystem } from "@/util/filesystem"
import { Codex } from "./codex"
import { NativeHistory } from "./history"
import { NativeInteraction } from "./interaction"
import { NativeLock } from "./lock"
import { NativePermissions } from "./permissions"
import type { Protocol } from "./protocol"
import { Native } from "./schema"
import { NativeStore } from "./store"
import { NativeSync } from "./sync"
import { NativeInheritance } from "./inheritance"

export namespace NativeFork {
  export type Input = { sessionID: SessionID; messageID?: MessageID; after?: boolean }
  export type Prepared = { id: SessionID; source: Session.Info; engine: Native.Engine; anchor?: MessageID }
  const object = z.record(z.string(), z.unknown())
  const response = z.object({ thread: NativeHistory.Thread, model: z.string().optional() })
  const cache = new Map<string, Promise<boolean>>()

  /** Validate advertised fields, including the guard against automatic goal continuation. */
  export function supports(value: unknown, requests: unknown) {
    const parsed = z.object({ properties: object, required: z.string().array() }).safeParse(value)
    const methods = z.object({ oneOf: object.array() }).safeParse(requests)
    if (!parsed.success || !methods.success || !parsed.data.required.includes("threadId")) return false
    const field = (name: string, type: string) => {
      const item = object.safeParse(parsed.data.properties[name]).data
      return item?.type === type || (Array.isArray(item?.type) && item.type.includes(type))
    }
    const names = methods.data.oneOf.flatMap((item) => {
      const props = object.safeParse(item.properties).data
      const method = object.safeParse(props?.method).data
      return typeof method?.const === "string" ? [method.const] : Array.isArray(method?.enum) ? method.enum : []
    })
    return (
      ["thread/fork", "thread/goal/get"].every((name) => names.includes(name)) &&
      ["threadId", "lastTurnId"].every((name) => field(name, "string")) &&
      ["excludeTurns", "deferGoalContinuation"].every((name) => field(name, "boolean")) &&
      NativePermissions.supports(value)
    )
  }

  async function inspect(file: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-codex-fork-"))
    try {
      const home = path.join(root, "home")
      const out = path.join(root, "schema")
      await fs.mkdir(home)
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(key)),
      )
      const child = launch(file, ["app-server", "generate-json-schema", "--out", out, "--experimental"], {
        cwd: root,
        env: {
          ...env,
          CODEX_HOME: home,
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
        },
        stdio: "ignore",
        windowsHide: true,
        detached: process.platform !== "win32",
      })
      const done = Promise.withResolvers<void>()
      const exited = () => child.exitCode !== null || child.signalCode !== null
      child.once("error", done.reject)
      child.once("exit", (code) => (code === 0 ? done.resolve() : done.reject(new Error("Codex schema export failed"))))
      const timer = setTimeout(() => done.reject(new Error("Codex schema export timed out")), 10_000)
      try {
        await done.promise
      } finally {
        clearTimeout(timer)
        if (!exited()) {
          await Promise.race([Shell.killTree(child, { exited }), Bun.sleep(2_000)]).catch(() => undefined)
          if (!exited()) child.kill("SIGKILL")
        }
      }
      return supports(
        await Bun.file(path.join(out, "v2", "ThreadForkParams.json")).json(),
        await Bun.file(path.join(out, "ClientRequest.json")).json(),
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async function capability(file: string) {
    const stat = await fs.stat(file)
    const key = `${file}\n${stat.size}\n${stat.mtimeMs}\n${stat.ctimeMs}`
    const known = cache.get(key)
    if (known) return known
    const pending = inspect(file).catch(() => false)
    cache.set(key, pending)
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
    const result = await pending
    if (!result) cache.delete(key)
    return result
  }

  async function available(id: SessionID, thread?: string) {
    const current = await Session.get(id)
    if (current.engine?.type !== "codex" || current.engine.thread !== thread)
      throw new Error("The original Codex conversation changed before the fork completed.")
    if (NativeInteraction.active(id) || (await SessionStatus.get(id)).type !== "idle")
      throw new Error("Wait for this Codex task to finish before forking it.")
  }

  async function goal(client: Protocol.Client, thread: string) {
    const value = z
      .object({ goal: z.object({ status: z.string() }).nullable().optional() })
      .parse(await client.request("thread/goal/get", { threadId: thread }, { timeout: 10_000 })).goal
    if (value && value.status !== "complete")
      throw new Error(
        `Codex thread ${thread} has a goal. Finish or clear it in Codex before forking; Aether will not automatically continue that goal.`,
      )
  }

  export async function run(input: Input, create: (value: Prepared) => Promise<Session.Info>): Promise<Session.Info> {
    const source = await Session.getGlobal(input.sessionID)
    if (Filesystem.resolve(source.directory) !== Instance.directory)
      return Instance.provide({ directory: source.directory, fn: () => run(input, create) })
    if (source.engine?.type !== "codex") throw new Error("This session does not use Codex.")
    const { NativeRevert } = await import("./revert")
    await NativeRevert.guard(source.id)
    await available(source.id, source.engine.thread)
    if (NativeLock.busy(source.id)) throw new Error("Codex history is being updated. Please try again shortly.")
    return NativeLock.run(source.id, async () => {
      await NativeRevert.guard(source.id)
      await available(source.id, source.engine!.thread)
      const cfg = await Config.getGlobal()
      if (cfg.native?.codex?.enabled === false) throw new Error("Enable Codex before forking this conversation.")
      const engine = Native.Input.parse({
        type: source.engine!.type,
        model: source.engine!.model,
        effort: source.engine!.effort,
        mode: source.engine!.mode,
        permission: source.engine!.permission,
      })
      const messages = await NativeStore.history(source.id)
      if (!source.engine!.thread) {
        if (messages.length || input.messageID)
          throw new Error("This conversation has no confirmed native history to fork.")
        await available(source.id)
        return create({ id: SessionID.descending(), source, engine })
      }
      const file = await Codex.discover(cfg.native?.codex?.path)
      if (!file) throw new Error("Codex was not found. Check the native backend connection.")
      const connection = await Codex.connect({
        executable: file,
        cwd: source.directory,
        signal: AbortSignal.timeout(60_000),
      })
      try {
        const home = NativeStore.state(source.id)?.home
        if (home && connection.home !== home)
          throw new Error("Restore this conversation's original Codex home before forking it.")
        const snapshot = await NativeHistory.read(connection.client, source.engine!.thread!, { terminal: true })
        if (!snapshot.thread || snapshot.issues.some((issue) => !issue.turn))
          throw new Error(
            "Codex history is incomplete or still changing. Refresh it after the task finishes before forking.",
          )
        const projection = NativeHistory.project(snapshot, {
          sessionID: source.id,
          scope: source.id,
          cwd: source.directory,
          existing: messages,
          receipts: NativeStore.dispatches(source.id).flatMap((entry) => (entry.assistant ? [entry.assistant] : [])),
          terminal: true,
        })
        const selected = input.messageID
          ? projection.messages.find((entry) => entry.info.id === input.messageID)
          : undefined
        if (input.messageID && !selected)
          throw new Error("The selected message is not in confirmed Codex history. Refresh the conversation.")
        const link = selected && projection.links.find((entry) => entry.message === selected.info.id)
        const at = link ? snapshot.turns.findIndex((turn) => turn.id === link.turn) : snapshot.turns.length
        const users =
          at < snapshot.turns.length ? snapshot.turns[at].items.filter((item) => item.type === "userMessage") : []
        if (selected) {
          if (!link || at < 0) throw new Error("The selected message has no native turn boundary.")
          if (!input.after && (selected.info.role !== "user" || link.item !== users[0]?.id))
            throw new Error(
              "Codex can fork only between complete turns. Editing an in-turn follow-up is not supported.",
            )
          const parent = selected.info.role === "assistant" ? selected.info.parentID : selected.info.id
          const tail = projection.links.find((entry) => entry.turn === link.turn && entry.item === users.at(-1)?.id)
          if (input.after && parent !== tail?.message)
            throw new Error(
              "This message has later follow-ups in the same Codex turn. Fork after its final response instead.",
            )
        }
        const turns = snapshot.turns.slice(0, selected ? at + (input.after ? 1 : 0) : snapshot.turns.length)
        const retained = new Set(turns.map((turn) => turn.id))
        const issues = projection.issues.filter((issue) => !issue.turn || retained.has(issue.turn))
        if (issues.some((issue) => issue.code === "unsettled"))
          throw new Error("The selected Codex history is incomplete or still changing. Wait for that turn to finish.")
        if (issues.length)
          throw new Error(
            "This Codex history prefix contains unsupported items; an exact fork cannot be displayed yet.",
          )
        const last = turns.at(-1)
        const anchor =
          last &&
          projection.links.find(
            (entry) =>
              entry.turn === last.id && entry.item === last.items.findLast((item) => item.type === "userMessage")?.id,
          )?.message
        if (anchor && !messages.some((entry) => entry.info.id === anchor))
          throw new Error("Refresh the original conversation before forking its latest history.")
        if (!last) {
          await available(source.id, source.engine!.thread)
          return create({ id: SessionID.descending(), source, engine })
        }
        if (!(await capability(file)))
          throw new Error(
            "This Codex version does not advertise safe turn-boundary forking. Update Codex before retrying.",
          )
        await goal(connection.client, snapshot.thread.id)
        await available(source.id, source.engine!.thread)
        const fork = response.parse(
          await connection.client.request(
            "thread/fork",
            {
              threadId: snapshot.thread.id,
              lastTurnId: last.id,
              excludeTurns: true,
              deferGoalContinuation: true,
              cwd: source.directory,
              model: engine.model,
              ...NativePermissions.resolve(engine.permission, source.directory, { auto: true }).thread,
            },
            { timeout: 15_000 },
          ),
        )
        if (
          fork.thread.id === snapshot.thread.id ||
          (fork.thread.forkedFromId != null && fork.thread.forkedFromId !== snapshot.thread.id)
        )
          throw new Error("Codex did not return a separate fork of the original thread.")
        await goal(connection.client, fork.thread.id)
        const child = await NativeHistory.read(connection.client, fork.thread.id, { terminal: true })
        if (
          !child.complete ||
          !isDeepStrictEqual(
            child.turns.map((turn) => ({ id: turn.id, status: turn.status, items: turn.items })),
            turns.map((turn) => ({ id: turn.id, status: turn.status, items: turn.items })),
          )
        )
          throw new Error(
            `The new native thread ${fork.thread.id} could not be verified at the requested boundary. The original conversation was preserved; no retry was sent.`,
          )
        await available(source.id, source.engine!.thread)
        const id = SessionID.descending()
        let cleanup: Promise<void> | undefined
        // Creation publishes the child before returning. Reserve it before that
        // event so refreshes and input cannot race the initial history import.
        return await NativeLock.run(id, async () => {
          try {
            const session = await create({
              id,
              source,
              engine: {
                ...engine,
                model: fork.model ?? engine.model,
                collaboration: source.engine!.collaboration,
                thread: fork.thread.id,
              },
              anchor,
            })
            await NativeStore.migrate(session)
            NativeStore.bind(session.id, connection.home)
            const sources = await NativeInheritance.collect(session, child, connection.client, {
              source: { session: source, snapshot },
            })
            const result = await NativeSync.apply(session, child, { terminal: true, sources })
            if (result.state !== "synced") throw new Error(result.error ?? "The forked history could not be displayed.")
            return session
          } catch (error) {
            // Close input before releasing the lock, but await deletion outside
            // it: clear() and Session.remove() acquire this same child lock.
            cleanup = NativeRevert.clear(id)
            throw error
          }
        }).catch(async (error) => {
          await cleanup?.catch(() => undefined)
          await Session.remove(id)
          throw error
        })
      } finally {
        await connection.client.close()
      }
    })
  }
}
