import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdirSync } from "fs"
import { Project } from "../../src/project/project"
import { Database } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { eq } from "drizzle-orm"

Log.init({ print: false })

function row(pid: ProjectID) {
  return Database.useProject(pid, (d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, pid)).get())
}

describe("Project.fromDirectory subdirectory isolation", () => {
  test("subdirectory project registers itself only", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "sub")
    mkdirSync(sub)
    const { project } = await Project.fromDirectory(sub)

    const data = row(project.id)
    expect(data).toBeDefined()
    expect(data!.sandboxes.some((s) => path.resolve(s) === path.resolve(tmp.path))).toBe(false)

    const mainSqlite = Database.Client().$client
    const hijacked = mainSqlite
      .prepare("SELECT 1 FROM global_project_map WHERE directory = ? AND project_id = ?")
      .get(tmp.path.replace(/\\/g, "/"), project.id)
    expect(hijacked).toBeNull()

    const own = mainSqlite
      .prepare("SELECT 1 FROM global_project_map WHERE directory = ? AND project_id = ?")
      .get(sub.replace(/\\/g, "/"), project.id)
    expect(own).toBeDefined()
  })

  test("subdirectory project drops ancestor sandbox entries written by older builds", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "sub")
    mkdirSync(sub)
    const { project } = await Project.fromDirectory(sub)

    const keep = path.join(tmp.path, "unrelated-sandbox")
    Database.useProject(project.id, (d) =>
      d
        .update(ProjectTable)
        .set({ sandboxes: [tmp.path, tmp.path.replace(/\\/g, "/"), sub, keep] })
        .where(eq(ProjectTable.id, project.id))
        .run(),
    )

    await Project.fromDirectory(sub)

    const data = row(project.id)
    expect(data!.sandboxes).toEqual([keep])
  })

  test("git root project keeps unrelated sandboxes untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.vcs).toBe("git")

    const keep = path.join(tmp.path, "some-sandbox")
    Database.useProject(project.id, (d) =>
      d
        .update(ProjectTable)
        .set({ sandboxes: [keep] })
        .where(eq(ProjectTable.id, project.id))
        .run(),
    )

    await Project.fromDirectory(tmp.path)
    const data = row(project.id)
    expect(data!.sandboxes).toEqual([keep])
  })
})
