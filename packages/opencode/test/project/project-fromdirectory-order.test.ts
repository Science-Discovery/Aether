import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { existsSync } from "fs"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectIdentity } from "../../src/project/identity"
import { eq } from "drizzle-orm"
import path from "path"

const { norm } = ProjectIdentity

Log.init({ print: false })

describe("Project.fromDirectory ordering", () => {
  test("writes global_project_map, project_recent, and creates per-project DB", async () => {
    await using tmp = await tmpdir()
    const { project } = await Project.fromDirectory(tmp.path)

    const mainSqlite = Database.Client().$client

    const gpm = mainSqlite.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").all(project.id) as {
      directory: string
    }[]
    expect(gpm.length).toBeGreaterThan(0)

    const recent = mainSqlite.prepare("SELECT directory FROM project_recent WHERE project_id = ?").get(project.id) as
      | { directory: string }
      | undefined
    expect(recent).toBeDefined()

    const dbPath = Database.projectPath(project.id)
    expect(existsSync(dbPath)).toBe(true)

    const row = Database.useProject(project.id, (d) =>
      d.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)).get(),
    )
    expect(row).toBeDefined()
  })

  test("registers worktree and sandbox aliases in global_project_map", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    const gpm = Database.Client()
      .$client.prepare("SELECT directory FROM global_project_map WHERE project_id = ?")
      .all(project.id) as { directory: string }[]

    const dirs = gpm.map((r) => r.directory)
    const wt = norm(project.worktree)
    const raw = norm(tmp.path)

    expect(dirs.some((d) => norm(d) === wt)).toBe(true)
    expect(dirs.some((d) => norm(d) === raw)).toBe(true)
  })

  test("project_recent entry has matching directory", async () => {
    await using tmp = await tmpdir()
    const { project } = await Project.fromDirectory(tmp.path)

    const recent = Database.Client()
      .$client.prepare("SELECT directory FROM project_recent WHERE project_id = ?")
      .get(project.id) as { directory: string } | undefined

    expect(recent).toBeDefined()
    expect(norm(recent!.directory)).toBe(norm(tmp.path))
  })
})
