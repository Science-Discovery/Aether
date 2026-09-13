import { expect, test } from "bun:test"
import { Hono } from "hono"
import path from "path"
import { GlobalProjectMapTable } from "../../src/project/global-project-map.sql"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { ProjectRecentTable } from "../../src/project/project.sql"
import { ProjectRoutes } from "../../src/server/routes/project"
import { Database } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

test("global directory checks include sandboxes without bootstrapping a directory", async () => {
  await using tmp = await tmpdir()
  const result = await Project.fromDirectory(tmp.path)
  const dir = path.join(tmp.path, "sandbox")
  await Project.addSandbox(result.project.id, dir)
  const instances = Instance.dirs()
  const recent = Database.use((db) => db.select().from(ProjectRecentTable).all())
  const mapped = Database.use((db) => db.select().from(GlobalProjectMapTable).all())

  const response = await new Hono().route("/project", ProjectRoutes()).request("/project/directories")
  expect(response.status).toBe(200)
  expect(await response.json()).toContain(Project.norm(dir))
  expect(Instance.dirs()).toEqual(instances)
  expect(Database.use((db) => db.select().from(ProjectRecentTable).all())).toEqual(recent)
  expect(Database.use((db) => db.select().from(GlobalProjectMapTable).all())).toEqual(mapped)
})
