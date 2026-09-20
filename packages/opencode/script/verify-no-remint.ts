/**
 * Reproduces the user's exact complaint on a copy of the real local channel:
 * reconcile purges the junk rows at boot, then the app's project-restore churn
 * re-opens those directories — the rows must stay gone (no mint-on-open).
 */
const { existsSync, mkdirSync, cpSync, symlinkSync } = require("fs")
const path = require("path")

const src = path.join(process.env.USERPROFILE!, ".local", "share", "aether")
const dst = "C:/Users/yqma/AppData/Local/Temp/aether-replay-live-check"

mkdirSync(path.join(dst, "aether"), { recursive: true })
for (const f of ["aether-local.db", "aether-local.db-wal", "aether-local.db-shm"]) {
  if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(dst, "aether", f))
}
for (const d of ["local", "skill-evolution"]) {
  if (existsSync(path.join(src, d))) cpSync(path.join(src, d), path.join(dst, "aether", d), { recursive: true })
}
try {
  symlinkSync(path.join(src, "worktree"), path.join(dst, "aether", "worktree"), "junction")
} catch {}

process.env.XDG_DATA_HOME = dst
;(globalThis as any).OPENCODE_CHANNEL = "local"

const { Database } = await import("../src/storage/db")
const { Project } = await import("../src/project/project")

const main = Database.Client().$client // boot reconcile already ran here
Database.registerUntrackedProjects(Database.Client())

const afterPurge = (main.prepare("SELECT COUNT(*) n FROM project_recent").get() as { n: number }).n
console.log("feed rows after boot reconcile:", afterPurge)

// The app's churn: instances get booted for directories it saw in the feed.
for (const dir of [
  "C:\\Users\\yqma\\AppData\\Local\\Temp\\todo-e2e",
  "C:\\Users\\yqma\\AppData\\Local\\Temp\\aether-pr-1221",
]) {
  await Project.fromDirectory(dir)
}

const rows = main
  .prepare(
    "SELECT directory FROM project_recent WHERE directory LIKE '%todo-e2e%' OR directory LIKE '%aether-pr-1221%'",
  )
  .all()
console.log("junk rows after churn:", rows.length, rows.length === 0 ? "PASS — purge survives churn" : "FAIL")
console.log("feed rows total:", (main.prepare("SELECT COUNT(*) n FROM project_recent").get() as { n: number }).n)
