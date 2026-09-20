/**
 * Replays registerUntrackedProjects against a COPY of the real prod data home.
 * Run from packages/opencode: bun script/replay-prod-reconcile.ts
 */
import { existsSync, mkdirSync, cpSync, readdirSync } from "fs"
import { Database as BunSqlite } from "bun:sqlite"
import path from "path"

const src = path.join(process.env.USERPROFILE!, ".local", "share", "aether")
const dst = path.join(process.env.TEMP!, `aether-replay-${Date.now().toString(36)}`)

mkdirSync(path.join(dst, "aether"), { recursive: true })
for (const f of ["aether-prod.db", "aether-prod.db-wal", "aether-prod.db-shm"]) {
  if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(dst, "aether", f))
}
for (const d of ["prod", "skill-evolution"]) {
  if (existsSync(path.join(src, d))) cpSync(path.join(src, d), path.join(dst, "aether", d), { recursive: true })
}

process.env.XDG_DATA_HOME = dst
;(globalThis as any).OPENCODE_CHANNEL = "prod"

// True BEFORE snapshot — taken before Client() init, which already runs
// registerUntrackedProjects once.
const preMain = new BunSqlite(path.join(dst, "aether", "aether-prod.db"))
const before: any[] = preMain
  .prepare("SELECT key, kind, project_id, directory FROM project_recent ORDER BY directory")
  .all()
const beforeDbs = readdirSync(path.join(dst, "aether", "prod")).filter((f) => f.endsWith(".db"))
preMain.close()
console.log(`\n=== BEFORE: ${before.length} recent rows, ${beforeDbs.length} project DBs ===`)

const { Database } = await import("../src/storage/db")

const main = Database.Client().$client

Database.registerUntrackedProjects(Database.Client())

const after: any[] = main
  .prepare("SELECT key, kind, project_id, directory FROM project_recent ORDER BY directory")
  .all()
const afterKeys = new Set(after.map((r) => r.key))

const removed = before.filter((r: any) => !afterKeys.has(r.key))
console.log(`\n=== REMOVED (${removed.length}) ===`)
for (const r of removed) console.log(`  [${r.kind}] ${r.directory}`)

console.log(`\n=== KEPT (${after.length}) ===`)
for (const r of after) console.log(`  [${r.kind}] ${r.directory}`)

const prodDir = path.join(dst, "aether", "prod")
const remaining = readdirSync(prodDir).filter((f) => f.endsWith(".db"))
console.log(`\n=== project DBs remaining in prod/: ${remaining.length} ===`)

const gpmGhost = main
  .prepare(
    "SELECT directory, project_id FROM global_project_map WHERE directory LIKE '%worktree%' OR directory LIKE '%Music%'",
  )
  .all()
console.log(`\n=== gpm rows (worktree/Music related): ${gpmGhost.length} ===`)
for (const r of gpmGhost as any[]) console.log(`  ${r.directory} -> ${r.project_id.slice(0, 8)}`)

console.log(`\nreplay home: ${dst}`)
