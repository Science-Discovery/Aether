import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Database, eq } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function uid() {
  return SessionID.make(crypto.randomUUID())
}

function seed(opts: { id: SessionID; dir: string; project: ProjectID }) {
  const now = Date.now()
  Database.useProject(opts.project, (db) =>
    db
      .insert(SessionTable)
      .values({
        id: opts.id,
        project_id: opts.project,
        slug: opts.id,
        directory: opts.dir,
        title: "test",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
}

function ensureGlobal() {
  Database.useProject(ProjectID.global, (db) =>
    db
      .insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: "/",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
}

describe("migrateFromGlobal", () => {
  test("global sessions remain in global project db after real project creation", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()
    await $`git config user.name "Test"`.cwd(tmp.path).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(tmp.path).quiet()
    const { project: pre } = await Project.fromDirectory(tmp.path)
    expect(pre.id).toBe(ProjectID.global)

    const id = uid()
    seed({ id, dir: tmp.path, project: ProjectID.global })

    await $`git commit --allow-empty -m "root"`.cwd(tmp.path).quiet()

    const { project: real } = await Project.fromDirectory(tmp.path)
    expect(real.id).not.toBe(ProjectID.global)

    const row = Database.useProject(ProjectID.global, (db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, id)).get(),
    )
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(ProjectID.global)
  })

  test("global sessions remain in global db when real project row already exists", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    ensureGlobal()

    const id = uid()
    seed({ id, dir: tmp.path, project: ProjectID.global })

    await Project.fromDirectory(tmp.path)

    const row = Database.useProject(ProjectID.global, (db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, id)).get(),
    )
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(ProjectID.global)
  })

  test("does not claim sessions with empty directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    ensureGlobal()

    // Legacy sessions may lack a directory value.
    // Without a matching origin directory, they should remain global.
    const id = uid()
    seed({ id, dir: "", project: ProjectID.global })

    await Project.fromDirectory(tmp.path)

    const row = Database.useProject(ProjectID.global, (db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, id)).get(),
    )
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(ProjectID.global)
  })

  test("does not steal sessions from unrelated directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    ensureGlobal()

    // Seed a session under "global" but for a DIFFERENT directory
    const id = uid()
    seed({ id, dir: "/some/other/dir", project: ProjectID.global })

    await Project.fromDirectory(tmp.path)

    const row = Database.useProject(ProjectID.global, (db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, id)).get(),
    )
    expect(row).toBeDefined()
    // Should remain under "global" — not stolen
    expect(row!.project_id).toBe(ProjectID.global)
  })
})
