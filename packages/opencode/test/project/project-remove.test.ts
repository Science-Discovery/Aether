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
})
