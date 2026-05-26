import { mkdirSync } from "fs"
import path from "path"
import { Database as BunSqlite } from "bun:sqlite"
import { ulid } from "ulid"
import { Global } from "@/global"

let db: BunSqlite | null = null

function dbPath() {
  return path.join(Global.Path.data, "latest", "aether-skill-evolution.db")
}

function initDb(sqlite: BunSqlite) {
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = NORMAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec(`CREATE TABLE IF NOT EXISTS evolution_run (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    model TEXT,
    tool_calls_json TEXT,
    result_summary TEXT,
    error TEXT
  )`)
  sqlite.exec("CREATE INDEX IF NOT EXISTS evolution_run_project_idx ON evolution_run(project_id)")
  sqlite.exec("CREATE INDEX IF NOT EXISTS evolution_run_started_idx ON evolution_run(started_at)")
  sqlite.exec("CREATE TABLE IF NOT EXISTS evolution_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  return sqlite
}

function openDb() {
  if (db) return db
  mkdirSync(path.dirname(dbPath()), { recursive: true })
  const sqlite = initDb(new BunSqlite(dbPath(), { create: true }))
  db = sqlite
  return sqlite
}

export namespace EvolutionDb {
  export function insertRun(input: {
    projectId: string
    folderName: string
    sourceSessionId: string
    model?: string
  }): string {
    const id = `evo_${ulid()}`
    const sqlite = openDb()
    sqlite
      .prepare(
        "INSERT INTO evolution_run (id, project_id, folder_name, source_session_id, started_at, model) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.projectId, input.folderName, input.sourceSessionId, Date.now(), input.model ?? null)
    return id
  }

  export function completeRun(
    id: string,
    result: {
      toolCallsJson?: string
      resultSummary?: string
      error?: string
    },
  ) {
    const sqlite = openDb()
    sqlite
      .prepare(
        "UPDATE evolution_run SET completed_at = ?, tool_calls_json = ?, result_summary = ?, error = ? WHERE id = ?",
      )
      .run(Date.now(), result.toolCallsJson ?? null, result.resultSummary ?? null, result.error ?? null, id)
  }

  export function close() {
    if (db) {
      db.close()
      db = null
    }
  }
}
