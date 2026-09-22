import { describe, expect, test } from "bun:test"
import path from "path"
import { existsSync, mkdirSync } from "fs"
import { $ } from "bun"
import { Project } from "../../src/project/project"
import { Database } from "../../src/storage/db"
import { WorktreeDiscover } from "../../src/worktree/discover"
import { Global } from "../../src/global"
import { GlobalBus } from "../../src/bus/global"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { DirectoryMetaTable, ProjectTable } from "../../src/project/project.sql"
import { GlobalProjectMapTable } from "../../src/project/global-project-map.sql"
import { eq } from "drizzle-orm"
import { ProjectIdentity } from "../../src/project/identity"
import type { ProjectID } from "../../src/project/schema"

Log.init({ print: false })

function storageRoot(pid: string) {
  return path.join(Global.Path.data, "worktree", pid)
}

// stored paths spell the git-registered form, which differs from the
// caller-provided one when the data dir sits behind a symlink or an 8.3
// short name (CI runners); match by trailing segment instead of spelling
function holds(dir: string | undefined | null, base: string) {
  return !!dir && dir.replace(/\\/g, "/").endsWith("/" + base)
}

async function metaRows(pid: ProjectID) {
  return Database.useProject(pid, (d) => d.select().from(DirectoryMetaTable).all())
}

describe("WorktreeDiscover", () => {
  test("external git worktree add is discovered, registered and broadcast at runtime", async () => {
    await using tmp = await tmpdir({ git: true })

    const events: any[] = []
    const on = (evt: any) => events.push(evt)
    GlobalBus.on("event", on)

    const { project } = await Project.fromDirectory(tmp.path)
    const external = path.join(storageRoot(project.id), "aether-custom")
    mkdirSync(storageRoot(project.id), { recursive: true })
    await $`git worktree add ${external} -b sandbox/aether-custom`.cwd(tmp.path)

    await WorktreeDiscover.poll()

    const rows = (await metaRows(project.id)).filter((m) => holds(m.directory, "aether-custom"))
    expect(rows.length).toBe(1)
    expect(rows[0]?.worktree).toBe(Project.norm(tmp.path))

    const sandboxes = await Project.sandboxes(project.id)
    expect(sandboxes.some((s) => holds(s, "aether-custom"))).toBe(true)

    GlobalBus.off("event", on)
    const updated = events.find(
      (e) =>
        e.payload.type === Project.Event.Updated.type &&
        e.payload.properties.sandboxes?.some((s: string) => holds(s, "aether-custom")),
    )
    expect(updated).toBeDefined()
  })

  test("discovery is idempotent across repeated polls", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const external = path.join(storageRoot(project.id), "aether-dedupe")
    mkdirSync(storageRoot(project.id), { recursive: true })
    await $`git worktree add ${external} -b sandbox/aether-dedupe`.cwd(tmp.path)

    await WorktreeDiscover.poll()
    await WorktreeDiscover.poll()
    await WorktreeDiscover.poll()

    const rows = (await metaRows(project.id)).filter((m) => holds(m.directory, "aether-dedupe"))
    expect(rows.length).toBe(1)

    const sandboxes = await Project.sandboxes(project.id)
    expect(sandboxes.filter((s) => holds(s, "aether-dedupe")).length).toBe(1)
  })

  test("poll alone registers an externally added worktree without bootstrap sync", async () => {
    await using tmp = await tmpdir({ git: true })
    const info = ProjectIdentity.resolve(tmp.path)
    Database.use((d) =>
      d
        .insert(GlobalProjectMapTable)
        .values({
          directory: Project.norm(tmp.path),
          project_id: info.id,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run(),
    )
    Database.useProject(info.id, (d) =>
      d
        .insert(ProjectTable)
        .values({
          id: info.id,
          worktree: Project.norm(tmp.path),
          vcs: "git",
          sandboxes: [],
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run(),
    )

    const external = path.join(storageRoot(info.id), "aether-solo")
    mkdirSync(storageRoot(info.id), { recursive: true })
    await $`git worktree add ${external} -b sandbox/aether-solo`.cwd(tmp.path)

    await WorktreeDiscover.poll()

    const rows = (await metaRows(info.id)).filter((m) => holds(m.directory, "aether-solo"))
    expect(rows.length).toBe(1)
    expect(rows[0]?.worktree).toBe(Project.norm(tmp.path))
  })

  test("residue directory that git does not track is never registered", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const residue = path.join(storageRoot(project.id), "residue-husk")
    mkdirSync(residue, { recursive: true })

    await WorktreeDiscover.poll()

    const metas = await metaRows(project.id)
    expect(metas.some((m) => holds(m.directory, "residue-husk"))).toBe(false)
    const sandboxes = await Project.sandboxes(project.id)
    expect(sandboxes.some((s) => holds(s, "residue-husk"))).toBe(false)
  })

  test("storage directory of an unknown project is skipped without creating a database", async () => {
    const ghost = path.join(Global.Path.data, "worktree", "externalpollghost")
    mkdirSync(ghost, { recursive: true })

    await WorktreeDiscover.poll()

    expect(existsSync(Database.projectPath("externalpollghost"))).toBe(false)
  })
})
