import fs from "node:fs/promises"
import path from "node:path"
import { and, eq, sql } from "drizzle-orm"
import z from "zod"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { Lock } from "@/util/lock"
import { Codex } from "./codex"
import { NativeHistory } from "./history"
import { NativeInheritance } from "./inheritance"
import { NativeLock } from "./lock"
import { Native } from "./schema"
import { NativeStore } from "./store"
import { NativeSync } from "./sync"

/** Linking only: native threads are never resumed, copied or rewritten here. */
export namespace NativeChats {
  export const Query = z
    .object({
      search: z.string().trim().max(200).optional(),
      cursor: z.string().min(1).max(4096).optional(),
      scope: z.string().min(1).max(200).optional(),
    })
    .strict()
  export const Input = z.object({ threadID: z.string().min(1).max(200), scope: z.string().min(1).max(200) }).strict()
  export const Chat = z
    .object({
      id: z.string(),
      title: z.string(),
      updated: z.number(),
      state: z.string(),
      sessionID: SessionID.zod.optional(),
    })
    .meta({ ref: "NativeChat" })
  export const Page = z
    .object({
      scope: z.string(),
      chats: Chat.array(),
      cursor: z.string().optional(),
    })
    .meta({ ref: "NativeChatPage" })

  const thread = NativeHistory.Thread.extend({
    cwd: z.string().min(1).refine(path.isAbsolute),
    ephemeral: z.boolean(),
    parentThreadId: z.string().nullable().optional(),
    source: z.unknown(),
    name: z.string().nullable().optional(),
    preview: z.string().optional(),
    model: z.string().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
  })
  const page = z.object({ data: thread.array().max(100), nextCursor: z.string().min(1).max(4096).nullable() })

  async function canonical(dir: string) {
    const value = await fs.realpath(path.resolve(dir))
    return process.platform === "win32" ? value.toLowerCase() : value
  }

  function interactive(value: z.infer<typeof thread>) {
    return !value.ephemeral && !value.parentThreadId && ["cli", "vscode", "appServer"].includes(String(value.source))
  }

  function linked(id: string, home: string) {
    const rows = Database.useProject(Instance.project.id, (db) =>
      db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, Instance.project.id),
            eq(sql<string>`json_extract(${SessionTable.engine}, '$.type')`, "codex"),
            eq(sql<string>`json_extract(${SessionTable.engine}, '$.thread')`, id),
          ),
        )
        .all(),
    )
    // An unbound legacy session also reserves the native identity. Do not create
    // another local executor while its original home cannot be established.
    return rows.filter((row) => !NativeStore.state(row.id)?.home || NativeStore.state(row.id)?.home === home)
  }

  async function connection() {
    const cfg = await Config.getGlobal()
    if (cfg.native?.codex?.enabled === false) throw new Error("Enable Codex before browsing its chats.")
    const root = await canonical(Instance.directory)
    const home = process.env.CODEX_HOME
    const result = await Codex.connect({
      executable: cfg.native?.codex?.path,
      cwd: Instance.directory,
      signal: AbortSignal.timeout(60_000),
    })
    if (!result.home) {
      await result.client.close()
      throw new Error("This Codex version does not report its home. Update Codex before linking chats.")
    }
    return {
      ...result,
      home: result.home,
      path: cfg.native?.codex?.path,
      env: home,
      scope: NativeHistory.key(result.home, root),
    }
  }

  async function current(file?: string, home?: string) {
    const cfg = await Config.getGlobal()
    if (cfg.native?.codex?.enabled === false || cfg.native?.codex?.path !== file || process.env.CODEX_HOME !== home)
      throw new Error("The Codex connection changed. Refresh its chat list.")
  }

  export async function list(input: z.infer<typeof Query> = {}): Promise<z.infer<typeof Page>> {
    const value = Query.parse(input)
    if (value.cursor && !value.scope) throw new Error("Refresh the chat list before loading another page.")
    const conn = await connection()
    try {
      if (value.scope && value.scope !== conn.scope)
        throw new Error("The Codex home or project changed. Refresh its chat list.")
      const root = await canonical(Instance.directory)
      const result = page.parse(
        await conn.client.request(
          "thread/list",
          {
            cursor: value.cursor,
            limit: 30,
            sortKey: "updated_at",
            sortDirection: "desc",
            // Listing must not scan and repair every saved rollout. The native
            // clients use the index too; attachment verifies full history below.
            useStateDbOnly: true,
            sourceKinds: ["cli", "vscode", "appServer"],
            cwd: [...new Set([Instance.directory, Instance.directory.replaceAll("\\", "/")])],
            archived: false,
            searchTerm: value.search || undefined,
          },
          { timeout: 15_000 },
        ),
      )
      if (result.nextCursor && result.nextCursor === value.cursor) throw new Error("Codex repeated a chat-list cursor.")
      const chats = await Promise.all(
        result.data.filter(interactive).map(async (item) => {
          if ((await canonical(item.cwd).catch(() => undefined)) !== root) return
          const rows = linked(item.id, conn.home)
          return {
            id: item.id,
            title: (item.name?.trim() || item.preview?.trim() || item.id).slice(0, 300),
            updated: item.updatedAt * 1000,
            state: item.status.type,
            sessionID: rows.length === 1 && NativeStore.state(rows[0].id)?.home === conn.home ? rows[0].id : undefined,
          }
        }),
      )
      await current(conn.path, conn.env)
      return {
        scope: conn.scope,
        chats: chats.filter((item) => item !== undefined),
        cursor: result.nextCursor ?? undefined,
      }
    } finally {
      await conn.client.close()
    }
  }

  export async function attach(input: z.infer<typeof Input>): Promise<Session.Info> {
    const value = Input.parse(input)
    return link(value.threadID, { scope: value.scope })
  }

  /** Internal task navigation supplies the verified root's pinned native home. */
  export async function child(threadID: string, ancestor: string, home: string): Promise<Session.Info> {
    if (!threadID || !ancestor || !home || threadID === ancestor)
      throw new Error("A native child and its parent are required.")
    return link(threadID, { ancestor, home })
  }

  async function link(id: string, opts: { scope?: string; ancestor?: string; home?: string }): Promise<Session.Info> {
    const conn = await connection()
    try {
      if ((opts.scope && conn.scope !== opts.scope) || (opts.home && conn.home !== opts.home))
        throw new Error("The Codex home or project changed. Refresh its chat list.")
      using gate = await Lock.write(`native-link:${conn.home}:${id}`)
      const rows = linked(id, conn.home)
      if (rows.length > 1)
        throw new Error("This native chat already has multiple Aether links. Open an existing chat instead.")
      if (rows.length && NativeStore.state(rows[0].id)?.home !== conn.home)
        throw new Error(
          "An existing Aether chat reserves this thread but its Codex home is not confirmed. Open that chat first.",
        )
      const snapshot = await NativeHistory.read(conn.client, id, { terminal: true })
      const source = thread.parse(snapshot.thread)
      const root = await canonical(Instance.directory)
      if (source.ephemeral || (await canonical(source.cwd)) !== root || (!opts.ancestor && !interactive(source)))
        throw new Error("Only saved interactive Codex chats from this project can be linked.")
      if (opts.ancestor) {
        const seen = new Set([id])
        let item = source
        for (let count = 0; ; count++) {
          const legacy = z
            .object({ subAgent: z.object({ thread_spawn: z.object({ parent_thread_id: z.string() }) }) })
            .safeParse(item.source)
          if (
            item.parentThreadId &&
            legacy.success &&
            item.parentThreadId !== legacy.data.subAgent.thread_spawn.parent_thread_id
          )
            throw new Error("Codex returned conflicting parent relationships for this child.")
          const parent =
            item.parentThreadId ?? (legacy.success ? legacy.data.subAgent.thread_spawn.parent_thread_id : undefined)
          if (!parent || seen.has(parent) || count >= 32)
            throw new Error("This child no longer has a verifiable relationship to the original task.")
          seen.add(parent)
          item = z
            .object({ thread })
            .parse(
              await conn.client.request("thread/read", { threadId: parent, includeTurns: false }, { timeout: 10_000 }),
            ).thread
          if (item.id !== parent || (await canonical(item.cwd)) !== root)
            throw new Error("The child's original project could not be verified.")
          if (parent === opts.ancestor) break
        }
      }
      if (rows.length) {
        const session = await Session.get(rows[0].id)
        if ((await canonical(session.directory)) !== root)
          throw new Error("This native chat is linked to another Aether directory.")
        await current(conn.path, conn.env)
        return session
      }
      if (!snapshot.complete || snapshot.turns.some((turn) => !NativeHistory.terminal(turn)))
        throw new Error("Wait for this Codex chat to finish, then refresh and link it again.")
      const goal = z
        .object({ goal: z.object({ status: z.string() }).nullable() })
        .parse(await conn.client.request("thread/goal/get", { threadId: source.id }, { timeout: 10_000 })).goal
      if (goal && goal.status !== "complete")
        throw new Error("Finish or clear this chat's goal in Codex before linking it to Aether.")
      const target = SessionID.descending()
      const projection = NativeHistory.project(snapshot, {
        sessionID: target,
        scope: target,
        cwd: Instance.directory,
        terminal: true,
      })
      if (!projection.complete) throw new Error("This native chat contains history Aether cannot fully display yet.")
      await current(conn.path, conn.env)
      return await NativeLock.run(target, async () => {
        const session = await Session.createNext({
          id: target,
          directory: Instance.directory,
          title: (source.name?.trim() || source.preview?.trim() || source.id).slice(0, 300),
          engine: Native.Engine.parse({
            type: "codex",
            thread: source.id,
            model: source.model || undefined,
            effort: source.reasoningEffort || undefined,
            permission: "auto",
          }),
        })
        await NativeStore.migrate(session)
        NativeStore.bind(target, conn.home)
        const sources = await NativeInheritance.collect(session, snapshot, conn.client)
        const result = await NativeSync.apply(session, snapshot, { terminal: true, sources })
        if (result.state !== "synced")
          throw new Error(result.error ?? "The linked chat's history could not be displayed.")
        return session
      }).catch(async (error: unknown) => {
        await Session.remove(target)
        throw error
      })
    } finally {
      await conn.client.close()
    }
  }
}
