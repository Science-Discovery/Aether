import { describe, expect, test } from "bun:test"
import { Database } from "../../src/storage/db"
import { Project } from "../../src/project/project"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { ProjectID } from "../../src/project/schema"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Database.attach() guard", () => {
  test("attach() throws when project_id is not in global_project_map", async () => {
    const unregistered = ProjectID.fromDirectory(
      "/opencode-test-guard-nonexistent-" + Math.random().toString(36).slice(2),
    )

    expect(() => Database.attach(unregistered)).toThrow(
      `Cannot create project database: ${unregistered} is not registered`,
    )
  })

  test("attach() succeeds for project registered via fromDirectory", async () => {
    await using tmp = await tmpdir()
    const { project } = await Project.fromDirectory(tmp.path)

    Database.detach(project.id)
    const reopened = Database.attach(project.id)
    expect(reopened).toBeDefined()
  })

  test("attach() succeeds for git project registered via fromDirectory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    Database.detach(project.id)
    const reopened = Database.attach(project.id)
    expect(reopened).toBeDefined()
  })

  test("global_project_map has entry after fromDirectory", async () => {
    await using tmp = await tmpdir()
    const { project } = await Project.fromDirectory(tmp.path)

    const row = Database.Client()
      .$client.prepare("SELECT 1 FROM global_project_map WHERE project_id = ?")
      .get(project.id) as { 1: number } | undefined
    expect(row).toBeDefined()
  })
})
