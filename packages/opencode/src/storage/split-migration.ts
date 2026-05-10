import { Database as BunDatabase } from "bun:sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { Global } from "../global"
import { Log } from "../util/log"
import { Hash } from "../util/hash"
import path from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { init } from "#db"

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

  function attemptsPath() {
    return mainDbPath() + ".migration-attempts"
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
    if (existsSync(attemptsPath())) unlinkSync(attemptsPath())
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

  export type MigrationType = "initial-split" | "rehash" | "none"

  export function needsMigration(): MigrationType {
    if (readAttempts() >= MAX_ATTEMPTS) {
      log.error("split migration failed too many times, manual intervention required", {
        attempts: readAttempts(),
        path: attemptsPath(),
      })
      return "none"
    }
    const main = mainDbPath()
    if (main === ":memory:") return "none"
    if (!existsSync(main)) return "none"
    const sqlite = new BunDatabase(main)
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    try {
      // Case 1: monolithic DB still has session table → initial split needed
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
      // Case 2: already split but global_project_map has non-40-char project_ids → rehash needed
      const hasProjectMap = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='global_project_map'")
        .get()
      if (hasProjectMap) {
        const shortIds = sqlite
          .prepare("SELECT count(*) as cnt FROM global_project_map WHERE length(project_id) < 40")
          .get() as { cnt: number }
        if (shortIds.cnt > 0) {
          sqlite.close()
          return "rehash"
        }
      }
      sqlite.close()
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
    const migrationDir = path.join(import.meta.dirname, "../../migration")
    if (!existsSync(migrationDir)) return
    const dirs = readdirSync(migrationDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const insert = sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
    )
    for (const dirName of dirs) {
      if (existingNames.has(dirName)) continue
      const sqlFile = path.join(migrationDir, dirName, "migration.sql")
      if (!existsSync(sqlFile)) continue
      const sql = readFileSync(sqlFile, "utf-8")
      const hash = createHash("sha256").update(sql).digest("hex")
      const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(dirName)
      const millis = match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : 0
      insert.run(hash, millis, dirName, new Date().toISOString())
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
    const attemptBackup = path.join(backupDir(), `channel-attempt-${attempt}`)
    mkdirSync(attemptBackup, { recursive: true })
    const files = readdirSync(dir)
    for (const f of files) {
      if (!/\.db$/i.test(f)) continue
      const src = path.join(dir, f)
      copyFileSync(src, path.join(attemptBackup, f))
      unlinkSync(src)
      for (const ext of ["-shm", "-wal"]) {
        const companion = src + ext
        if (existsSync(companion)) {
          copyFileSync(companion, path.join(attemptBackup, f + ext))
          unlinkSync(companion)
        }
      }
    }
  }

  function verifySplit(srcSqlite: BunDatabase, projectIds: Set<string>): boolean {
    const srcSessions = (srcSqlite.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number }).cnt
    const srcMessages = (srcSqlite.prepare("SELECT count(*) as cnt FROM message").get() as { cnt: number }).cnt
    const srcParts = (srcSqlite.prepare("SELECT count(*) as cnt FROM part").get() as { cnt: number }).cnt

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

    if (totalSessions !== srcSessions || totalMessages !== srcMessages || totalParts !== srcParts) {
      log.error("verification failed: count mismatch", {
        expected: { sessions: srcSessions, messages: srcMessages, parts: srcParts },
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

    if (type === "initial-split") {
      return runInitialSplit()
    }

    return runRehash()
  }

  function runInitialSplit(): { projects: number; sessions: number } {
    const attempts = readAttempts()
    cleanupChannelDir(attempts)

    const main = mainDbPath()
    const backup = backupDbPath(main)
    log.info("starting per-project database split", { main, backup, attempt: attempts + 1 })

    try {
      // Prefer existing .pre-split backup if it contains original monolithic data.
      // This handles the case where a previous split partially succeeded:
      // the main DB was modified (global_project_map added, tables partially dropped)
      // but the .pre-split backup still has the original complete data.
      let srcPath = backup
      if (existsSync(backup)) {
        let testDb: BunDatabase | undefined
        try {
          testDb = new BunDatabase(backup)
          testDb.exec("PRAGMA wal_checkpoint(TRUNCATE)")
          const hasProjectTable = testDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")
            .get()
          if (hasProjectTable) {
            log.info("using existing pre-split backup as source", { path: backup })
          } else {
            srcPath = main
            log.info("pre-split backup lacks project table, will recreate from main db", { path: backup })
          }
        } catch {
          srcPath = main
          log.info("pre-split backup unreadable, will recreate from main db", { path: backup })
        } finally {
          testDb?.close()
        }
      } else {
        srcPath = main
      }

      if (srcPath === main) {
        // Backup WAL/SHM BEFORE checkpoint (checkpoint deletes these files)
        const companions = ["-shm", "-wal"]
        for (const ext of companions) {
          const srcPathComp = main + ext
          const dstPathComp = backup + ext
          if (existsSync(srcPathComp)) copyFileSync(srcPathComp, dstPathComp)
        }

        // WAL checkpoint flushes WAL data into main db file, then deletes WAL/SHM
        const checkpointDb = new BunDatabase(main)
        checkpointDb.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        checkpointDb.close()

        // After checkpoint, .db file contains all data; WAL/SHM are gone
        copyFileSync(main, backup)
        log.info("backed up main db", { from: main, to: backup })
      }

      const srcSqlite = new BunDatabase(srcPath)
      srcSqlite.exec("PRAGMA foreign_keys = OFF")

      const projects = srcSqlite.prepare("SELECT * FROM project").all() as any[]
      const sessions = srcSqlite.prepare("SELECT * FROM session").all() as any[]
      const messages = srcSqlite.prepare("SELECT * FROM message").all() as any[]
      const parts = srcSqlite.prepare("SELECT * FROM part").all() as any[]
      const todos = srcSqlite.prepare("SELECT * FROM todo").all() as any[]
      const permissions = srcSqlite.prepare("SELECT * FROM permission").all() as any[]
      const shares = srcSqlite.prepare("SELECT * FROM session_share").all() as any[]
      const workspaces = srcSqlite.prepare("SELECT * FROM workspace").all() as any[]
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

      const sessionByProject = new Map<string, any[]>()
      const globalSessionDirs = new Map<string, any[]>()
      const globalProjectIdMap = new Map<string, string>()

      for (const s of sessions) {
        if (s.project_id === "global") {
          const dir = norm(s.directory)
          const bucket = globalSessionDirs.get(dir) ?? []
          bucket.push(s)
          globalSessionDirs.set(dir, bucket)
        } else {
          const bucket = sessionByProject.get(s.project_id) ?? []
          bucket.push(s)
          sessionByProject.set(s.project_id, bucket)
        }
      }

      for (const [dir, dirSessions] of globalSessionDirs) {
        const newId = Hash.fast(dir)
        globalProjectIdMap.set(dir, newId)
        for (const s of dirSessions) {
          s.project_id = newId
        }
        sessionByProject.set(newId, dirSessions)
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

      const workspaceByProject = new Map<string, any[]>()
      for (const w of workspaces) {
        const pid = globalProjectIdMap.get(norm(w.project_id)) ?? w.project_id
        const bucket = workspaceByProject.get(pid) ?? []
        bucket.push({ ...w, project_id: pid })
        workspaceByProject.set(pid, bucket)
      }

      const projectById = new Map<string, any>()
      for (const p of projects) {
        if (p.id === "global") continue
        const pid = globalProjectIdMap.get(norm(p.id)) ?? p.id
        projectById.set(pid, { ...p, id: pid })
      }

      for (const [dir, newId] of globalProjectIdMap) {
        if (!projectById.has(newId)) {
          projectById.set(newId, {
            id: newId,
            worktree: "/",
            vcs: null,
            name: null,
            icon_url: null,
            icon_color: null,
            time_created: Date.now(),
            time_updated: Date.now(),
            time_initialized: null,
            sandboxes: "[]",
            commands: null,
          })
        }
      }

      const allProjectIds = [...sessionByProject.keys(), ...projectById.keys()]
      const uniqueProjectIds = new Set(allProjectIds)

      const migrationMeta = (() => {
        const migrationDir = path.join(import.meta.dirname, "../../migration/20260507071748_per_project_db_split")
        const sqlFile = path.join(migrationDir, "migration.sql")
        if (!existsSync(sqlFile)) return undefined
        const sql = readFileSync(sqlFile, "utf-8")
        const hash = createHash("sha256").update(sql).digest("hex")
        const name = "20260507071748_per_project_db_split"
        const millis = Date.UTC(2026, 4, 7, 7, 17, 48)
        return { hash, name, millis }
      })()

      let projectCount = 0
      let sessionCount = 0

      for (const projectId of uniqueProjectIds) {
        const projSessions = sessionByProject.get(projectId) ?? []
        const projWorkspaces = workspaceByProject.get(projectId) ?? []
        if (projSessions.length === 0 && projWorkspaces.length === 0) continue
        const pPath = projectDbPath(projectId)
        const pSqlite = initDb(pPath)
        seedSplitMigrationOnly(pSqlite, migrationMeta!)
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

        const permRow = permissions.find((p) => {
          const pid = globalProjectIdMap.get(norm(p.project_id)) ?? p.project_id
          return pid === projectId
        })
        if (permRow) {
          const pid = globalProjectIdMap.get(norm(permRow.project_id)) ?? permRow.project_id
          dynamicInsert(pSqlite, "permission", { ...permRow, project_id: pid })
        }

        const wss = workspaceByProject.get(projectId) ?? []
        for (const ws of wss) {
          dynamicInsert(pSqlite, "workspace", ws)
        }

        pSqlite.exec("COMMIT")
        pSqlite.close()
        projectCount++
      }

      log.info("created project databases", { count: projectCount })

      const dirsWithSessions = new Set<string>()
      for (const projectId of uniqueProjectIds) {
        const projSessions = sessionByProject.get(projectId) ?? []
        if (projSessions.length > 0) {
          for (const s of projSessions) {
            if (s.directory) dirsWithSessions.add(norm(s.directory))
          }
        }
      }

      // Seed and migrate cron db
      const cSqlite = initDb(cronDbPath())
      seedSplitMigrationOnly(cSqlite, migrationMeta!)
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
      const verified = verifySplit(srcSqlite, uniqueProjectIds)
      if (!verified) {
        srcSqlite.close()
        throw new Error("split migration verification failed, will retry on next startup")
      }

      const destSqlite = new BunDatabase(main)
      destSqlite.exec("PRAGMA foreign_keys = OFF")
      destSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      destSqlite.exec("BEGIN TRANSACTION")
      destSqlite.exec(globalProjectMapSQL)
      for (const [dir, newId] of globalProjectIdMap) {
        destSqlite
          .prepare(
            "INSERT OR IGNORE INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
          )
          .run(dir, newId, Date.now(), Date.now())
      }
      // Strip FKs BEFORE dropping tables (strip needs the source table to exist)
      for (const [dir, newId] of globalProjectIdMap) {
        destSqlite
          .prepare("UPDATE project_recent SET project_id = ? WHERE project_id = 'global' AND directory = ?")
          .run(newId, dir)
      }
      destSqlite.exec(stripProjectRecentFK)
      const nullRecentRows = destSqlite
        .prepare("SELECT key, directory FROM project_recent WHERE project_id IS NULL")
        .all() as { key: string; directory: string }[]
      const stillNullKeys: string[] = []
      for (const row of nullRecentRows) {
        const dirNorm = norm(row.directory ?? "")
        const newPid = globalProjectIdMap.get(dirNorm)
        if (newPid) {
          destSqlite.prepare("UPDATE project_recent SET project_id = ? WHERE key = ?").run(newPid, row.key)
        } else {
          stillNullKeys.push(row.key)
        }
      }
      if (stillNullKeys.length > 0) {
        destSqlite
          .prepare(`DELETE FROM project_recent WHERE key IN (${stillNullKeys.map(() => "?").join(",")})`)
          .run(...stillNullKeys)
        log.info("deleted project_recent entries with unresolvable null project_id", { count: stillNullKeys.length })
      }
      // Delete project_recent entries whose directory has no session in any project db
      const recentRows = destSqlite.prepare("SELECT key, directory FROM project_recent").all() as {
        key: string
        directory: string
      }[]
      const staleKeys: string[] = []
      for (const row of recentRows) {
        if (row.directory && !dirsWithSessions.has(norm(row.directory))) {
          staleKeys.push(row.key)
        }
      }
      if (staleKeys.length > 0) {
        destSqlite
          .prepare(`DELETE FROM project_recent WHERE key IN (${staleKeys.map(() => "?").join(",")})`)
          .run(...staleKeys)
        log.info("deleted stale project_recent entries", { count: staleKeys.length })
      }
      const hasSessionPref = destSqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_preference'")
        .get()
      if (hasSessionPref) {
        destSqlite.exec(stripSessionPreferenceFK)
      }
      // Now drop tables that moved to per-project/cron dbs
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
      appendMigrationRecord(destSqlite, migrationMeta!)
      seedMigrationsFromDir(destSqlite)
      destSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      destSqlite.exec("VACUUM")
      destSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      destSqlite.close()

      srcSqlite.close()

      removeAttempts()
      log.info("split migration complete", { projects: projectCount, sessions: sessionCount })
      return { projects: projectCount, sessions: sessionCount }
    } catch (error) {
      log.error("split migration failed", { error, attempt: readAttempts() })
      throw error
    }
  }

  function runRehash(): { projects: number; sessions: number } {
    const main = mainDbPath()
    const mainSqlite = new BunDatabase(main)
    mainSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    mainSqlite.exec("PRAGMA foreign_keys = OFF")

    const rows = mainSqlite
      .prepare("SELECT directory, project_id FROM global_project_map WHERE length(project_id) < 40")
      .all() as { directory: string; project_id: string }[]

    if (rows.length === 0) {
      mainSqlite.close()
      removeAttempts()
      return { projects: 0, sessions: 0 }
    }

    log.info("starting project ID rehash", { count: rows.length })

    const migrationMeta = (() => {
      const migrationDir = path.join(import.meta.dirname, "../../migration/20260507071748_per_project_db_split")
      const sqlFile = path.join(migrationDir, "migration.sql")
      if (!existsSync(sqlFile)) return undefined
      const sql = readFileSync(sqlFile, "utf-8")
      const hash = createHash("sha256").update(sql).digest("hex")
      const name = "20260507071748_per_project_db_split"
      const millis = Date.UTC(2026, 4, 7, 7, 17, 48)
      return { hash, name, millis }
    })()

    const chDir = channelDir()
    let projectCount = 0
    let sessionCount = 0

    const idMap = new Map<string, string>()

    for (const row of rows) {
      const oldId = row.project_id
      const dir = row.directory
      const newId = Hash.fast(dir)
      idMap.set(oldId, newId)

      const oldPath = path.join(chDir, `aether-${oldId}.db`)
      const newPath = path.join(chDir, `aether-${newId}.db`)

      if (!existsSync(oldPath)) {
        log.warn("old project db missing, skipping", { oldId, path: oldPath })
        continue
      }
      if (existsSync(newPath)) {
        log.info("new project db already exists, skipping", { newId, path: newPath })
        continue
      }

      // Backup old DB before reading
      const bk = path.join(backupDir(), `aether-${oldId}.db.pre-rehash`)
      copyFileSync(oldPath, bk)
      for (const ext of ["-shm", "-wal"]) {
        if (existsSync(oldPath + ext)) copyFileSync(oldPath + ext, bk + ext)
      }

      // Read all data from old DB
      const oldDb = new BunDatabase(oldPath)
      oldDb.exec("PRAGMA foreign_keys = OFF")
      const sessions = oldDb.prepare("SELECT * FROM session").all() as any[]
      const messages = oldDb.prepare("SELECT * FROM message").all() as any[]
      const parts = oldDb.prepare("SELECT * FROM part").all() as any[]
      const projects = oldDb.prepare("SELECT * FROM project").all() as any[]
      const todos = oldDb.prepare("SELECT * FROM todo").all() as any[]
      const permissions = oldDb.prepare("SELECT * FROM permission").all() as any[]
      const shares = oldDb.prepare("SELECT * FROM session_share").all() as any[]
      const workspaces = oldDb.prepare("SELECT * FROM workspace").all() as any[]
      const preferences = (() => {
        const has = oldDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_preference'")
          .get()
        return has ? (oldDb.prepare("SELECT * FROM session_preference").all() as any[]) : []
      })()

      // Collect counts for verification
      const srcSessionCount = (oldDb.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number }).cnt
      const srcMessageCount = (oldDb.prepare("SELECT count(*) as cnt FROM message").get() as { cnt: number }).cnt
      const srcPartCount = (oldDb.prepare("SELECT count(*) as cnt FROM part").get() as { cnt: number }).cnt

      oldDb.close()

      // Create new per-project DB from scratch with 40-char ID
      const pSqlite = initDb(newPath)
      seedSplitMigrationOnly(pSqlite, migrationMeta!)
      applyMigrations(newPath)
      seedMigrationsFromDir(pSqlite)
      pSqlite.exec("BEGIN TRANSACTION")

      for (const p of projects) {
        dynamicInsert(pSqlite, "project", { ...p, id: newId })
      }

      for (const s of sessions) {
        dynamicInsert(pSqlite, "session", { ...s, project_id: newId })
        sessionCount++
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
      for (const pt of parts) {
        if (!sessionIds.has(pt.session_id)) continue
        const bucket = partsByMessage.get(pt.message_id) ?? []
        bucket.push(pt)
        partsByMessage.set(pt.message_id, bucket)
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

      for (const s of sessions) {
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

      const permRow = permissions.find((p) => {
        const mapped = idMap.get(p.project_id) ?? p.project_id
        return mapped === oldId ? newId : mapped
      })
      if (permRow) {
        dynamicInsert(pSqlite, "permission", { ...permRow, project_id: newId })
      }

      for (const ws of workspaces) {
        const mappedPid = idMap.get(ws.project_id) ?? ws.project_id
        dynamicInsert(pSqlite, "workspace", { ...ws, project_id: mappedPid === oldId ? newId : mappedPid })
      }

      pSqlite.exec("COMMIT")

      // Verify new DB
      const newDb = new BunDatabase(newPath)
      const dstSessionCount = (newDb.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number }).cnt
      const dstMessageCount = (newDb.prepare("SELECT count(*) as cnt FROM message").get() as { cnt: number }).cnt
      const dstPartCount = (newDb.prepare("SELECT count(*) as cnt FROM part").get() as { cnt: number }).cnt
      newDb.close()

      if (dstSessionCount !== srcSessionCount || dstMessageCount !== srcMessageCount || dstPartCount !== srcPartCount) {
        log.error("rehash verification failed for project", {
          oldId,
          newId,
          expected: { sessions: srcSessionCount, messages: srcMessageCount, parts: srcPartCount },
          actual: { sessions: dstSessionCount, messages: dstMessageCount, parts: dstPartCount },
        })
        throw new Error(`rehash verification failed for project ${oldId} → ${newId}`)
      }

      log.info("rehashed project db", { oldId, newId, sessions: dstSessionCount })
      projectCount++
    }

    // Update main DB global_project_map and project_recent in-place
    mainSqlite.exec("BEGIN TRANSACTION")
    for (const row of rows) {
      const newId = idMap.get(row.project_id)!
      mainSqlite
        .prepare("UPDATE global_project_map SET project_id = ?, time_updated = ? WHERE directory = ?")
        .run(newId, Date.now(), row.directory)
      mainSqlite.prepare("UPDATE project_recent SET project_id = ? WHERE project_id = ?").run(newId, row.project_id)
    }
    mainSqlite.exec("COMMIT")
    mainSqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    mainSqlite.close()

    // Old 32-char per-project DB files cannot be deleted in this process (EBUSY on Windows).
    // They will be cleaned up as orphans on next startup by cleanupOrphanDbs().

    removeAttempts()
    log.info("project ID rehash complete", { projects: projectCount, sessions: sessionCount })
    return { projects: projectCount, sessions: sessionCount }
  }
}
