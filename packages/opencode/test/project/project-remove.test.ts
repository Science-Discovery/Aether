import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { ProjectID } from "../../src/project/schema"
import { ProjectIdentity } from "../../src/project/identity"
import { SessionTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { converse, tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Project.remove", () => {
  test("a project with conversations returns the blocking sessions instead of a dead end", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    await converse(tmp.path)

    const result = Project.remove(project.id)
    expect(result.status).toBe("has_sessions")
    if (result.status !== "has_sessions") return
    expect(result.sessionCount).toBeGreaterThan(0)
    expect(result.sessions.length).toBe(result.sessionCount)
    expect(result.sessions[0]!.id.startsWith("ses_")).toBe(true)
    expect(result.sessions[0]!.time_archived).toBeNull()
  })

  test("cascade removes every session including archived ones, then the project", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    await converse(tmp.path)
    // Archived sessions are hidden in the session list but still block removal.
    Database.useProject(project.id, (d) => d.update(SessionTable).set({ time_archived: Date.now() }).run())

    const blocked = Project.remove(project.id)
    expect(blocked.status).toBe("has_sessions")
    if (blocked.status === "has_sessions") {
      for (const s of blocked.sessions) expect(s.time_archived).not.toBeNull()
    }

    const result = Project.remove(project.id, { cascade: true })
    expect(result.status).toBe("ok")
    expect(Project.sessionCount(project.id)).toBe(0)
    expect(Project.get(project.id)).toBeUndefined()

    const mapRow = Database.Client()
      .$client.prepare("SELECT directory FROM global_project_map WHERE project_id = ?")
      .all(project.id)
    expect(mapRow.length).toBe(0)
    const recentRow = Database.Client()
      .$client.prepare("SELECT key FROM project_recent WHERE project_id = ?")
      .get(project.id)
    expect(recentRow).toBeFalsy()
    expect(Project.recentList().some((i) => i.projectID === project.id)).toBe(false)
  })

  test("a project without sessions removes directly", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const result = Project.remove(project.id)
    expect(result.status).toBe("ok")
    expect(Project.get(project.id)).toBeUndefined()
  })

  test("the sessions preview lists a project's conversations read from its database", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    await converse(tmp.path)
    const preview = Project.sessions(ProjectID.fromDirectory(ProjectIdentity.norm(tmp.path)))
    expect(preview.length).toBe(1)
    expect(preview[0]!.title).toContain("New session")
  })

  test("long histories are sampled to the earliest and newest session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    await converse(tmp.path)
    await Bun.sleep(5)
    await converse(tmp.path)
    await Bun.sleep(5)
    await converse(tmp.path)

    const preview = Project.sessions(ProjectID.fromDirectory(ProjectIdentity.norm(tmp.path)))
    expect(preview.length).toBe(2)
    expect(preview[0]!.time_created).toBeLessThan(preview[1]!.time_created)
    expect(preview[0]!.id).not.toBe(preview[1]!.id)
  })

  test("cascade removes a legacy database that cannot be attached", async () => {
    // Old-schema dbs (pre-migration-layout) throw when the current code
    // attaches them — exactly the projects users most want to delete.
    const pid = ProjectID.make("legacy-remove-test")
    const dbPath = Database.projectPath(pid)
    // A crashed earlier run can leave a garbage file; start clean.
    require("fs").rmSync(dbPath, { force: true })
    const raw = new (require("bun:sqlite").Database)(dbPath)
    raw.exec(
      "CREATE TABLE project (id text primary key, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)",
    )
    raw.exec(
      "CREATE TABLE session (id text primary key, project_id text NOT NULL, directory text NOT NULL, title text, slug text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)",
    )
    raw.exec(`INSERT INTO project VALUES ('${pid}', 'E:\\legacy', 0, 0)`)
    raw.exec(
      "INSERT INTO session VALUES ('ses_legacy1', 'legacy', 'E:\\legacy', 'legacy one', 'legacy-one', 'test', 0, 0)",
    )
    raw.exec(
      "INSERT INTO session VALUES ('ses_legacy2', 'legacy', 'E:\\legacy', 'legacy two', 'legacy-two', 'test', 0, 0)",
    )
    raw.close()

    const blocked = Project.remove(pid)
    expect(blocked.status).toBe("has_sessions")
    if (blocked.status === "has_sessions") {
      expect(blocked.sessions.length).toBe(2)
      expect(blocked.sessions[0]!.title).toBe("legacy one")
    }

    const result = Project.remove(pid, { cascade: true })
    expect(result.status).toBe("ok")
    expect(Project.sessionCount(pid)).toBe(0)
    const gpmRow = Database.Client()
      .$client.prepare("SELECT COUNT(*) n FROM global_project_map WHERE project_id = ?")
      .get(pid) as { n: number }
    expect(gpmRow.n).toBe(0)
  })
})
