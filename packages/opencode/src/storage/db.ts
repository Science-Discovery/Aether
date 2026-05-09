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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "fs"
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

      rehashProjectIds(db)
      cleanupEmptyProjects(db)

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
    if (cronClient) {
      cronClient.$client.close()
      cronClient = undefined
    }
  }

  type DrizzleClient = ReturnType<typeof init>

  let cronClient: DrizzleClient | undefined

  export const CronClient = lazy(() => {
    const p = cronPath()
    log.info("opening cron database", { path: p })
    const db = init(p)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    seedSplitMigration(db)
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
    seedSplitMigration(db)
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

  export function rehashProjectIds(db: DrizzleClient) {
    const sqlite = db.$client
    const rows = sqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    const toRehash = rows.filter((r) => r.project_id.length === 16)
    if (toRehash.length === 0) return

    const chDir = channelDir()
    for (const row of toRehash) {
      const oldId = row.project_id
      const newId = createHash("sha1").update(row.directory).digest("hex").slice(0, 32)

      const oldPath = path.join(chDir, `aether-${oldId}.db`)
      const newPath = path.join(chDir, `aether-${newId}.db`)
      if (existsSync(oldPath) && !existsSync(newPath)) {
        const pDb = new BunSqlite(oldPath)
        pDb.prepare("UPDATE project SET id = ? WHERE id = ?").run(newId, oldId)
        pDb.prepare("UPDATE session SET project_id = ? WHERE project_id = ?").run(newId, oldId)
        pDb.prepare("UPDATE workspace SET project_id = ? WHERE project_id = ?").run(newId, oldId)
        pDb.prepare("UPDATE permission SET project_id = ? WHERE project_id = ?").run(newId, oldId)
        pDb.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        pDb.close()

        renameSync(oldPath, newPath)
        for (const ext of ["-shm", "-wal"]) {
          if (existsSync(oldPath + ext)) renameSync(oldPath + ext, newPath + ext)
        }
      } else if (!existsSync(oldPath) && existsSync(newPath)) {
      }

      if (existsSync(oldPath) && oldId.length === 16) {
        unlinkSync(oldPath)
        for (const ext of ["-shm", "-wal"]) {
          if (existsSync(oldPath + ext)) unlinkSync(oldPath + ext)
        }
        log.info("deleted stale 16-char project db", { oldId })
      }

      sqlite.prepare("UPDATE global_project_map SET project_id = ? WHERE directory = ?").run(newId, row.directory)
      sqlite.prepare("UPDATE project_recent SET project_id = ? WHERE project_id = ?").run(newId, oldId)

      const dirNorm = norm(row.directory)
      const recentKey = `dir:${dirNorm}`
      const hasRecent = sqlite.prepare("SELECT 1 FROM project_recent WHERE key = ?").get(recentKey)
      if (!hasRecent) {
        const now = Date.now()
        sqlite
          .prepare(
            "INSERT OR IGNORE INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(recentKey, "directory", newId, row.directory, now, now, now)
        log.info("inserted missing project_recent entry", { directory: row.directory, newId })
      }

      log.info("rehashed non-git project ID", { directory: row.directory, oldId, newId })
    }

    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    log.info("rehashed non-git project IDs to 32-char", { count: toRehash.length })
  }

  export function cleanupEmptyProjects(db: DrizzleClient) {
    const sqlite = db.$client
    const chDir = channelDir()
    if (!existsSync(chDir)) return

    const pattern = /^aether-([0-9a-f]+)\.db$/
    const files = readdirSync(chDir, { withFileTypes: true }).filter((e) => e.isFile() && pattern.test(e.name))

    const dirsWithSessions = new Set<string>()
    const emptyProjectIds: string[] = []
    for (const entry of files) {
      const match = pattern.exec(entry.name)
      if (!match) continue
      const pid = match[1]
      if (projectClients.has(pid)) {
        dirsWithSessions.add(pid)
        continue
      }
      const pPath = path.join(chDir, entry.name)
      const pDb = new BunSqlite(pPath)
      pDb.exec("PRAGMA journal_mode = WAL")
      pDb.exec("PRAGMA foreign_keys = ON")
      const cnt = (pDb.prepare("SELECT count(*) as cnt FROM session").get() as any).cnt
      if (cnt > 0) {
        dirsWithSessions.add(pid)
        const projRow = pDb.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as any
        if (projRow?.worktree) dirsWithSessions.add(norm(projRow.worktree))
        const sessRows = pDb.prepare("SELECT directory FROM session").all() as any[]
        for (const s of sessRows) {
          if (s.directory) dirsWithSessions.add(norm(s.directory))
        }
      } else {
        emptyProjectIds.push(pid)
      }
      pDb.exec("PRAGMA wal_checkpoint(PASSIVE)")
      pDb.close()
    }

    // Delete empty project db files and remove corresponding project_recent entries
    for (const pid of emptyProjectIds) {
      const pPath = path.join(chDir, `aether-${pid}.db`)
      sqlite.prepare("DELETE FROM project_recent WHERE project_id = ?").run(pid)
      sqlite.prepare("DELETE FROM global_project_map WHERE project_id = ?").run(pid)
      unlinkSync(pPath)
      for (const ext of ["-shm", "-wal"]) {
        if (existsSync(pPath + ext)) unlinkSync(pPath + ext)
      }
      log.info("deleted empty project db and removed stale references", { pid })
    }
    if (emptyProjectIds.length > 0) {
      log.info("cleaned up empty project databases", { count: emptyProjectIds.length })
    }

    // Remove project_recent entries whose project_id has no project db on disk
    const projectRecentRows = sqlite
      .prepare("SELECT key, project_id FROM project_recent WHERE kind = 'project' AND project_id IS NOT NULL")
      .all() as { key: string; project_id: string }[]
    const staleRecentKeys: string[] = []
    for (const row of projectRecentRows) {
      if (dirsWithSessions.has(row.project_id)) continue
      if (existsSync(path.join(chDir, `aether-${row.project_id}.db`))) continue
      staleRecentKeys.push(row.key)
    }
    if (staleRecentKeys.length > 0) {
      sqlite
        .prepare(`DELETE FROM project_recent WHERE key IN (${staleRecentKeys.map(() => "?").join(",")})`)
        .run(...staleRecentKeys)
      log.info("removed project_recent entries pointing to non-existent project dbs", { count: staleRecentKeys.length })
    }

    const nullRows = sqlite
      .prepare("SELECT key, directory FROM project_recent WHERE project_id IS NULL")
      .all() as unknown as {
      key: string
      directory: string
    }[]
    const gpmLookup = new Map(
      (
        sqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
          directory: string
          project_id: string
        }[]
      ).map((r) => [norm(r.directory), r.project_id]),
    )
    let patched = 0
    for (const row of nullRows) {
      const dirNorm = norm(row.directory ?? "")
      const pid = gpmLookup.get(dirNorm)
      if (pid) {
        sqlite.prepare("UPDATE project_recent SET project_id = ? WHERE key = ?").run(pid, row.key)
        patched++
      }
    }
    if (patched > 0) log.info("patched null project_id in project_recent from global_project_map", { patched })

    const gpmRows = sqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    const existingKeys = new Set(
      (sqlite.prepare("SELECT key FROM project_recent").all() as { key: string }[]).map((r) => r.key),
    )
    const now = Date.now()
    let seeded = 0
    for (const gpm of gpmRows) {
      const dirNorm = norm(gpm.directory)
      const key = `dir:${dirNorm}`
      if (existingKeys.has(key)) continue
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(key, "directory", gpm.project_id, gpm.directory, now, now, now)
      seeded++
    }
    if (seeded > 0) log.info("seeded missing project_recent entries from global_project_map", { seeded })

    // --- Case-duplicate merge in global_project_map ---
    const gpmAll = sqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    const byNorm = new Map<string, { directory: string; project_id: string }[]>()
    for (const row of gpmAll) {
      const nk = norm(row.directory)
      const group = byNorm.get(nk) ?? []
      group.push(row)
      byNorm.set(nk, group)
    }

    let mergedGpm = 0
    for (const [nk, group] of byNorm) {
      if (group.length <= 1) {
        const row = group[0]
        if (row.directory !== nk) {
          sqlite.prepare("UPDATE global_project_map SET directory = ? WHERE directory = ?").run(nk, row.directory)
          mergedGpm++
        }
        continue
      }

      let winnerIdx = 0
      let maxSessions = 0
      for (let i = 0; i < group.length; i++) {
        const pid = group[i].project_id
        if (projectClients.has(pid)) {
          if (maxSessions === 0) {
            winnerIdx = i
            maxSessions = 1
          }
          continue
        }
        const pPath = path.join(chDir, `aether-${pid}.db`)
        if (!existsSync(pPath)) continue
        try {
          const pDb = new BunSqlite(pPath)
          const cnt = (pDb.prepare("SELECT count(*) as cnt FROM session").get() as any).cnt
          pDb.close()
          if (cnt > maxSessions) {
            maxSessions = cnt
            winnerIdx = i
          }
        } catch {
          /* ignore */
        }
      }

      const winnerPid = group[winnerIdx].project_id
      if (group[winnerIdx].directory !== nk) {
        sqlite
          .prepare("UPDATE global_project_map SET directory = ? WHERE directory = ?")
          .run(nk, group[winnerIdx].directory)
      }

      for (let i = 0; i < group.length; i++) {
        if (i === winnerIdx) continue
        const loserPid = group[i].project_id
        sqlite.prepare("UPDATE project_recent SET project_id = ? WHERE project_id = ?").run(winnerPid, loserPid)
        sqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(group[i].directory)

        const loserDbPath = path.join(chDir, `aether-${loserPid}.db`)
        if (existsSync(loserDbPath) && !projectClients.has(loserPid)) {
          try {
            const loserDb = new BunSqlite(loserDbPath)
            const cnt = (loserDb.prepare("SELECT count(*) as cnt FROM session").get() as any).cnt
            loserDb.close()
            if (cnt === 0) {
              unlinkSync(loserDbPath)
              for (const ext of ["-shm", "-wal"]) {
                if (existsSync(loserDbPath + ext)) unlinkSync(loserDbPath + ext)
              }
              log.info("deleted empty case-duplicate project db", { loserPid, directory: group[i].directory })
            }
          } catch {
            /* ignore */
          }
        }
        mergedGpm++
        log.info("merged case-duplicate global_project_map entry", {
          loserDirectory: group[i].directory,
          loserPid,
          winnerDirectory: nk,
          winnerPid,
        })
      }
    }
    if (mergedGpm > 0) log.info("merged case-duplicate global_project_map entries", { mergedGpm })

    // --- Normalize project_recent keys ---
    const allRecentRows = sqlite
      .prepare(
        "SELECT key, kind, directory, project_id, name, icon_url, icon_color, icon_override, activity_at FROM project_recent",
      )
      .all() as {
      key: string
      kind: string
      directory: string
      project_id: string | null
      name: string | null
      icon_url: string | null
      icon_color: string | null
      icon_override: string | null
      activity_at: number
    }[]

    // Group by norm(directory) — entries with same directory but different key casing are duplicates
    const byNormDir = new Map<string, typeof allRecentRows>()
    for (const row of allRecentRows) {
      if (!row.directory) continue
      const nk = norm(row.directory)
      const group = byNormDir.get(nk) ?? []
      group.push(row)
      byNormDir.set(nk, group)
    }

    let normalizedKeys = 0
    for (const [nk, group] of byNormDir) {
      const expectedKey = `dir:${nk}`
      // Find entries that already have the canonical lowercase key
      const canonical = group.find((r) => r.key === expectedKey)
      for (const row of group) {
        if (row.key === expectedKey) continue
        // This entry has a non-canonical key (mixed case or legacy format)
        if (canonical) {
          // Merge metadata from this entry into the canonical one
          if (!canonical.name && row.name) {
            sqlite.prepare("UPDATE project_recent SET name = ? WHERE key = ?").run(row.name, expectedKey)
          }
          if (!canonical.icon_url && row.icon_url) {
            sqlite.prepare("UPDATE project_recent SET icon_url = ? WHERE key = ?").run(row.icon_url, expectedKey)
          }
          if (!canonical.icon_color && row.icon_color) {
            sqlite.prepare("UPDATE project_recent SET icon_color = ? WHERE key = ?").run(row.icon_color, expectedKey)
          }
          if (!canonical.icon_override && row.icon_override) {
            sqlite
              .prepare("UPDATE project_recent SET icon_override = ? WHERE key = ?")
              .run(row.icon_override, expectedKey)
          }
          if (!canonical.project_id && row.project_id) {
            sqlite
              .prepare("UPDATE project_recent SET project_id = ?, kind = ? WHERE key = ?")
              .run(row.project_id, row.kind, expectedKey)
          }
          if (row.activity_at > canonical.activity_at) {
            sqlite.prepare("UPDATE project_recent SET activity_at = ? WHERE key = ?").run(row.activity_at, expectedKey)
          }
          sqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
        } else {
          // No canonical entry yet — rename this one
          sqlite.prepare("UPDATE project_recent SET key = ?, directory = ? WHERE key = ?").run(expectedKey, nk, row.key)
        }
        normalizedKeys++
      }
    }

    // Delete legacy 'project:<id>' format entries if a 'dir:' entry exists for same project_id
    const legacyRows = sqlite
      .prepare("SELECT key, project_id FROM project_recent WHERE key LIKE 'project:%' AND project_id IS NOT NULL")
      .all() as { key: string; project_id: string }[]
    for (const lr of legacyRows) {
      const hasDir = sqlite
        .prepare("SELECT 1 FROM project_recent WHERE project_id = ? AND key LIKE 'dir:%'")
        .get(lr.project_id)
      if (hasDir) {
        sqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(lr.key)
        normalizedKeys++
      }
    }

    if (normalizedKeys > 0) log.info("normalized project_recent keys", { normalizedKeys })
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
