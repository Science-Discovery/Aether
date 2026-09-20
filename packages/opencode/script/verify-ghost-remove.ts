/**
 * Reproduce the user's exact failure: cascade-remove the real ghost project
 * (6a50bc39) against a CONSISTENT snapshot (VACUUM INTO) of the prod DBs.
 */
const { existsSync, mkdirSync, rmSync } = require("fs")
const path = require("path")
const { Database: BunSqlite } = require("bun:sqlite")
const { ProjectID } = require("../src/project/schema")

const src = "C:/Users/yqma/.local/share/aether"
const dst = "C:/Users/yqma/AppData/Local/Temp/aether-replay-remove-check2"
const pid = "6a50bc39b62d71b2b2b9c95a08230ad187439719"
const projectID = ProjectID.make(pid)
rmSync(dst, { recursive: true, force: true })

mkdirSync(path.join(dst, "aether", "prod"), { recursive: true })
const snapMain = path.join(dst, "aether", "aether-prod.db")
new BunSqlite(path.join(src, "aether-prod.db"), { readonly: true }).exec(`VACUUM INTO '${snapMain}'`)
const snapProj = path.join(dst, "aether", "prod", `aether-${pid}.db`)
new BunSqlite(path.join(src, "prod", `aether-${pid}.db`), { readonly: true }).exec(`VACUUM INTO '${snapProj}'`)
console.log("snapshots taken")

process.env.XDG_DATA_HOME = dst
;(globalThis as any).OPENCODE_CHANNEL = "prod"

const { Database } = await import("../src/storage/db")
const { Project } = await import("../src/project/project")

const first = Project.remove(projectID)
console.log("first remove:", JSON.stringify(first))

try {
  const result = Project.remove(projectID, { cascade: true })
  console.log("cascade result:", JSON.stringify(result))
  console.log("sessions left:", Project.sessionCount(projectID))
  console.log("project row:", JSON.stringify(Project.get(projectID)))
  const gpm = Database.Client()
    .$client.prepare("SELECT COUNT(*) n FROM global_project_map WHERE project_id = ?")
    .get(pid) as { n: number }
  console.log("gpm rows left:", gpm.n)
} catch (err) {
  console.log("CASCADE THREW:", String(err))
}
