import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs"
import { Database as BunSqlite } from "bun:sqlite"
import { EOL } from "os"

import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { init } from "#db"
import { detectCorruption, quarantine, DbRecovery } from "./db-recovery"
import type { CorruptionType } from "./db-recovery"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export function norm(input: string) {
    return path.resolve(input).replace(/\\/g, "/").toLowerCase()
  }

  export type Source = {
    path: string
    current: boolean
    client?: ReturnType<typeof Client>
    error?: string
  }

  function channel() {
    const ch = Installation.CHANNEL
    if (["latest", "beta"].includes(ch) || Flag.OPENCODE_DISABLE_CHANNEL_DB) return "latest"
    return ch.replace(/[^a-zA-Z0-9._-]/g, "-")
  }

  export function channelDir() {
    return path.join(Global.Path.data, channel())
  }

  export function getChannelPath() {
    if (["latest", "beta"].includes(Installation.CHANNEL) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(Global.Path.data, "aether.db")
    return path.join(Global.Path.data, `aether-${channel()}.db`)
  }

  function ensureChannelDir() {
    const dir = channelDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  export function cronPath() {
    return path.join(ensureChannelDir(), `aether-cron.db`)
  }

  export function projectPath(projectId: string) {
    return path.join(ensureChannelDir(), `aether-${projectId}.db`)
  }

  export function projectPaths(): string[] {
    const dir = channelDir()
    if (!existsSync(dir)) return []
    const pattern = new RegExp(`^aether-.+\\.db$`)
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && pattern.test(entry.name))
        .map((entry) => path.join(dir, entry.name))
        .sort()
    } catch {
      return []
    }
  }

  export const Path = iife(() => {
    if (Flag.OPENCODE_DB) {
      if (Flag.OPENCODE_DB === ":memory:" || path.isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
      return path.join(Global.Path.data, Flag.OPENCODE_DB)
    }
    return getChannelPath()
  })

  export function currentPath() {
    return Path
  }

  export function knownPaths() {
    const current = Path
    const currentFile = current === ":memory:" ? undefined : norm(current)
    const ch = channel()
    const projectCronPattern = new RegExp(`^aether-${ch}-(cron|[0-9a-f]+)\\.db$`, "i")
    try {
      const seen = new Set<string>()
      return readdirSync(Global.Path.data, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^aether.*\.db$/i.test(entry.name) && !projectCronPattern.test(entry.name))
        .map((entry) => path.join(Global.Path.data, entry.name))
        .sort()
        .filter((file) => {
          const key = norm(file)
          if (key === currentFile) return false
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
    } catch (error) {
      log.warn("failed to enumerate known database paths", { error, dir: Global.Path.data })
      return []
    }
  }

  export function withSources<T>(callback: (source: Source) => T) {
    const result: T[] = []
    result.push(
      callback({
        path: currentPath(),
        current: true,
        client: Client(),
      }),
    )
    for (const file of knownPaths()) {
      let db: ReturnType<typeof init> | undefined
      try {
        db = init(file)
        result.push(
          callback({
            path: file,
            current: false,
            client: db,
          }),
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.warn("failed to open known database source", { path: file, error: reason })
        result.push(
          callback({
            path: file,
            current: false,
            error: reason,
          }),
        )
      } finally {
        db?.$client.close()
      }
    }
    return result
  }

  export type Transaction = SQLiteTransaction<"sync", void>

  type Client = SQLiteBunDatabase

  type Journal = { sql: string; timestamp: number; name: string }[]

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  const lockBuffer = new SharedArrayBuffer(4)
  const lockView = new Int32Array(lockBuffer)

  function wait(ms: number) {
    Atomics.wait(lockView, 0, 0, ms)
  }

  function withInitLock<T>(callback: () => T): T {
    if (Path === ":memory:") return callback()

    const lock = `${Path}.init.lock`
    mkdirSync(path.dirname(lock), { recursive: true })
    const started = Date.now()
    let warned = false

    while (true) {
      try {
        mkdirSync(lock)
        break
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined
        if (code !== "EEXIST") throw error

        try {
          const age = Date.now() - statSync(lock).mtimeMs
          if (age > 30_000) {
            rmSync(lock, { recursive: true, force: true })
            continue
          }
        } catch {
          continue
        }

        if (!warned && Date.now() - started > 5_000) {
          warned = true
          log.warn("waiting for database initialization lock", { path: Path, lock })
        }
        wait(50)
      }
    }

    try {
      return callback()
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: Path })

    return withInitLock(() => {
      const corruption = detectCorruption(Path)
      if (corruption) {
        const entry = quarantine(Path, "main")
        log.error("main db corrupted, quarantining and recreating", {
          corruptionType: entry.corruptionType,
          quarantinePath: entry.quarantinePath,
        })
        process.stderr.write(`Main database corrupted (${entry.corruptionType}). Creating fresh database.${EOL}`)
        process.stderr.write(`Corrupted file preserved at: ${entry.quarantinePath}${EOL}`)
        process.stderr.write(`Auto-recovery will be attempted after startup.${EOL}`)
      }

      return initAndSetup(Path)
    })
  })

  export function close() {
    if (Client.isLoaded()) {
      Client().$client.close()
      Client.reset()
    }
    for (const [, client] of projectClients) {
      client.$client.close()
    }
    projectClients.clear()
    if (CronClient.isLoaded()) {
      CronClient().$client.close()
      CronClient.reset()
    }
  }

  type DrizzleClient = ReturnType<typeof init>

  export const CronClient = lazy(() => {
    const p = cronPath()
    log.info("opening cron database", { path: p })

    const corruption = detectCorruption(p)
    if (corruption) {
      const entry = quarantine(p, "cron")
      log.error("cron db corrupted, quarantining and recreating", {
        corruptionType: entry.corruptionType,
        quarantinePath: entry.quarantinePath,
      })
    }

    const db = init(p)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    const isNewCronDb = seedSplitMigration(db)
    if (!isNewCronDb) seedAllMigrations(db)
    applyMigrations(db)
    db.run("PRAGMA wal_checkpoint(PASSIVE)")
    return db
  })

  export function useCron<T>(callback: (trx: TxOrDb) => T): T {
    return callback(CronClient())
  }

  const SPLIT_MIGRATION_NAME = "20260507071748_per_project_db_split"

  const projectClients = new Map<string, DrizzleClient>()

  function splitMigrationEntry() {
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    const entry = entries.find((e) => e.name === SPLIT_MIGRATION_NAME)
    if (!entry) return undefined
    const hash = createHash("sha256").update(entry.sql).digest("hex")
    return { hash, millis: entry.timestamp, name: entry.name }
  }

  function seedAllMigrations(db: DrizzleClient) {
    const sqlite = db.$client
    sqlite.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`)
    const existingNames = new Set(
      (sqlite.prepare("SELECT name FROM __drizzle_migrations").all() as { name: string }[]).map((r) => r.name),
    )
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    const insert = sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
    )
    for (const entry of entries) {
      if (existingNames.has(entry.name)) continue
      const hash = createHash("sha256").update(entry.sql).digest("hex")
      insert.run(hash, entry.timestamp, entry.name, new Date().toISOString())
    }
  }

  function seedSplitMigration(db: DrizzleClient): boolean {
    const sqlite = db.$client
    sqlite.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`)
    const existing = sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE name = ?").get(SPLIT_MIGRATION_NAME)
    if (existing) return false
    const meta = splitMigrationEntry()
    if (!meta) return false
    sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)")
      .run(meta.hash, meta.millis, meta.name, new Date().toISOString())
    log.info("seeded split migration record for new db")
    return true
  }

  function postSplitFixupMain(db: DrizzleClient) {
    const sqlite = db.$client
    sqlite.exec(`CREATE TABLE IF NOT EXISTS global_project_map (
      directory text PRIMARY KEY,
      project_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )`)
    const hasProjectRecent = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_recent'")
      .get()
    if (hasProjectRecent) {
      const fks = sqlite.prepare("PRAGMA foreign_key_list(project_recent)").all() as {
        table: string
        from: string
      }[]
      const hasProjectFK = fks.some((fk) => fk.table === "project" && fk.from === "project_id")
      if (hasProjectFK) {
        sqlite.exec("PRAGMA foreign_keys = OFF")
        sqlite.exec(`
          CREATE TABLE __new_project_recent (
            key text PRIMARY KEY,
            kind text NOT NULL,
            project_id text,
            directory text NOT NULL,
            name text,
            icon_url text,
            icon_color text,
            icon_override text,
            activity_at integer NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          );
          INSERT INTO __new_project_recent(key, kind, project_id, directory, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated)
            SELECT key, kind, project_id, directory, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated FROM project_recent;
          DROP TABLE project_recent;
          ALTER TABLE __new_project_recent RENAME TO project_recent;
          CREATE INDEX IF NOT EXISTS project_recent_activity_idx ON project_recent (activity_at);
        `)
        sqlite.exec("PRAGMA foreign_keys = ON")
        log.info("stripped project_recent FK in main db")
      }
    }
  }

  function applyMigrations(db: Client) {
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) migrate(db, entries)
  }

  function initAndSetup(dbPath: string): DrizzleClient {
    const db = init(dbPath)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_checkpoint(PASSIVE)")
    const isNewDb = seedSplitMigration(db)
    if (!isNewDb) seedAllMigrations(db)
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      migrate(db, entries)
    }
    if (isNewDb) postSplitFixupMain(db)
    registerUntrackedProjects(db)
    return db
  }

  function initAndSetupProject(dbPath: string): DrizzleClient {
    const db = init(dbPath)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    const isNewProjDb = seedSplitMigration(db)
    if (!isNewProjDb) seedAllMigrations(db)
    applyMigrations(db)
    db.run("PRAGMA wal_checkpoint(PASSIVE)")
    return db
  }

  export function attach(projectId: string): DrizzleClient {
    const existing = projectClients.get(projectId)
    if (existing) return existing
    const p = projectPath(projectId)

    if (!existsSync(p) && projectId !== "global") {
      const mainSqlite = Client().$client
      const registered = mainSqlite.prepare("SELECT 1 FROM global_project_map WHERE project_id = ?").get(projectId)
      if (!registered) {
        throw new Error(`Cannot create project database: ${projectId} is not registered`)
      }
    }

    log.info("opening project database", { projectId, path: p })

    try {
      const db = initAndSetupProject(p)
      projectClients.set(projectId, db)
      return db
    } catch (err) {
      log.warn("project db failed to open, quarantining and recreating", { projectId, error: String(err) })
      quarantine(p, "project", projectId)
      const db = initAndSetupProject(p)
      projectClients.set(projectId, db)
      return db
    }
  }

  export function detach(projectId: string) {
    const client = projectClients.get(projectId)
    if (!client) return
    log.info("closing project database", { projectId })
    client.$client.close()
    projectClients.delete(projectId)
  }

  export function hasProject(projectId: string): boolean {
    if (projectClients.has(projectId)) return true
    return existsSync(projectPath(projectId))
  }

  export function deleteProject(projectId: string) {
    detach(projectId)
    const p = projectPath(projectId)
    if (!existsSync(p)) return
    unlinkSync(p)
    for (const ext of ["-shm", "-wal"]) {
      if (existsSync(p + ext)) unlinkSync(p + ext)
    }
    log.info("deleted project database file", { projectId, path: p })
  }

  export function projectClient(projectId: string): DrizzleClient {
    return attach(projectId)
  }

  export function useProject<T>(projectId: string, callback: (trx: TxOrDb) => T): T {
    const client = projectClient(projectId)
    const result = callback(client)
    return result
  }

  export function transactionProject<T>(
    projectId: string,
    callback: (tx: TxOrDb) => NotPromise<T>,
    options?: {
      behavior?: "deferred" | "immediate" | "exclusive"
    },
  ): NotPromise<T> {
    const client = projectClient(projectId)
    return client.transaction(callback, { behavior: options?.behavior }) as NotPromise<T>
  }

  export type TxOrDb = Transaction | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      const store = ctx.use()
      return callback(store.tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        let result: T
        try {
          result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        } catch (e) {
          throw e
        }
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  type NotPromise<T> = T extends Promise<any> ? never : T

  function ensureDirectoryMeta(pSqlite: BunSqlite, pid: string, recentLookup: Map<string, any>) {
    const hasTable = pSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'")
      .get()
    if (!hasTable) return

    const existingCount = (pSqlite.prepare("SELECT count(*) as cnt FROM directory_meta").get() as { cnt: number }).cnt
    if (existingCount > 0) return

    const projectRow = pSqlite.prepare("SELECT worktree, vcs FROM project WHERE id = ?").get(pid) as
      | { worktree: string; vcs: string | null }
      | undefined
    if (!projectRow) return

    const worktree = projectRow.worktree

    const directories = (
      pSqlite.prepare("SELECT DISTINCT directory FROM session").all() as { directory: string }[]
    ).map((r) => r.directory)

    if (!directories.includes(worktree)) directories.push(worktree)

    const insert = pSqlite.prepare(
      "INSERT OR IGNORE INTO directory_meta (directory, worktree, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )

    for (const dir of directories) {
      const dirNorm = norm(dir)
      const recentRow = recentLookup.get(dirNorm)
      insert.run(
        dir,
        worktree,
        recentRow?.name ?? null,
        recentRow?.icon_url ?? null,
        recentRow?.icon_color ?? null,
        recentRow?.icon_override ?? null,
        recentRow?.activity_at ?? Date.now(),
        Date.now(),
        Date.now(),
      )
    }
  }

  function syncDirectoryMetaToGlobal(sqlite: BunSqlite, pSqlite: BunSqlite, pid: string) {
    const hasTable = pSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'")
      .get()
    if (!hasTable) return

    const projectRow = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
      | { worktree: string }
      | undefined
    const canonicalWorktree = projectRow?.worktree ?? "/"

    const metaRows = pSqlite.prepare("SELECT * FROM directory_meta").all() as {
      directory: string
      worktree: string
      name: string | null
      icon_url: string | null
      icon_color: string | null
      icon_override: string | null
      activity_at: number
      time_created: number
      time_updated: number
    }[]

    const insertMap = sqlite.prepare(
      `INSERT INTO global_project_map (directory, project_id, time_created, time_updated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(directory) DO UPDATE SET project_id = excluded.project_id, time_updated = excluded.time_updated`,
    )
    const insertRecent = sqlite.prepare(
      `INSERT INTO project_recent (key, kind, project_id, directory, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, icon_url = excluded.icon_url, icon_color = excluded.icon_color, icon_override = excluded.icon_override, activity_at = excluded.activity_at, time_updated = excluded.time_updated`,
    )

    for (const row of metaRows) {
      const dirNorm = norm(row.directory)
      insertMap.run(dirNorm, pid, row.time_created, row.time_updated)

      const isWorktree = row.worktree !== "/" && norm(row.directory) === norm(canonicalWorktree)
      if (!isWorktree) continue

      insertRecent.run(
        `dir:${dirNorm}`,
        "project",
        pid,
        row.directory,
        row.name,
        row.icon_url ?? null,
        row.icon_color ?? null,
        row.icon_override ?? null,
        row.activity_at,
        row.time_created,
        row.time_updated,
      )
    }
  }

  export function registerUntrackedProjects(db: DrizzleClient) {
    const sqlite = db.$client

    const recentLookup = new Map<string, any>()
    const recentRows = sqlite.prepare("SELECT * FROM project_recent").all() as any[]
    for (const row of recentRows) {
      const dirNorm = norm(row.directory ?? "")
      recentLookup.set(dirNorm, row)
      const keyNorm = row.key?.replace(/^dir:/, "").toLowerCase()
      if (keyNorm && keyNorm !== dirNorm) recentLookup.set(keyNorm, row)
    }

    const chDir = channelDir()
    const existingDbIds = new Set<string>()
    const validWorktreeKeys = new Set<string>()
    const corruptedIds = new Set<string>()
    if (existsSync(chDir)) {
      const pattern = /^aether-(.+)\.db$/
      for (const entry of readdirSync(chDir)) {
        const match = pattern.exec(entry)
        if (!match) continue
        const pid = match[1]
        if (pid === "cron") continue
        existingDbIds.add(pid)
      }
    }

    // Phase 1: For each project DB, backfill directory_meta from sessions + project_recent,
    //           then sync directory_meta → global_project_map + project_recent
    //           Each project DB is handled independently — corruption in one does not block others.
    let synced = 0
    for (const pid of existingDbIds) {
      const fullPath = path.join(chDir, `aether-${pid}.db`)
      try {
        const corruption = detectCorruption(fullPath)
        if (corruption) {
          quarantine(fullPath, "project", pid)
          corruptedIds.add(pid)
          log.error("project db corrupted, quarantining", { pid, corruption })
          continue
        }

        const pSqlite = new BunSqlite(fullPath)
        let closed = false
        try {
          const projectRow = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
            | { worktree: string }
            | undefined
          const sessionCount = (pSqlite.prepare("SELECT COUNT(*) as cnt FROM session").get() as { cnt: number }).cnt
          if (!projectRow && sessionCount === 0) {
            pSqlite.close()
            closed = true
            quarantine(fullPath, "project", pid)
            corruptedIds.add(pid)
            log.info("project db has no sessions and no project row, quarantining", { pid })
            continue
          }

          ensureDirectoryMeta(pSqlite, pid, recentLookup)
          syncDirectoryMetaToGlobal(sqlite, pSqlite, pid)
          if (projectRow?.worktree && projectRow.worktree !== "/")
            validWorktreeKeys.add(`dir:${norm(projectRow.worktree)}`)

          const hasWorkspace = pSqlite
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'")
            .get()
          if (hasWorkspace) {
            const workspaceRows = pSqlite.prepare("SELECT directory FROM workspace WHERE project_id = ?").all(pid) as {
              directory: string
            }[]
            for (const ws of workspaceRows) {
              if (ws.directory) validWorktreeKeys.add(`dir:${norm(ws.directory)}`)
            }
          }

          synced++
        } finally {
          if (!closed) pSqlite.close()
        }
      } catch (err) {
        log.error("failed to process project db, quarantining", { pid, error: String(err) })
        quarantine(fullPath, "project", pid)
        corruptedIds.add(pid)
      }
    }
    if (synced > 0) log.info("directory_meta sync complete", { synced })

    // Phase 2: Delete project_recent entries whose project_id has no corresponding DB
    //          or whose directory is not the project's canonical worktree (e.g. sandbox dirs)
    //          Corrupted project DBs are also treated as "no corresponding DB" for cleanup.
    const staleRows = sqlite
      .prepare("SELECT key, project_id FROM project_recent WHERE kind = 'project' AND project_id IS NOT NULL")
      .all() as { key: string; project_id: string }[]
    let removed = 0
    for (const row of staleRows) {
      if (!existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id) || !validWorktreeKeys.has(row.key)) {
        sqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
        removed++
      }
    }
    if (removed > 0) log.info("removed stale project_recent entries", { removed })

    // Phase 3: Delete global_project_map entries whose project_id has no corresponding DB
    //          Corrupted project DBs are also cleaned from the map.
    const staleMap = sqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    let mapRemoved = 0
    for (const row of staleMap) {
      if (!existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)) {
        sqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(row.directory)
        mapRemoved++
      }
    }
    if (mapRemoved > 0) log.info("removed stale global_project_map entries", { mapRemoved })
  }

  export function transaction<T>(
    callback: (tx: TxOrDb) => NotPromise<T>,
    options?: {
      behavior?: "deferred" | "immediate" | "exclusive"
    },
  ): NotPromise<T> {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = Client().transaction(
          (tx: TxOrDb) => {
            return ctx.provide({ tx, effects }, () => callback(tx))
          },
          { behavior: options?.behavior },
        )
        for (const effect of effects) effect()
        return result as NotPromise<T>
      }
      throw err
    }
  }
}
