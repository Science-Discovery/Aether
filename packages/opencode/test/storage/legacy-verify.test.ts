import { beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Database as Sqlite } from "bun:sqlite"
import { Global } from "../../src/global"
import { LegacyVerify } from "../../src/storage/legacy-verify"

async function clean() {
  const rows = await fs.readdir(Global.Path.data, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    rows
      .filter((row) => row.isFile() && /^(opencode|aether).*\.db$/i.test(row.name))
      .map((row) => fs.rm(path.join(Global.Path.data, row.name), { force: true })),
  )
}

function create(file: string, input: { worktree: string; project: string; workspace?: string }) {
  const db = new Sqlite(file)
  db.exec("create table if not exists project (id text primary key, worktree text not null, vcs text, name text)")
  db.exec("create table if not exists workspace (id text primary key, type text not null, branch text, name text, directory text, extra text, project_id text not null)")
  db.exec("create table if not exists session (id text primary key, project_id text not null, workspace_id text, slug text not null, directory text not null, title text not null, version text not null, time_created integer not null, time_updated integer not null)")
  db.exec("create table if not exists message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null)")
  db.prepare("insert into project (id, worktree, vcs, name) values (?, ?, ?, ?)").run(input.project, input.worktree, "git", "proj")
  if (input.workspace) {
    db.prepare("insert into workspace (id, type, branch, name, directory, project_id) values (?, ?, ?, ?, ?, ?)").run(input.workspace, "git", "dev", "wk", input.worktree, input.project)
  }
  db.prepare("insert into session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s1", input.project, input.workspace || null, "slug", input.worktree, "title", "0.1.0", 1, 2)
  db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m1", "s1", 1, 1, "{}")
  db.close()
}

describe("LegacyVerify", () => {
  beforeEach(async () => {
    await clean()
  })

  test("passes when session/project/workspace mapping stays consistent", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), { worktree: "/tmp/a", project: "p1", workspace: "w1" })
    create(path.join(Global.Path.data, "aether-prod.db"), { worktree: "/tmp/a", project: "p1", workspace: "w1" })
    const report = await LegacyVerify.run()
    expect(report.ok).toBeTrue()
    expect(report.errors.length).toBe(0)
  })

  test("fails when merged session points at project with wrong worktree", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), { worktree: "/tmp/a", project: "p1", workspace: "w1" })
    create(path.join(Global.Path.data, "aether-prod.db"), { worktree: "/tmp/b", project: "p1", workspace: "w1" })
    const report = await LegacyVerify.run()
    expect(report.ok).toBeFalse()
    expect(report.errors.some((item) => item === "project-worktree-mismatch:s1")).toBeTrue()
  })
})
