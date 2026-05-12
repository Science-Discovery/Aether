import { Database as BunDatabase } from "bun:sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, unlinkSync, writeFileSync, statSync } from "fs"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { init } from "#db"
import { ProjectIdentity } from "@/project/identity"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export namespace SplitMigration {
  const log = Log.create({ service: "split-migration" })

  function channel() {
    const ch = Installation.CHANNEL
    if (["latest", "beta"].includes(ch) || Flag.OPENCODE_DISABLE_CHANNEL_DB) return "latest"
    return ch.replace(/[^a-zA-Z0-9._-]/g, "-")
  }

  function channelDir() {
    return path.join(Global.Path.data, channel())
  }

  function ensureChannelDir() {
    const dir = channelDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function mainDbPath() {
    const ch = channel()
    if (ch === "latest") return path.join(Global.Path.data, "aether.db")
    return path.join(Global.Path.data, `aether-${ch}.db`)
  }

  function cronDbPath() {
    return path.join(ensureChannelDir(), `aether-cron.db`)
  }

  function projectDbPath(projectId: string) {
    return path.join(ensureChannelDir(), `aether-${projectId}.db`)
  }

  const MAX_ATTEMPTS = 5

  function destCopyPath(main: string) {
    return path.join(backupDir(), path.basename(main) + ".migration-dest")
  }

  function isLock(err: unknown) {
    return typeof err === "object" && err !== null && "code" in err && ["EBUSY", "EPERM"].includes(String(err.code))
  }

  function sleepMs(ms: number) {
    const end = Date.now() + ms
    while (Date.now() < end) {}
  }

  function retryUnlink(p: string) {
    if (!existsSync(p)) return
    for (let n = 0; n < 10; n++) {
      try {
        unlinkSync(p)
        return
      } catch (err: any) {
        if (err?.code === "ENOENT") return
        if (!isLock(err) || n >= 9) throw err
        Bun.gc(true)
        sleepMs(3000)
      }
    }
  }

  function retryCopy(src: string, dst: string) {
    for (let n = 0; n < 10; n++) {
      try {
        copyFileSync(src, dst)
        return
      } catch (err) {
        if (!isLock(err) || n >= 9) throw err
        Bun.gc(true)
        sleepMs(3000)
      }
    }
  }

  function deleteWithCompanions(p: string) {
    for (const target of [p + "-shm", p + "-wal", p]) {
      retryUnlink(target)
    }
  }

  function attemptsPath() {
    return path.join(backupDir(), path.basename(mainDbPath()) + ".migration-attempts")
  }

  function readAttempts(): number {
    const p = attemptsPath()
    if (!existsSync(p)) return 0
    return parseInt(readFileSync(p, "utf-8"), 10) || 0
  }

  function writeAttempts(n: number) {
    writeFileSync(attemptsPath(), String(n))
  }

  function removeAttempts() {
    retryUnlink(attemptsPath())
  }

  function dynamicInsert(sqlite: BunDatabase, table: string, row: Record<string, any>) {
    const targetCols = new Set(
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    )
    const cols = Object.keys(row).filter((k) => targetCols.has(k))
    const vals = cols.map((k) => row[k] ?? null)
    const placeholders = cols.map(() => "?").join(", ")
    const colList = cols.join(", ")
    sqlite.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`).run(...vals)
  }

  export type MigrationType = "initial-split" | "none"

  export function needsMigration(): MigrationType {
    const main = mainDbPath()
    if (main === ":memory:") return "none"

    if (readAttempts() >= MAX_ATTEMPTS) {
      log.error("split migration failed too many times, manual intervention required", {
        attempts: readAttempts(),
        path: attemptsPath(),
      })
      return "none"
    }

    if (!existsSync(main)) return "none"

    if (readAttempts() > 0 && existsSync(backupDbPath(main))) {
      const backup = new BunDatabase(backupDbPath(main), { readonly: true })
      try {
        const has = backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'").get()
        if (has) {
          const sessions = backup.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number } | null
          if (sessions && sessions.cnt > 0) return "initial-split"
        }
      } finally {
        backup.close()
      }
    }
    const sqlite = new BunDatabase(main, { readonly: true })
    try {
      const hasSessionTable = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
        .get()
      if (hasSessionTable) {
        const hasSessions = sqlite.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number } | null
        if (hasSessions && hasSessions.cnt > 0) {
          sqlite.close()
          return "initial-split"
        }
      }
      sqlite.close()
      deleteWithCompanions(destCopyPath(main))
      return "none"
    } catch {
      sqlite.close()
      return "none"
    }
  }

  function norm(input: string) {
    return path.resolve(input).replace(/\\/g, "/").toLowerCase()
  }

  function initDb(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const sqlite = new BunDatabase(filePath)
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA synchronous = NORMAL")
    sqlite.exec("PRAGMA busy_timeout = 5000")
    sqlite.exec("PRAGMA cache_size = -64000")
    sqlite.exec("PRAGMA foreign_keys = OFF")
    return sqlite
  }

  function getMigrationEntries(): { sql: string; timestamp: number; name: string }[] {
    if (typeof OPENCODE_MIGRATIONS !== "undefined") return OPENCODE_MIGRATIONS
    const dir = path.join(import.meta.dirname, "../../migration")
    if (!existsSync(dir)) return []
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const result = dirs.map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return undefined
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: (() => {
          const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
          if (!match) return 0
          return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])
        })(),
        name,
      }
    }) as ({ sql: string; timestamp: number; name: string } | undefined)[]
    return result
      .filter((x): x is { sql: string; timestamp: number; name: string } => x !== undefined)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  function applyMigrations(filePath: string) {
    const entries = getMigrationEntries()
    if (entries.length > 0) {
      const db = init(filePath)
      migrate(db, entries)
    }
  }

  const globalProjectMapSQL = `
    CREATE TABLE IF NOT EXISTS global_project_map (
      directory TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `

  // For project/cron dbs: seed the split migration record first so migrate()
  // won't try to run the split migration SQL (DROP TABLE etc). Then
  // applyMigrations runs all prior migrations to create tables, and
  // seedMigrationsFromDir backfills any journal records migrate() may have
  // skipped (idempotent).
  function seedSplitMigrationOnly(sqlite: BunDatabase, extra: { hash: string; millis: number; name: string }) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`)
    sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)")
      .run(extra.hash, extra.millis, extra.name, new Date().toISOString())
  }

  function seedMigrationsFromDir(sqlite: BunDatabase) {
    const existingNames = new Set(
      (sqlite.prepare("SELECT name FROM __drizzle_migrations").all() as { name: string }[]).map((r) => r.name),
    )
    const entries = getMigrationEntries()
    if (entries.length === 0) return
    const insert = sqlite.prepare(
      "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
    )
    for (const entry of entries) {
      if (existingNames.has(entry.name)) continue
      const hash = createHash("sha256").update(entry.sql).digest("hex")
      insert.run(hash, entry.timestamp, entry.name, new Date().toISOString())
    }
  }

  function appendMigrationRecord(sqlite: BunDatabase, extra: { hash: string; millis: number; name: string }) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`)
    sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)")
      .run(extra.hash, extra.millis, extra.name, new Date().toISOString())
  }

  const stripProjectRecentFK = `
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
    INSERT INTO __new_project_recent(key, kind, project_id, directory, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) SELECT key, kind, project_id, directory, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated FROM project_recent;
    DROP TABLE project_recent;
    ALTER TABLE __new_project_recent RENAME TO project_recent;
  `

  const stripSessionPreferenceFK = `
    CREATE TABLE __new_session_preference (
      session_id text PRIMARY KEY,
      agent text,
      model_provider_id text,
      model_id text,
      variant text,
      auto_accept integer,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
    INSERT INTO __new_session_preference(session_id, agent, model_provider_id, model_id, variant, auto_accept, time_created, time_updated) SELECT session_id, agent, model_provider_id, model_id, variant, auto_accept, time_created, time_updated FROM session_preference;
    DROP TABLE session_preference;
    ALTER TABLE __new_session_preference RENAME TO session_preference;
  `

  function backupDir() {
    const dir = path.join(Global.Path.data, "backup")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function backupDbPath(main: string) {
    const name = path.basename(main)
    return path.join(backupDir(), `${name}.pre-split`)
  }

  function cleanupChannelDir(attempt: number) {
    const dir = channelDir()
    if (!existsSync(dir)) return
    const attemptBackup = path.join(backupDir(), `${channel()}-attempt-${attempt}`)
    mkdirSync(attemptBackup, { recursive: true })
    const files = readdirSync(dir)
    for (const f of files) {
      if (!/\.db$/i.test(f)) continue
      const src = path.join(dir, f)
      retryCopy(src, path.join(attemptBackup, f))
      retryUnlink(src)
      for (const ext of ["-shm", "-wal"]) {
        const companion = src + ext
        if (existsSync(companion)) {
          retryCopy(companion, path.join(attemptBackup, f + ext))
          retryUnlink(companion)
        }
      }
    }
  }

  function verifySplit(
    expected: { sessions: number; messages: number; parts: number },
    projectIds: Set<string>,
  ): boolean {
    let totalSessions = 0
    let totalMessages = 0
    let totalParts = 0
    for (const pid of projectIds) {
      const pPath = projectDbPath(pid)
      if (!existsSync(pPath)) {
        log.error("verification failed: project db missing", { pid, path: pPath })
        return false
      }
      const pDb = new BunDatabase(pPath)
      totalSessions += (pDb.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number }).cnt
      totalMessages += (pDb.prepare("SELECT count(*) as cnt FROM message").get() as { cnt: number }).cnt
      totalParts += (pDb.prepare("SELECT count(*) as cnt FROM part").get() as { cnt: number }).cnt
      pDb.close()
    }

    if (totalSessions !== expected.sessions || totalMessages !== expected.messages || totalParts !== expected.parts) {
      log.error("verification failed: count mismatch", {
        expected: { sessions: expected.sessions, messages: expected.messages, parts: expected.parts },
        actual: { sessions: totalSessions, messages: totalMessages, parts: totalParts },
      })
      return false
    }
    log.info("verification passed", { sessions: totalSessions, messages: totalMessages, parts: totalParts })
    return true
  }

  export function run(): { projects: number; sessions: number } {
    const attempts = readAttempts()
    if (attempts >= MAX_ATTEMPTS) {
      throw new Error(
        `split migration failed ${MAX_ATTEMPTS} times. Delete ${attemptsPath()} to retry, or restore from ${backupDir()}`,
      )
    }

    writeAttempts(attempts + 1)

    const type = needsMigration()
    if (type === "none") {
      removeAttempts()
      return { projects: 0, sessions: 0 }
    }

    return runInitialSplit()
  }

  function runInitialSplit(): { projects: number; sessions: number } {
    const attempts = readAttempts()

    const main = mainDbPath()
    const backup = backupDbPath(main)
    const destCopy = destCopyPath(main)

    // Backup first — before any other migration operations that could fail.
    // Copy main.db + WAL/SHM companions so the backup captures all data
    // (including uncommitted WAL pages from a previous session crash).
    if (!existsSync(backup)) {
      for (const ext of ["-shm", "-wal"]) {
        if (existsSync(main + ext)) retryCopy(main + ext, backup + ext)
      }
      retryCopy(main, backup)
      log.info("backed up main db before migration", { from: main, to: backup })
      // Now checkpoint the original main.db (WAL flushed into .db, companions
      // deleted via DELETE mode) so the migration works on a clean .db file.
      // On Windows the file may still be locked by a recently-killed process,
      // so retry with EBUSY handling.
      for (let n = 0; n < 10; n++) {
        try {
          const checkpointDb = new BunDatabase(main)
          checkpointDb.exec("PRAGMA busy_timeout = 5000")
          checkpointDb.exec("PRAGMA journal_mode = DELETE")
          checkpointDb.close()
          break
        } catch (err) {
          if (!isLock(err) && n >= 9) throw err
          Bun.gc(true)
          sleepMs(3000)
        }
      }
    }

    cleanupChannelDir(attempts)
    log.info("starting per-project database split", { main, backup, destCopy, attempt: attempts + 1 })

    deleteWithCompanions(destCopy)

    let srcSqlite: BunDatabase | undefined
    let destSqlite: BunDatabase | undefined

    try {
      retryCopy(backup, destCopy)
      log.info("created destCopy from backup", { destCopy })

      srcSqlite = new BunDatabase(backup, { readonly: true })
      srcSqlite.exec("PRAGMA foreign_keys = OFF")

      const projects = srcSqlite.prepare("SELECT * FROM project").all() as any[]
      const sessions = srcSqlite.prepare("SELECT * FROM session").all() as any[]
      const messages = srcSqlite.prepare("SELECT * FROM message").all() as any[]
      const parts = srcSqlite.prepare("SELECT * FROM part").all() as any[]
      const todos = srcSqlite.prepare("SELECT * FROM todo").all() as any[]
      const permissions = srcSqlite.prepare("SELECT * FROM permission").all() as any[]
      const shares = srcSqlite.prepare("SELECT * FROM session_share").all() as any[]
      const workspaces = srcSqlite.prepare("SELECT * FROM workspace").all() as any[]
      const recentRowsSrc = (() => {
        const has = srcSqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_recent'")
          .get()
        return has ? (srcSqlite.prepare("SELECT * FROM project_recent").all() as any[]) : []
      })()
      const cronJobs = (() => {
        const has = srcSqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_job_state'")
          .get()
        return has ? (srcSqlite.prepare("SELECT * FROM cron_job_state").all() as any[]) : []
      })()
      const cronRuns = (() => {
        const has = srcSqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_run'").get()
        return has ? (srcSqlite.prepare("SELECT * FROM cron_run").all() as any[]) : []
      })()
      const preferences = (() => {
        const has = srcSqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_preference'")
          .get()
        return has ? (srcSqlite.prepare("SELECT * FROM session_preference").all() as any[]) : []
      })()

      const srcCounts = {
        sessions: (srcSqlite.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number }).cnt,
        messages: (srcSqlite.prepare("SELECT count(*) as cnt FROM message").get() as { cnt: number }).cnt,
        parts: (srcSqlite.prepare("SELECT count(*) as cnt FROM part").get() as { cnt: number }).cnt,
      }

      srcSqlite.close()
      srcSqlite = undefined

      const treeBySession = new Map(sessions.map((s) => [s.id, s.tree_id] as const))
      for (const s of sessions) {
        if (!s.parent_id || s.fork_parent_session_id) continue
        const match = / \(fork #(\d+)\)$/.exec(s.title ?? "")
        if (!match) continue
        s.fork_parent_session_id = s.parent_id
        s.fork_index = s.fork_index ?? Number(match[1])
        s.tree_id = s.tree_id ?? treeBySession.get(s.parent_id) ?? null
      }

      const sessionByProject = new Map<string, any[]>()
      const workspaceByProject = new Map<string, any[]>()
      const permissionByProject = new Map<string, any>()
      const projectByOld = new Map<string, any>()
      const oldProjectIdMap = new Map<string, string>()
      const directoryProjectMap = new Map<string, string>()
      const projectById = new Map<string, any>()

      for (const p of projects) {
        if (p.id === "global") continue
        projectByOld.set(p.id, p)
      }

      const json = (input: unknown) => {
        if (Array.isArray(input)) return input
        if (typeof input !== "string") return []
        try {
          const parsed = JSON.parse(input)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      }

      const alias = (dir: string | undefined | null, pid: string) => {
        if (!dir) return
        const key = norm(dir)
        if (!key) return
        directoryProjectMap.set(key, pid)
      }

      const mergeProject = (pid: string, info: ProjectIdentity.Info, row?: any) => {
        const prev = projectById.get(pid)
        const sandboxes = new Set<string>(json(prev?.sandboxes))
        for (const item of json(row?.sandboxes)) sandboxes.add(item)
        if (info.sandbox !== info.root) sandboxes.add(info.sandbox)
        projectById.set(pid, {
          id: pid,
          worktree: info.root,
          vcs: info.vcs ?? row?.vcs ?? prev?.vcs ?? null,
          name: prev?.name ?? row?.name ?? null,
          icon_url: prev?.icon_url ?? row?.icon_url ?? null,
          icon_color: prev?.icon_color ?? row?.icon_color ?? null,
          time_created: Math.min(prev?.time_created ?? Date.now(), row?.time_created ?? Date.now()),
          time_updated: Math.max(prev?.time_updated ?? Date.now(), row?.time_updated ?? Date.now()),
          time_initialized: prev?.time_initialized ?? row?.time_initialized ?? null,
          sandboxes: JSON.stringify([...sandboxes]),
          commands: prev?.commands ?? row?.commands ?? null,
        })
        alias(info.root, pid)
        alias(info.sandbox, pid)
      }

      const resolveProject = (s: any) => {
        const row = projectByOld.get(s.project_id)
        // For sessions with a real project_id, use the project's worktree to
        // find the git root — all sessions under the same project should share
        // one DB regardless of which worktree/subdirectory they were created in.
        // For "global" sessions, use the session's own directory.
        const dir =
          s.project_id !== "global" && row?.worktree && row.worktree !== "/"
            ? row.worktree
            : s.directory || row?.worktree || "/"
        const info = ProjectIdentity.resolve(dir)
        const pid = info.id
        if (s.project_id !== "global") oldProjectIdMap.set(s.project_id, pid)
        mergeProject(pid, info, row)
        alias(s.directory, pid)
        return pid
      }

      for (const p of projectByOld.values()) {
        const dir = p.worktree && p.worktree !== "/" ? p.worktree : p.id
        const info = ProjectIdentity.resolve(dir)
        oldProjectIdMap.set(p.id, info.id)
        mergeProject(info.id, info, p)
      }

      for (const s of sessions) {
        const pid = resolveProject(s)
        s.project_id = pid
        const bucket = sessionByProject.get(pid) ?? []
        bucket.push(s)
        sessionByProject.set(pid, bucket)
      }

      // Build per-directory metadata from project_recent for directory_meta population
      const recentByDirNorm = new Map<string, any>()
      for (const row of recentRowsSrc) {
        const key = norm(row.directory ?? "")
        if (key) recentByDirNorm.set(key, row)
      }

      // directoryMetaByProject: pid → array of {directory, worktree, name, icon_url, icon_color, icon_override, activity_at}
      type DirectoryMetaEntry = {
        directory: string
        worktree: string
        name: string | null
        icon_url: string | null
        icon_color: string | null
        icon_override: string | null
        activity_at: number
      }
      const directoryMetaByProject = new Map<string, DirectoryMetaEntry[]>()

      for (const [pid, projSessions] of sessionByProject) {
        const projRow = projectById.get(pid)
        const worktree = projRow?.worktree ?? "/"
        const seenDirs = new Set<string>()
        const entries: DirectoryMetaEntry[] = []

        const dirs = [worktree, ...projSessions.map((s) => s.directory)]
        for (const d of dirs) {
          if (!d || skipDir(d)) continue
          const dn = norm(d)
          if (seenDirs.has(dn)) continue
          seenDirs.add(dn)
          const recentRow = recentByDirNorm.get(dn)
          entries.push({
            directory: d,
            worktree,
            name: recentRow?.name ?? projRow?.name ?? null,
            icon_url: recentRow?.icon_url ?? projRow?.icon_url ?? null,
            icon_color: recentRow?.icon_color ?? projRow?.icon_color ?? null,
            icon_override: recentRow?.icon_override ?? null,
            activity_at: recentRow?.activity_at ?? Date.now(),
          })
        }
        if (entries.length > 0) directoryMetaByProject.set(pid, entries)
      }

      function skipDir(input: string) {
        if (!input) return true
        const next = norm(input)
        if (next === "/" || next === "\\") return true
        return ["/bin", "/dist", "\\bin", "\\dist"].some((item) => next.endsWith(item))
      }

      const sessionIds = new Set(sessions.map((s) => s.id))
      const messagesBySession = new Map<string, any[]>()
      for (const m of messages) {
        if (!sessionIds.has(m.session_id)) continue
        const bucket = messagesBySession.get(m.session_id) ?? []
        bucket.push(m)
        messagesBySession.set(m.session_id, bucket)
      }

      const partsByMessage = new Map<string, any[]>()
      for (const p of parts) {
        if (!sessionIds.has(p.session_id)) continue
        const bucket = partsByMessage.get(p.message_id) ?? []
        bucket.push(p)
        partsByMessage.set(p.message_id, bucket)
      }

      const todosBySession = new Map<string, any[]>()
      for (const t of todos) {
        if (!sessionIds.has(t.session_id)) continue
        const bucket = todosBySession.get(t.session_id) ?? []
        bucket.push(t)
        todosBySession.set(t.session_id, bucket)
      }

      const sharesBySession = new Map<string, any[]>()
      for (const sh of shares) {
        if (!sessionIds.has(sh.session_id)) continue
        const bucket = sharesBySession.get(sh.session_id) ?? []
        bucket.push(sh)
        sharesBySession.set(sh.session_id, bucket)
      }

      const prefsBySession = new Map<string, any[]>()
      for (const sp of preferences) {
        const bucket = prefsBySession.get(sp.session_id) ?? []
        bucket.push(sp)
        prefsBySession.set(sp.session_id, bucket)
      }

      for (const w of workspaces) {
        const pid = oldProjectIdMap.get(w.project_id) ?? directoryProjectMap.get(norm(w.project_id)) ?? w.project_id
        const bucket = workspaceByProject.get(pid) ?? []
        bucket.push({ ...w, project_id: pid })
        workspaceByProject.set(pid, bucket)
      }

      for (const p of permissions) {
        const pid = oldProjectIdMap.get(p.project_id) ?? directoryProjectMap.get(norm(p.project_id)) ?? p.project_id
        permissionByProject.set(pid, { ...p, project_id: pid })
      }

      const allProjectIds = [
        ...sessionByProject.keys(),
        ...workspaceByProject.keys(),
        ...permissionByProject.keys(),
        ...projectById.keys(),
      ]
      const uniqueProjectIds = new Set(allProjectIds)

      const migrationMeta = (() => {
        const entries = getMigrationEntries()
        const entry = entries.find((e) => e.name === "20260507071748_per_project_db_split")
        if (!entry) {
          log.error("split migration entry not found in migration entries")
          return undefined
        }
        const hash = createHash("sha256").update(entry.sql).digest("hex")
        return { hash, name: entry.name, millis: entry.timestamp }
      })()
      if (!migrationMeta) throw new Error("split migration entry is required but not found")

      let projectCount = 0
      let sessionCount = 0

      for (const projectId of uniqueProjectIds) {
        const projSessions = sessionByProject.get(projectId) ?? []
        const projWorkspaces = workspaceByProject.get(projectId) ?? []
        const projPermission = permissionByProject.get(projectId)
        if (projSessions.length === 0 && projWorkspaces.length === 0 && !projPermission) continue
        const pPath = projectDbPath(projectId)
        const pSqlite = initDb(pPath)
        seedSplitMigrationOnly(pSqlite, migrationMeta)
        applyMigrations(pPath)
        seedMigrationsFromDir(pSqlite)
        pSqlite.exec("BEGIN TRANSACTION")

        const projectRow = projectById.get(projectId)
        if (projectRow) {
          dynamicInsert(pSqlite, "project", projectRow)
        }

        for (const s of projSessions) {
          dynamicInsert(pSqlite, "session", s)
          sessionCount++
        }

        for (const s of projSessions) {
          const msgs = messagesBySession.get(s.id) ?? []
          for (const m of msgs) {
            pSqlite
              .prepare(
                "INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
              )
              .run(m.id, m.session_id, m.time_created, m.time_updated, m.data)

            const pts = partsByMessage.get(m.id) ?? []
            for (const pt of pts) {
              pSqlite
                .prepare(
                  "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .run(pt.id, pt.message_id, pt.session_id, pt.time_created, pt.time_updated, pt.data)
            }
          }

          const tds = todosBySession.get(s.id) ?? []
          for (const td of tds) {
            pSqlite
              .prepare(
                "INSERT OR IGNORE INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
              )
              .run(td.session_id, td.content, td.status, td.priority, td.position, td.time_created, td.time_updated)
          }

          const shs = sharesBySession.get(s.id) ?? []
          for (const sh of shs) {
            pSqlite
              .prepare(
                "INSERT OR IGNORE INTO session_share (session_id, id, secret, url, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(sh.session_id, sh.id, sh.secret, sh.url, sh.time_created, sh.time_updated)
          }

          const sps = prefsBySession.get(s.id) ?? []
          if (sps.length > 0) {
            const hasPref = pSqlite
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_preference'")
              .get()
            if (!hasPref) {
              pSqlite.exec(`CREATE TABLE IF NOT EXISTS session_preference (
              session_id text PRIMARY KEY,
              agent text,
              model_provider_id text,
              model_id text,
              variant text,
              auto_accept integer,
              time_created integer NOT NULL,
              time_updated integer NOT NULL
            )`)
            }
            for (const sp of sps) {
              dynamicInsert(pSqlite, "session_preference", sp)
            }
          }
        }

        if (projPermission) {
          dynamicInsert(pSqlite, "permission", projPermission)
        }

        const wss = workspaceByProject.get(projectId) ?? []
        for (const ws of wss) {
          dynamicInsert(pSqlite, "workspace", ws)
        }

        // Populate directory_meta for this project
        const metaEntries = directoryMetaByProject.get(projectId)
        if (metaEntries) {
          const hasMetaTable = pSqlite
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'")
            .get()
          if (hasMetaTable) {
            const metaInsert = pSqlite.prepare(
              "INSERT OR IGNORE INTO directory_meta (directory, worktree, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            for (const entry of metaEntries) {
              metaInsert.run(
                entry.directory,
                entry.worktree,
                entry.name,
                entry.icon_url,
                entry.icon_color,
                entry.icon_override,
                entry.activity_at,
                Date.now(),
                Date.now(),
              )
            }
          }
        }

        pSqlite.exec("COMMIT")
        pSqlite.close()
        projectCount++
      }

      log.info("created project databases", { count: projectCount })

      // Seed and migrate cron db
      const cSqlite = initDb(cronDbPath())
      seedSplitMigrationOnly(cSqlite, migrationMeta)
      applyMigrations(cronDbPath())
      seedMigrationsFromDir(cSqlite)
      cSqlite.exec("BEGIN TRANSACTION")
      for (const cj of cronJobs) {
        cSqlite
          .prepare(
            "INSERT OR IGNORE INTO cron_job_state (job_id, enabled, next_run_at, last_run_at, last_status, running, start_at, definition_snapshot, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            cj.job_id,
            cj.enabled,
            cj.next_run_at ?? null,
            cj.last_run_at ?? null,
            cj.last_status ?? null,
            cj.running,
            cj.start_at ?? null,
            cj.definition_snapshot,
            cj.updated_at,
          )
      }
      for (const cr of cronRuns) {
        cSqlite
          .prepare(
            "INSERT OR IGNORE INTO cron_run (run_id, job_id, started_at, finished_at, status, output_summary, mode, project_id, session_id, created_session_id, payload_snapshot, trigger_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            cr.run_id,
            cr.job_id,
            cr.started_at,
            cr.finished_at,
            cr.status,
            cr.output_summary ?? null,
            cr.mode,
            cr.project_id ?? null,
            cr.session_id ?? null,
            cr.created_session_id ?? null,
            cr.payload_snapshot,
            cr.trigger_reason,
          )
      }
      cSqlite.exec("COMMIT")
      cSqlite.close()
      log.info("created cron database")

      // Verify all data was correctly migrated before modifying main DB
      const verified = verifySplit(srcCounts, uniqueProjectIds)
      if (!verified) {
        throw new Error("split migration verification failed, will retry on next startup")
      }

      log.info("step: opening destCopy as destSqlite", {
        destCopy,
        exists: existsSync(destCopy),
        size: existsSync(destCopy) ? statSync(destCopy).size : -1,
      })
      destSqlite = new BunDatabase(destCopy)
      log.info("step: destSqlite opened, setting pragmas")
      destSqlite.exec("PRAGMA foreign_keys = OFF")
      destSqlite.exec("PRAGMA busy_timeout = 5000")
      log.info("step: wal_checkpoint before transaction")
      destSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      destSqlite.exec("BEGIN TRANSACTION")
      destSqlite.exec(globalProjectMapSQL)
      log.info("step: inserting directory-project mappings")
      for (const [dir, pid] of directoryProjectMap) {
        destSqlite
          .prepare(
            `INSERT INTO global_project_map (directory, project_id, time_created, time_updated)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(directory) DO UPDATE SET project_id = excluded.project_id, time_updated = excluded.time_updated`,
          )
          .run(dir, pid, Date.now(), Date.now())
      }
      log.info("step: stripping project_recent FK")
      destSqlite.exec(stripProjectRecentFK)
      const recentRows = destSqlite.prepare("SELECT key, kind, project_id, directory FROM project_recent").all() as {
        key: string
        kind: string
        project_id: string | null
        directory: string
      }[]
      for (const row of recentRows) {
        const pid =
          (row.project_id ? oldProjectIdMap.get(row.project_id) : undefined) ??
          directoryProjectMap.get(norm(row.directory ?? ""))
        if (pid && uniqueProjectIds.has(pid)) {
          destSqlite
            .prepare("UPDATE project_recent SET kind = 'project', project_id = ? WHERE key = ?")
            .run(pid, row.key)
          continue
        }
        destSqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
      }
      const hasSessionPref = destSqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_preference'")
        .get()
      if (hasSessionPref) {
        destSqlite.exec(stripSessionPreferenceFK)
      }
      log.info("step: dropping tables from destSqlite")
      destSqlite.exec("DROP TABLE IF EXISTS session")
      destSqlite.exec("DROP TABLE IF EXISTS message")
      destSqlite.exec("DROP TABLE IF EXISTS part")
      destSqlite.exec("DROP TABLE IF EXISTS todo")
      destSqlite.exec("DROP TABLE IF EXISTS permission")
      destSqlite.exec("DROP TABLE IF EXISTS session_share")
      destSqlite.exec("DROP TABLE IF EXISTS session_preference")
      destSqlite.exec("DROP TABLE IF EXISTS workspace")
      destSqlite.exec("DROP TABLE IF EXISTS project")
      destSqlite.exec("DROP TABLE IF EXISTS cron_job_state")
      destSqlite.exec("DROP TABLE IF EXISTS cron_run")
      destSqlite.exec("COMMIT")
      log.info("step: appending migration record")
      appendMigrationRecord(destSqlite, migrationMeta)
      log.info("step: seeding migration dir entries")
      seedMigrationsFromDir(destSqlite)
      log.info("step: wal_checkpoint before VACUUM")
      destSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      log.info("step: VACUUM start")
      destSqlite.exec("VACUUM")
      log.info("step: VACUUM done, checkpoint after VACUUM")
      destSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      log.info("step: closing destSqlite")
      destSqlite.close()
      destSqlite = undefined

      // Replace the main db file. copyFileSync overwrites the existing file;
      // on Windows the target may still be locked by the OS after the old
      // process was killed, so retry with EBUSY handling.
      // Delete WAL/SHM companions afterwards — same retry logic.
      retryCopy(destCopy, main)
      for (const ext of ["-shm", "-wal"]) {
        retryUnlink(main + ext)
      }
      log.info("replaced main db with migration result")

      deleteWithCompanions(destCopy)

      removeAttempts()
      log.info("split migration complete", { projects: projectCount, sessions: sessionCount })
      return { projects: projectCount, sessions: sessionCount }
    } catch (error) {
      srcSqlite?.close()
      destSqlite?.close()
      log.error("split migration failed", { error, attempt: readAttempts() })
      throw error
    }
  }
}
