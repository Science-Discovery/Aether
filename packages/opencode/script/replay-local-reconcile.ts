/**
 * Replays registerUntrackedProjects against a COPY of the real local data home.
 * Run from packages/opencode: bun script/replay-local-reconcile.ts
 */
import { existsSync, mkdirSync, cpSync, readdirSync, symlinkSync } from "fs"
import { Database as BunSqlite } from "bun:sqlite"
import path from "path"

const src = path.join(process.env.USERPROFILE!, ".local", "share", "aether")
const dst = path.join(process.env.TEMP!, `aether-replay-local-${Date.now().toString(36)}`)

mkdirSync(path.join(dst, "aether"), { recursive: true })
for (const f of ["aether-local.db", "aether-local.db-wal", "aether-local.db-shm"]) {
  if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(dst, "aether", f))
}
for (const d of ["local", "skill-evolution"]) {
  if (existsSync(path.join(src, d))) cpSync(path.join(src, d), path.join(dst, "aether", d), { recursive: true })
}
// Stored directories point into the REAL data home; junction the worktree
// storage so identity's managed check sees the same content under the replay
// home (realpath resolves the junction back to the real path).
try {
  symlinkSync(path.join(src, "worktree"), path.join(dst, "aether", "worktree"), "junction")
} catch (e) {
  console.log("junction failed (managed fold will not be exercisable):", String(e))
}

process.env.XDG_DATA_HOME = dst
;(globalThis as any).OPENCODE_CHANNEL = "local"

// Snapshot BEFORE Client() init, which already runs registerUntrackedProjects once.
const preMain = new BunSqlite(path.join(dst, "aether", "aether-local.db"))
const before: any[] = preMain
  .prepare("SELECT key, kind, project_id, directory, time_updated FROM project_recent ORDER BY directory")
  .all()
const beforeGpm: any[] = preMain.prepare("SELECT directory, project_id FROM global_project_map").all()
preMain.close()
const beforeDbs = readdirSync(path.join(dst, "aether", "local")).filter((f) => /^aether-.+\.db$/.test(f))
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

console.log(`\n=== targeted assertions ===`)
const todoRow = main.prepare("SELECT key FROM project_recent WHERE directory LIKE '%todo-e2e%'").get()
const subRow = main.prepare("SELECT key FROM project_recent WHERE directory LIKE '%sandbox-3%packages%opencode%'").get()
console.log(`  todo-e2e feed row purged: ${todoRow == null ? "PASS" : "FAIL"}`)
console.log(`  sandbox-3/packages/opencode feed row purged: ${subRow == null ? "PASS" : "FAIL"}`)

const subGpm = main
  .prepare("SELECT project_id FROM global_project_map WHERE directory LIKE '%sandbox-3%packages%opencode%'")
  .get() as { project_id: string } | undefined
console.log(
  `  subdir gpm re-pointed to aether-dev (161d4d9a): ${subGpm?.project_id?.startsWith("161d4d9a") ? "PASS" : "FAIL -> " + subGpm?.project_id}`,
)

const localDir = path.join(dst, "aether", "local")
const ff = existsSync(path.join(localDir, "aether-ff44598f60fbc72a03f1300772da23785b73ed36.db"))
const ghost = existsSync(path.join(localDir, "aether-58a2e273f5786afed83b32f2a49141807572ad56.db"))
const dbsNow = readdirSync(localDir).filter((f) => /^aether-.+\.db$/.test(f))
console.log(`  todo-e2e db preserved: ${ff ? "PASS" : "FAIL"}`)
console.log(`  ghost conversations db preserved: ${ghost ? "PASS" : "FAIL"}`)
console.log(`\n  project DBs: ${beforeDbs.length} before -> ${dbsNow.length} after`)

const ghostMsg = new BunSqlite(path.join(localDir, "aether-58a2e273f5786afed83b32f2a49141807572ad56.db"), {
  readonly: true,
})
  .prepare("SELECT COUNT(*) n FROM message")
  .get() as { n: number }
console.log(`  ghost db messages still on disk: ${ghostMsg.n}`)

console.log(`\nreplay home: ${dst}`)
