import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { existsSync } from "fs"
import { Project } from "../../src/project/project"
import { ProjectID } from "../../src/project/schema"
import { ProjectRecentTable } from "../../src/project/project.sql"
import { GlobalProjectMapTable } from "../../src/project/global-project-map.sql"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Project.directories", () => {
  test("does not turn an empty directory registration into the server working directory", () => {
    const dirs = Project.directories()
    Database.use((db) =>
      db
        .insert(ProjectRecentTable)
        .values({
          key: "dir:",
          kind: "directory",
          project_id: null,
          directory: "",
          activity_at: 0,
          time_created: 0,
          time_updated: 0,
        })
        .run(),
    )

    expect(Project.directories()).toEqual(dirs)
  })

  test("includes registered sandboxes hidden from the recent project feed", async () => {
    await using tmp = await tmpdir()
    const result = await Project.fromDirectory(tmp.path)
    const dir = path.join(tmp.path, "sandbox")
    await Project.addSandbox(result.project.id, dir)

    expect(Project.recentList().some((item) => Project.norm(item.directory) === Project.norm(dir))).toBe(false)
    expect(Project.directories()).toContain(Project.norm(dir))
  })

  test("includes an existing git worktree opened without a recent entry", async () => {
    await using root = await tmpdir({ git: true })
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "worktree")
    await $`git worktree add --detach ${dir}`.cwd(root.path).quiet()
    const result = await Project.fromDirectory(dir)

    expect(Project.norm(result.project.worktree)).toBe(Project.norm(root.path))
    expect(
      Database.use((db) => db.select().from(ProjectRecentTable).all()).some(
        (row) => Project.norm(row.directory) === Project.norm(dir),
      ),
    ).toBe(false)
    expect(Project.directories()).toContain(Project.norm(dir))
  })

  test("does not restore a removed sandbox from its sessions or metadata", async () => {
    await using tmp = await tmpdir()
    const result = await Project.fromDirectory(tmp.path)
    const dir = path.join(tmp.path, "removed")
    await Project.addSandbox(result.project.id, dir)
    await Instance.provide({
      directory: dir,
      project: result.project,
      worktree: tmp.path,
      fn: async () => {
        await Session.create({})
        await Instance.dispose()
      },
    })
    await Project.removeSandbox(result.project.id, dir)

    const dirs = Project.directories()
    expect(dirs).toContain(Project.norm(tmp.path))
    expect(dirs).not.toContain(Project.norm(dir))
  })

  test("does not restore a removed project from a leftover database file", async () => {
    await using tmp = await tmpdir()
    const result = await Project.fromDirectory(tmp.path)
    await Project.addSandbox(result.project.id, path.join(tmp.path, "sandbox"))
    expect(Project.remove(result.project.id).status).toBe("ok")
    expect(existsSync(Database.projectPath(result.project.id))).toBe(true)
    Database.use((db) =>
      db
        .insert(GlobalProjectMapTable)
        .values({
          directory: Project.norm(tmp.path),
          project_id: result.project.id,
          time_created: 0,
          time_updated: 0,
        })
        .run(),
    )

    expect(Project.directories().some((dir) => Project.norm(dir).startsWith(Project.norm(tmp.path)))).toBe(false)
  })

  test("ignores stale registrations without creating a project database or instance", async () => {
    await using tmp = await tmpdir()
    const dir = Project.norm(tmp.path)
    const id = ProjectID.fromDirectory(dir)
    Database.use((db) => {
      db.insert(GlobalProjectMapTable)
        .values({ directory: dir, project_id: id, time_created: 0, time_updated: 0 })
        .run()
      db.insert(ProjectRecentTable)
        .values({
          key: `dir:${dir}`,
          kind: "project",
          project_id: id,
          directory: dir,
          activity_at: 0,
          time_created: 0,
          time_updated: 0,
        })
        .run()
    })
    const instances = Instance.dirs()

    expect(Project.directories()).not.toContain(dir)
    expect(Database.hasProject(id)).toBe(false)
    expect(Instance.dirs()).toEqual(instances)
  })
})
