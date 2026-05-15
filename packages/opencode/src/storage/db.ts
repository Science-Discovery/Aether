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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "fs"
import { Database as BunSqlite } from "bun:sqlite"

import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { init } from "#db"

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
      const db = init(Path)

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

  export function attach(projectId: string): DrizzleClient {
    const existing = projectClients.get(projectId)
    if (existing) return existing
    const p = projectPath(projectId)
    log.info("opening project database", { projectId, path: p })
    const db = init(p)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    const isNewProjDb = seedSplitMigration(db)
    if (!isNewProjDb) seedAllMigrations(db)
    applyMigrations(db)
    db.run("PRAGMA wal_checkpoint(PASSIVE)")
    projectClients.set(projectId, db)
    return db
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

  export function registerUntrackedProjects(db: DrizzleClient) {
    const sqlite = db.$client
    const trackedIds = new Set<string>()
    const rows = sqlite.prepare("SELECT project_id FROM global_project_map").all() as { project_id: string }[]
    for (const r of rows) trackedIds.add(r.project_id)

    const chDir = channelDir()
    const existingDbIds = new Set<string>()
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

    // Register untracked project DBs into global_project_map
    let registered = 0
    for (const pid of existingDbIds) {
      if (trackedIds.has(pid)) continue
      const fullPath = path.join(chDir, `aether-${pid}.db`)
      const pSqlite = new BunSqlite(fullPath)
      const projectRow = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
        | { worktree: string }
        | undefined
      if (projectRow) {
        const dir = norm(projectRow.worktree)
        sqlite
          .prepare(
            "INSERT OR IGNORE INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
          )
          .run(dir, pid, Date.now(), Date.now())
        registered++
        log.info("registered untracked project db", { pid, directory: dir })
      }
      pSqlite.close()
    }
    if (registered > 0) log.info("untracked project registration complete", { registered })

    // Delete project_recent entries whose project_id has no corresponding DB
    const recentRows = sqlite
      .prepare("SELECT key, project_id FROM project_recent WHERE kind = 'project' AND project_id IS NOT NULL")
      .all() as { key: string; project_id: string }[]
    let removed = 0
    for (const row of recentRows) {
      if (!existingDbIds.has(row.project_id)) {
        sqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
        removed++
      }
    }
    if (removed > 0) log.info("removed project_recent entries without project db", { removed })

    // Create project_recent entries for project DBs not yet in project_recent
    const recentProjectIds = new Set(
      (
        sqlite
          .prepare("SELECT project_id FROM project_recent WHERE kind = 'project' AND project_id IS NOT NULL")
          .all() as { project_id: string }[]
      ).map((r) => r.project_id),
    )
    let created = 0
    for (const pid of existingDbIds) {
      if (recentProjectIds.has(pid)) continue
      const mapRow = sqlite.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(pid) as
        | { directory: string }
        | undefined
      const directory = mapRow?.directory ?? ""
      if (!directory) continue
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(`dir:${norm(directory)}`, "project", pid, directory, Date.now(), Date.now(), Date.now())
      created++
      log.info("created project_recent for untracked project db", { pid, directory })
    }
    if (created > 0) log.info("project_recent creation complete", { created })

    // Delete tracked project DBs with 0 sessions (no user data to lose)
    let deleted = 0
    for (const row of rows) {
      const pid = row.project_id
      if (!existingDbIds.has(pid)) continue
      const fullPath = path.join(chDir, `aether-${pid}.db`)
      const pSqlite = new BunSqlite(fullPath)
      const sessionCount = (pSqlite.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number }).cnt
      pSqlite.close()
      if (sessionCount > 0) continue
      rmSync(fullPath, { force: true, maxRetries: 5, retryDelay: 100 })
      for (const ext of ["-shm", "-wal"]) {
        rmSync(path.join(chDir, `aether-${pid}.db${ext}`), { force: true })
      }
      sqlite.prepare("DELETE FROM global_project_map WHERE project_id = ?").run(pid)
      sqlite.prepare("DELETE FROM project_recent WHERE project_id = ? AND kind = 'project'").run(pid)
      deleted++
      log.info("deleted tracked empty project db", { pid })
    }
    if (deleted > 0) log.info("tracked empty db cleanup complete", { deleted })
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
