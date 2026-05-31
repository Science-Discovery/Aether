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
import { ProjectIdentity } from "../project/identity"
import { init } from "#db"
import { Spawner } from "@/skill-evolution/spawner"
import { detectCorruption, quarantine, cleanupQuarantinedOriginals, DbRecovery } from "./db-recovery"
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
    const next = path.resolve(input).replace(/\\/g, "/")
    const result = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
    if (process.platform === "win32" && /^[A-Za-z]:/.test(result)) {
      const out = result.replace(/\//g, "\\")
      if (/^[A-Za-z]:$/.test(out)) return out + "\\"
      return out
    }
    return result
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

  export function ensureChannelDir() {
    const dir = channelDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  export function cronPath() {
    return path.join(ensureChannelDir(), `aether-cron.db`)
  }

  /**
   * Enumerate skill-evolution sub-project directories with their derived
   * projectId. Each main project's background reviews live in
   * skill-evolution/<mainProjectId>/, whose own projectId is the hash of that
   * sub-directory path (id !== folder name). This is the single source of truth
   * shared by projectPath() lookup and the directory_meta scan — purely
   * computed from the filesystem, so it survives process restarts with no
   * in-memory cache. The reserved shared/ folder (future curator) is skipped.
   */
  function evolutionSubDirs(): { id: string; dir: string }[] {
    const root = Spawner.skillEvolutionRoot()
    if (!existsSync(root)) return []
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((sub) => sub.isDirectory() && sub.name !== "shared")
        .map((sub) => {
          const dir = path.join(root, sub.name)
          return { id: String(Spawner.evolutionId(dir)), dir }
        })
    } catch {
      return []
    }
  }

  /**
   * Resolve a skill-evolution projectId to its DB path without any cached state.
   * The root project itself (hash of skill-evolution/) maps to a fixed channel
   * DB reserved for the future curator; sub-projects map to a DB inside their
   * own folder.
   */
  function skillEvolutionDbPath(projectId: string): string | undefined {
    if (projectId === String(Spawner.evolutionId(Spawner.skillEvolutionRoot()))) {
      return path.join(ensureChannelDir(), "aether-skill-evolution.db")
    }
    const match = evolutionSubDirs().find((sub) => sub.id === projectId)
    if (match) return path.join(match.dir, `aether-${projectId}.db`)
    return undefined
  }

  export function projectPath(projectId: string): string {
    return skillEvolutionDbPath(projectId) ?? path.join(ensureChannelDir(), `aether-${projectId}.db`)
  }

  /** Enumerate aether-<id>.db files in skill-evolution/<sub>/ sub-folders. */
  function skillEvolutionDbPaths(): string[] {
    return evolutionSubDirs()
      .map((sub) => path.join(sub.dir, `aether-${sub.id}.db`))
      .filter((dbPath) => existsSync(dbPath))
  }

  export function projectPaths(): string[] {
    const dir = channelDir()
    const flat: string[] = []
    if (existsSync(dir)) {
      const pattern = new RegExp(`^aether-.+\\.db$`)
      try {
        flat.push(
          ...readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && pattern.test(entry.name))
            .map((entry) => path.join(dir, entry.name)),
        )
      } catch {}
    }
    flat.push(...skillEvolutionDbPaths())
    return flat.sort()
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
    try {
      client.$client.close()
    } catch (e) {
      log.warn("failed to close project database", { projectId, error: e instanceof Error ? e.message : e })
    }
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
    ).map((r) => norm(r.directory))

    const wtNorm = norm(worktree)
    if (!directories.includes(wtNorm)) directories.push(wtNorm)

    const insert = pSqlite.prepare(
      "INSERT OR IGNORE INTO directory_meta (directory, worktree, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )

    for (const dir of directories) {
      const recentRow = recentLookup.get(dir)
      insert.run(
        dir,
        wtNorm,
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

  function gitWorktreeDirectories(worktree: string): string[] {
    if (!existsSync(worktree)) return []
    try {
      const proc = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
        cwd: worktree,
        stderr: "pipe",
        stdout: "pipe",
      })
      if (proc.exitCode !== 0) return []
      const text = proc.stdout?.toString() ?? ""
      const dirs: string[] = []
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith("worktree ")) {
          dirs.push(trimmed.slice("worktree ".length).trim())
        }
      }
      return dirs
    } catch {
      return []
    }
  }

  function validateDirectoryMeta(pSqlite: BunSqlite, pid: string, recentLookup: Map<string, any>) {
    const hasTable = pSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'")
      .get()
    if (!hasTable) return

    const projectRow = pSqlite.prepare("SELECT worktree, vcs FROM project WHERE id = ?").get(pid) as
      | { worktree: string; vcs: string | null }
      | undefined
    if (!projectRow) return

    const worktree = projectRow.worktree

    const setA = new Set<string>()
    const sessionDirs = (
      pSqlite.prepare("SELECT DISTINCT directory FROM session").all() as { directory: string }[]
    ).map((r) => r.directory)
    for (const dir of sessionDirs) setA.add(norm(dir))
    setA.add(norm(worktree))

    const setB = new Set<string>()
    if (projectRow.vcs === "git" && worktree !== "/") {
      for (const dir of gitWorktreeDirectories(worktree)) {
        setB.add(norm(dir))
      }
    }

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

    const validDirs = new Set<string>()
    for (const dir of setB) validDirs.add(dir)
    for (const dir of setA) {
      if (validDirs.has(dir) || existsSync(dir)) validDirs.add(dir)
    }
    for (const row of metaRows) {
      if (norm(row.worktree) === norm(worktree)) validDirs.add(norm(row.directory))
    }
    for (const [, row] of recentLookup) {
      if (row.project_id === pid) validDirs.add(norm(row.directory))
    }

    // Group existing rows by normalized directory to detect duplicates
    const byNorm = new Map<string, typeof metaRows>()
    for (const row of metaRows) {
      const key = norm(row.directory)
      const group = byNorm.get(key) ?? []
      group.push(row)
      byNorm.set(key, group)
    }

    let deduped = 0
    let stale = 0
    const surviving = new Map<string, (typeof metaRows)[0]>() // norm → best surviving row

    for (const [key, group] of byNorm) {
      // Not in validDirs → delete all rows in this group
      if (!validDirs.has(key)) {
        for (const row of group) {
          pSqlite.prepare("DELETE FROM directory_meta WHERE directory = ?").run(row.directory)
        }
        stale += group.length
        continue
      }
      // Multiple rows for the same norm → keep highest activity_at, delete rest
      const sorted = group.sort((a, b) => b.activity_at - a.activity_at)
      const best = sorted[0]
      surviving.set(key, best)
      for (const row of sorted.slice(1)) {
        pSqlite.prepare("DELETE FROM directory_meta WHERE directory = ?").run(row.directory)
        deduped++
      }
      const wtNorm = norm(worktree)
      // If best row's directory or worktree is not normalized, update them
      if (best.directory !== key || best.worktree !== wtNorm) {
        pSqlite
          .prepare("UPDATE directory_meta SET directory = ?, worktree = ? WHERE directory = ?")
          .run(key, wtNorm, best.directory)
      }
    }
    if (stale > 0) log.info("removed stale directory_meta entries", { pid, stale })
    if (deduped > 0) log.info("deduped directory_meta entries", { pid, deduped })

    const insert = pSqlite.prepare(
      "INSERT OR IGNORE INTO directory_meta (directory, worktree, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )

    let added = 0
    for (const dir of validDirs) {
      if (surviving.has(dir)) continue
      const recentRow = recentLookup.get(dir)
      insert.run(
        dir,
        norm(worktree),
        recentRow?.name ?? null,
        recentRow?.icon_url ?? null,
        recentRow?.icon_color ?? null,
        recentRow?.icon_override ?? null,
        recentRow?.activity_at ?? Date.now(),
        Date.now(),
        Date.now(),
      )
      added++
    }
    if (added > 0) log.info("added missing directory_meta entries", { pid, added })
  }

  function syncProjectSandboxes(pSqlite: BunSqlite, pid: string) {
    const hasTable = pSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'")
      .get()
    if (!hasTable) return

    const projectRow = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
      | { worktree: string }
      | undefined
    if (!projectRow) return

    const worktree = norm(projectRow.worktree)
    const metaRows = pSqlite.prepare("SELECT directory FROM directory_meta").all() as { directory: string }[]
    const sandboxes = metaRows.filter((r) => norm(r.directory) !== worktree).map((r) => r.directory)
    pSqlite
      .prepare("UPDATE project SET sandboxes = ?, time_updated = ? WHERE id = ?")
      .run(JSON.stringify(sandboxes), Date.now(), pid)
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

    // Derive real activity time per directory from sessions
    const sessionActivity = new Map<string, number>()
    const sessionRows = pSqlite
      .prepare("SELECT directory, MAX(time_updated) as latest FROM session GROUP BY directory")
      .all() as { directory: string; latest: number }[]
    for (const s of sessionRows) sessionActivity.set(norm(s.directory), s.latest)

    // Also pick up icon from ProjectTable as authoritative source
    const projectIcon = pSqlite.prepare("SELECT icon_url, icon_color FROM project WHERE id = ?").get(pid) as
      | { icon_url: string | null; icon_color: string | null }
      | undefined

    const insertMap = sqlite.prepare(
      `INSERT INTO global_project_map (directory, project_id, time_created, time_updated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(directory) DO UPDATE SET project_id = excluded.project_id, time_updated = excluded.time_updated`,
    )
    const insertRecent = sqlite.prepare(
      `INSERT INTO project_recent (key, kind, project_id, directory, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id, directory = excluded.directory, name = excluded.name, icon_url = excluded.icon_url, icon_color = excluded.icon_color, icon_override = excluded.icon_override, activity_at = excluded.activity_at, time_updated = excluded.time_updated`,
    )

    const validNorms = new Set<string>()
    for (const row of metaRows) validNorms.add(norm(row.directory))

    for (const row of metaRows) {
      const dirNorm = norm(row.directory)
      const realActivity = sessionActivity.get(dirNorm) ?? row.activity_at
      const isWorktree = row.worktree !== "/" && norm(row.directory) === norm(canonicalWorktree)
      const icon_url = isWorktree ? (projectIcon?.icon_url ?? row.icon_url ?? null) : (row.icon_url ?? null)
      const icon_color = isWorktree ? (projectIcon?.icon_color ?? row.icon_color ?? null) : (row.icon_color ?? null)

      insertMap.run(dirNorm, pid, row.time_created, row.time_updated)

      const kind = isWorktree ? "project" : "directory"

      insertRecent.run(
        `dir:${dirNorm}`,
        kind,
        pid,
        row.directory,
        row.name,
        icon_url,
        icon_color,
        row.icon_override ?? null,
        realActivity,
        row.time_created,
        row.time_updated,
      )
    }

    // Clean global_project_map entries for this pid whose normed directory is
    // no longer in directory_meta (e.g. sandbox removed but path-norm mismatch
    // caused the DELETE to miss). Only compare by pid + norm to handle
    // backslash/forward-slash inconsistencies.
    const orphanMap = sqlite.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").all(pid) as {
      directory: string
    }[]
    for (const orphan of orphanMap) {
      if (!validNorms.has(norm(orphan.directory))) {
        sqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(orphan.directory)
      }
    }
  }

  export function registerUntrackedProjects(db: DrizzleClient) {
    const sqlite = db.$client

    cleanupQuarantinedOriginals()

    const recentLookup = new Map<string, any>()
    const recentRows = sqlite.prepare("SELECT * FROM project_recent").all() as any[]
    for (const row of recentRows) {
      const dirNorm = norm(row.directory ?? "")
      recentLookup.set(dirNorm, row)
      const keyNorm = row.key?.replace(/^dir:/, "")
      if (keyNorm && norm(keyNorm) !== dirNorm) recentLookup.set(keyNorm, row)
    }

    const chDir = channelDir()
    /** Map pid → absolute DB file path. Includes channel-dir DBs plus
     *  skill-evolution sub-project DBs so directory_meta sync covers all of them. */
    const existingDbIds = new Map<string, string>()
    const validWorktreeKeys = new Set<string>()
    const corruptedIds = new Set<string>()
    if (existsSync(chDir)) {
      const pattern = /^aether-(.+)\.db$/
      for (const entry of readdirSync(chDir)) {
        const match = pattern.exec(entry)
        if (!match) continue
        const pid = match[1]
        if (pid === "cron" || pid === "memory" || pid === "skill" || pid === "skill-evolution") continue
        existingDbIds.set(pid, path.join(chDir, entry))
      }
    }
    for (const sub of evolutionSubDirs()) {
      const dbPath = path.join(sub.dir, `aether-${sub.id}.db`)
      if (existsSync(dbPath)) existingDbIds.set(sub.id, dbPath)
    }

    // Phase 1: For each project DB, backfill directory_meta from sessions + project_recent,
    //           then sync directory_meta → global_project_map + project_recent
    //           Each project DB is handled independently — corruption in one does not block others.
    let synced = 0
    for (const [pid, fullPath] of existingDbIds) {
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
          validateDirectoryMeta(pSqlite, pid, recentLookup)
          syncProjectSandboxes(pSqlite, pid)
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
          if (!closed) {
            pSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
            pSqlite.close()
          }
        }
      } catch (err) {
        log.error("failed to process project db, quarantining", { pid, error: String(err) })
        quarantine(fullPath, "project", pid)
        corruptedIds.add(pid)
      }
    }
    if (synced > 0) log.info("directory_meta sync complete", { synced })

    // Phase 2: Delete project_recent entries whose project_id has no corresponding DB
    //          Covers both kind='project' (worktree) and kind='directory' (sandbox) rows.
    //          For kind='project', also remove if key is not a valid worktree key.
    //          Corrupted project DBs are also treated as "no corresponding DB" for cleanup.
    const staleRows = sqlite
      .prepare("SELECT key, kind, project_id FROM project_recent WHERE project_id IS NOT NULL")
      .all() as { key: string; kind: string; project_id: string }[]
    let removed = 0
    for (const row of staleRows) {
      const noDb = !existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)
      const invalidWorktree = row.kind === "project" && !validWorktreeKeys.has(row.key)
      if (noDb || invalidWorktree) {
        sqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
        removed++
      }
    }
    if (removed > 0) log.info("removed stale project_recent entries", { removed })

    // Phase 3: Delete global_project_map entries whose project_id has no corresponding DB
    //          Corrupted project DBs are also cleaned from the map.
    //          Also deduplicate entries where norm(directory) differs from the stored value,
    //          keeping only the normed row (the canonical one written by syncDirectoryMetaToGlobal).
    const staleMap = sqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    let mapRemoved = 0
    const seenNorms = new Map<string, string>() // norm(directory) → the kept row's raw directory
    for (const row of staleMap) {
      const noDb = !existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)
      if (noDb) {
        sqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(row.directory)
        mapRemoved++
        continue
      }
      const dirNorm = norm(row.directory)
      const prev = seenNorms.get(dirNorm)
      if (!prev) {
        seenNorms.set(dirNorm, row.directory)
        continue
      }
      // Two rows map to the same normed directory — keep the normed one (matches project_recent key)
      // and delete the other. The normed path is the canonical form used by syncDirectoryMetaToGlobal.
      const keepNormed = dirNorm === row.directory
      const delDir = keepNormed ? prev : row.directory
      sqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(delDir)
      if (keepNormed) seenNorms.set(dirNorm, row.directory)
      mapRemoved++
    }
    if (mapRemoved > 0) log.info("removed stale/duplicate global_project_map entries", { mapRemoved })

    // Phase 4: Verify global_project_map + project_recent against
    //          ProjectIdentity.resolve. Collect all directory paths from
    //          both tables, resolve each, and fix stale project_id references
    //          caused by norm/hash algorithm changes. Three outcomes per entry:
    //          (a) resolve agrees with current project_id → skip
    //          (b) resolve disagrees, correct DB exists → update both tables
    //          (c) resolve disagrees, neither DB exists → delete both entries
    //          (d) resolve disagrees, only old DB exists → keep old (backward compat)
    const mapRows = sqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    const recentPidRows = sqlite
      .prepare("SELECT key, directory, project_id, kind FROM project_recent WHERE project_id IS NOT NULL")
      .all() as { key: string; directory: string; project_id: string; kind: string }[]
    const mapPidByDir = new Map<string, string>()
    for (const row of mapRows) mapPidByDir.set(row.directory, row.project_id)
    const updateMap = sqlite.prepare(
      "UPDATE global_project_map SET project_id = ?, time_updated = ? WHERE directory = ?",
    )
    const deleteMap = sqlite.prepare("DELETE FROM global_project_map WHERE directory = ?")
    const updateRecent = sqlite.prepare(
      "UPDATE project_recent SET project_id = ?, kind = ?, time_updated = ? WHERE key = ?",
    )
    const deleteRecent = sqlite.prepare("DELETE FROM project_recent WHERE key = ?")

    let mapCorrected = 0
    let recentCorrected = 0

    const fixEntry = (directory: string, oldPid: string, fixRecentOnly: boolean) => {
      const resolved = ProjectIdentity.resolve(directory)
      if (oldPid === resolved.id) return false
      const resolvedDbExists = existingDbIds.has(resolved.id)
      const mappedDbExists = existingDbIds.has(oldPid) && !corruptedIds.has(oldPid)
      const key = `dir:${norm(directory)}`
      const kind = resolved.vcs === "git" ? "project" : "directory"
      if (resolvedDbExists) {
        if (!fixRecentOnly) {
          updateMap.run(resolved.id, Date.now(), directory)
          mapCorrected++
        }
        updateRecent.run(resolved.id, kind, Date.now(), key)
        recentCorrected++
      } else if (!mappedDbExists) {
        if (!fixRecentOnly) {
          deleteMap.run(directory)
          mapCorrected++
        }
        deleteRecent.run(key)
        recentCorrected++
      }
      return true
    }

    for (const row of mapRows) fixEntry(row.directory, row.project_id, false)
    for (const row of recentPidRows) {
      const mapPid = mapPidByDir.get(row.directory)
      if (mapPid && mapPid !== row.project_id) fixEntry(row.directory, row.project_id, true)
    }
    if (mapCorrected > 0) log.info("corrected stale global_project_map entries", { mapCorrected })
    if (recentCorrected > 0) log.info("corrected stale project_recent entries", { recentCorrected })
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
