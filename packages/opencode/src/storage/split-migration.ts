import { Database as BunDatabase } from "bun:sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { Global } from "../global"
import { Log } from "../util/log"
import { Hash } from "../util/hash"
import path from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, unlinkSync } from "fs"
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

  export function needsMigration(): boolean {
    const dir = channelDir()
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => /\.db$/i.test(f))
      if (files.length > 0) return false
    }
    const main = mainDbPath()
    if (main === ":memory:") return false
    if (!existsSync(main)) return false
    const sqlite = new BunDatabase(main)
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    try {
      const hasProjectTable = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")
        .get()
      if (!hasProjectTable) {
        sqlite.close()
        return false
      }
      const hasSessions = sqlite.prepare("SELECT count(*) as cnt FROM session").get() as { cnt: number } | null
      if (!hasSessions || hasSessions.cnt === 0) {
        sqlite.close()
        return false
      }
      const hasProjectRows = sqlite.prepare("SELECT count(*) as cnt FROM project").get() as { cnt: number } | null
      if (!hasProjectRows || hasProjectRows.cnt === 0) {
        sqlite.close()
        return false
      }
      sqlite.close()
      return true
    } catch {
      sqlite.close()
      return false
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

  // For project/cron dbs: seed the split migration record first, then
  // seedMigrationsFromDir backfills all prior records so migrate() won't
  // re-run them on second startup.
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

  export function run(): { projects: number; sessions: number } {
    const main = mainDbPath()
    const backup = backupDbPath(main)
    log.info("starting per-project database split", { main, backup })

    // Backup WAL/SHM BEFORE checkpoint (checkpoint deletes these files)
    const companions = ["-shm", "-wal"]
    for (const ext of companions) {
      const srcPath = main + ext
      const dstPath = backup + ext
      if (existsSync(srcPath)) copyFileSync(srcPath, dstPath)
    }

    // WAL checkpoint flushes WAL data into main db file, then deletes WAL/SHM
    const checkpointDb = new BunDatabase(main)
    checkpointDb.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    checkpointDb.close()

    // After checkpoint, .db file contains all data; WAL/SHM are gone
    copyFileSync(main, backup)
    log.info("backed up main db", { from: main, to: backup })

    const srcSqlite = new BunDatabase(backup)
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
      const has = srcSqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_job_state'").get()
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
      const newId = Hash.fast(dir).slice(0, 32)
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
      seedMigrationsFromDir(pSqlite)
      applyMigrations(pPath)
      pSqlite.exec("BEGIN TRANSACTION")

      const projectRow = projectById.get(projectId)
      if (projectRow) {
        pSqlite
          .prepare(
            "INSERT OR REPLACE INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            projectRow.id,
            projectRow.worktree ?? "/",
            projectRow.vcs ?? null,
            projectRow.name ?? null,
            projectRow.icon_url ?? null,
            projectRow.icon_color ?? null,
            projectRow.time_created ?? Date.now(),
            projectRow.time_updated ?? Date.now(),
            projectRow.time_initialized ?? null,
            projectRow.sandboxes ?? "[]",
            projectRow.commands ?? null,
          )
      }

      for (const s of projSessions) {
        pSqlite
          .prepare(
            "INSERT OR IGNORE INTO session (id, project_id, workspace_id, parent_id, tree_id, fork_index, fork_parent_session_id, fork_after_user_message_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, reading_mode, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            s.id,
            s.project_id,
            s.workspace_id ?? null,
            s.parent_id ?? null,
            s.tree_id ?? null,
            s.fork_index ?? null,
            s.fork_parent_session_id ?? null,
            s.fork_after_user_message_id ?? null,
            s.slug,
            s.directory,
            s.title,
            s.version,
            s.share_url ?? null,
            s.summary_additions ?? null,
            s.summary_deletions ?? null,
            s.summary_files ?? null,
            s.summary_diffs ?? null,
            s.revert ?? null,
            s.permission ?? null,
            s.reading_mode ?? null,
            s.time_created,
            s.time_updated,
            s.time_compacting ?? null,
            s.time_archived ?? null,
          )
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
            pSqlite
              .prepare(
                "INSERT OR IGNORE INTO session_preference (session_id, agent, model_provider_id, model_id, variant, auto_accept, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                sp.session_id,
                sp.agent ?? null,
                sp.model_provider_id ?? null,
                sp.model_id ?? null,
                sp.variant ?? null,
                sp.auto_accept ?? null,
                sp.time_created,
                sp.time_updated,
              )
          }
        }
      }

      const permRow = permissions.find((p) => {
        const pid = globalProjectIdMap.get(norm(p.project_id)) ?? p.project_id
        return pid === projectId
      })
      if (permRow) {
        const pid = globalProjectIdMap.get(norm(permRow.project_id)) ?? permRow.project_id
        pSqlite
          .prepare(
            "INSERT OR IGNORE INTO permission (project_id, time_created, time_updated, data) VALUES (?, ?, ?, ?)",
          )
          .run(pid, permRow.time_created, permRow.time_updated, permRow.data)
      }

      const wss = workspaceByProject.get(projectId) ?? []
      for (const ws of wss) {
        pSqlite
          .prepare(
            "INSERT OR IGNORE INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            ws.id,
            ws.type,
            ws.branch ?? null,
            ws.name ?? null,
            ws.directory ?? null,
            ws.extra ?? null,
            ws.project_id,
          )
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
    seedMigrationsFromDir(cSqlite)
    applyMigrations(cronDbPath())
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

    log.info("split migration complete", { projects: projectCount, sessions: sessionCount })
    return { projects: projectCount, sessions: sessionCount }
  }
}
