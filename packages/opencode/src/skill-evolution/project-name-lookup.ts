import { Database as BunSqlite } from "bun:sqlite"
import { existsSync } from "fs"
import { Database } from "@/storage/db"

/**
 * Read a project's worktree (its real on-disk directory) from a per-project
 * SQLite file, read-only and side-effect-free.
 *
 * Deliberately NOT via Database.useProject/attach: those open the project for
 * normal work and may quarantine + recreate a damaged db (a disk write). Here we
 * only want to peek at the path, so a missing/foreign/corrupt db just yields
 * undefined instead of mutating anything.
 */
export function readWorktree(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) return undefined
  try {
    const db = new BunSqlite(dbPath, { readonly: true })
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")
        .get()
      if (!hasTable) return undefined
      const row = db.prepare("SELECT worktree FROM project LIMIT 1").get() as { worktree?: string } | undefined
      return row?.worktree || undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Resolve a skill-evolution folder name (which is the project's id) back to the
 * project's real directory. The per-project db lives at
 * <channel>/aether-<projectId>.db; we read its worktree. Returns undefined when
 * the project has no such db (e.g. a transient project that was never persisted)
 * — the caller then falls back to showing the raw path.
 */
export function lookupProjectPath(projectId: string): string | undefined {
  return readWorktree(Database.projectPath(projectId))
}
