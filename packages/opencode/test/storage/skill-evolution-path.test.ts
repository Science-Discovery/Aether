import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "../../src/global"
import { Database } from "../../src/storage/db"
import { ProjectID } from "../../src/project/schema"
import { Spawner } from "../../src/skill-evolution/spawner"

// projectPath() must resolve skill-evolution sub-project DBs purely from the
// filesystem — no in-memory cache, so it survives a process restart. These
// tests isolate Global.Path.data into a tmp dir and assert the routing.
describe("Database.projectPath skill-evolution routing", () => {
  let tmp: string
  let origData: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "se-path-"))
    origData = Global.Path.data
    ;(Global.Path as { data: string }).data = tmp
  })

  afterEach(async () => {
    ;(Global.Path as { data: string }).data = origData
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test("sub-project id resolves to a DB inside its own folder", async () => {
    // folderName is the main project's id; the sub-project dir is hashed to seSubId.
    const folderName = "a3f2bc1d2e3f4567"
    const subDir = Spawner.skillEvolutionBase(folderName)
    await fs.mkdir(subDir, { recursive: true })
    const seSubId = String(ProjectID.fromDirectory(Database.norm(subDir)))

    expect(Database.projectPath(seSubId)).toBe(path.join(subDir, `aether-${seSubId}.db`))
  })

  test("root id maps to the curator-reserved channel DB", () => {
    const rootId = String(ProjectID.fromDirectory(Database.norm(Spawner.skillEvolutionRoot())))
    expect(Database.projectPath(rootId)).toEndWith(path.join("aether-skill-evolution.db"))
  })

  test("the shared/ folder is never treated as a sub-project", async () => {
    const shared = Spawner.skillEvolutionShared()
    await fs.mkdir(shared, { recursive: true })
    const sharedId = String(ProjectID.fromDirectory(Database.norm(shared)))
    // shared/ is reserved; its id must fall through to the channel-dir path,
    // not a DB inside the shared folder.
    expect(Database.projectPath(sharedId)).not.toContain(path.join("skill-evolution", "shared"))
  })

  test("an unknown id falls through to the channel-dir path", () => {
    const unknown = "deadbeefdeadbeef"
    expect(Database.projectPath(unknown)).toEndWith(`aether-${unknown}.db`)
    expect(Database.projectPath(unknown)).not.toContain("skill-evolution")
  })
})
