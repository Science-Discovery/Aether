import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { existsSync } from "fs"
import { Project } from "../../src/project/project"
import { ProjectID } from "../../src/project/schema"
import { ProjectIdentity } from "../../src/project/identity"
import { ProjectTable } from "../../src/project/project.sql"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import { Global } from "../../src/global"
import { cleanupQuarantinedOriginals } from "../../src/storage/db-recovery"
import { Database as BunSqlite } from "bun:sqlite"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

const { norm } = ProjectIdentity

Log.init({ print: false })

function mainSqlite() {
  return Database.Client().$client
}

describe("recent feed kind is derived from project identity", () => {
  test("stored kind column is ignored: corrupted kinds cannot surface sandbox entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const sandboxDir = path.join(tmp.path, "sandbox-kind")

    await Project.addSandbox(project.id, sandboxDir)

    // Simulate legacy corruption: a stale "project"-kind row for the sandbox
    // path and a "directory"-kind row for the worktree path.
    mainSqlite()
      .prepare(
        "INSERT OR IGNORE INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'project', ?, ?, 0, 0, 0)",
      )
      .run(`dir:${norm(sandboxDir)}`, project.id, norm(sandboxDir))
    mainSqlite()
      .prepare("UPDATE project_recent SET kind = 'directory' WHERE key = ?")
      .run(`dir:${norm(tmp.path)}`)

    const feed = Project.recentList()
    const worktreeItem = feed.find((item) => Project.norm(item.directory) === norm(tmp.path))
    expect(worktreeItem?.kind).toBe("project")
    expect(worktreeItem?.projectID).toBe(project.id)
    expect(feed.some((item) => Project.norm(item.directory) === norm(sandboxDir))).toBe(false)

    const list = Project.list()
    expect(list.find((p) => p.id === project.id)).toBeDefined()
  })

  test("recentFromDir derives project kind for the worktree directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)

    const info = Project.recentFromDir(tmp.path)
    expect(info?.kind).toBe("project")
    expect(info?.worktree).toBeDefined()
  })
})

describe("startup reconciliation removes ghost sandbox projects", () => {
  test("empty project db whose worktree resolves to another project is quarantined", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project: parent } = await Project.fromDirectory(tmp.path)
    // The parent is an active project: its feed row must survive reconciliation.
    await Instance.provide({ directory: tmp.path, fn: async () => Session.create({}) })

    const wtPath = path.join(tmp.path, "..", `ghost-wt-${Date.now().toString(36)}`)
    await $`git worktree add ${wtPath} -b ghost-branch-${Date.now().toString(36)}`.cwd(tmp.path).quiet()

    try {
      // A legacy bug registered the sandbox as a standalone project: its own id,
      // its own project row claiming the sandbox path as worktree, no sessions.
      // Upsert wins over the parent's concurrent syncWorktrees registration.
      const ghostId = ProjectID.fromDirectory(norm(wtPath))
      mainSqlite()
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, 0, 0) ON CONFLICT(directory) DO UPDATE SET project_id = excluded.project_id",
        )
        .run(norm(wtPath), ghostId)
      mainSqlite()
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'project', ?, ?, 0, 0, 0) ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id",
        )
        .run(`dir:${norm(wtPath)}`, ghostId, norm(wtPath))

      Database.attach(ghostId)
      Database.useProject(ghostId, (d) =>
        d
          .insert(ProjectTable)
          .values({
            id: ghostId,
            worktree: wtPath,
            vcs: "git",
            sandboxes: [],
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .onConflictDoNothing()
          .run(),
      )
      Database.detach(ghostId)

      const ghostDbPath = Database.projectPath(ghostId)
      expect(existsSync(ghostDbPath)).toBeTrue()
      expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE project_id = ?").get(ghostId)).toBeDefined()

      Database.registerUntrackedProjects(Database.Client())
      // The ghost db is quarantined; on Windows the unlink can be blocked by a
      // lingering handle, and a later startup's cleanup removes the leftover.
      for (let i = 0; i < 5 && existsSync(ghostDbPath); i++) {
        Bun.gc(true)
        await Bun.sleep(100)
        cleanupQuarantinedOriginals()
      }

      // Ghost is dead: its feed and map rows are purged.
      expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE project_id = ?").get(ghostId)).toBeFalsy()
      expect(
        mainSqlite().prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(ghostId),
      ).toBeFalsy()

      // Parent project and its feed entry survive untouched.
      const parentItem = Project.recentList().find((item) => Project.norm(item.directory) === norm(tmp.path))
      expect(parentItem?.kind).toBe("project")
      expect(parentItem?.projectID).toBe(parent.id)
      expect(Project.get(parent.id)).toBeDefined()
    } finally {
      await $`git worktree remove ${wtPath}`
        .cwd(tmp.path)
        .quiet()
        .catch(() => {})
    }
  })

  test("sandbox rows of a real project are purged from the feed, project entry kept", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    // Active project: its own feed row must survive reconciliation.
    await Instance.provide({ directory: tmp.path, fn: async () => Session.create({}) })
    const sandboxDir = path.join(tmp.path, "sandbox-purge")

    await Project.addSandbox(project.id, sandboxDir)

    // Legacy pollution: a recent row for the sandbox directory.
    mainSqlite()
      .prepare(
        "INSERT OR IGNORE INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'directory', ?, ?, 0, 0, 0)",
      )
      .run(`dir:${norm(sandboxDir)}`, project.id, norm(sandboxDir))

    Database.registerUntrackedProjects(Database.Client())

    expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(sandboxDir))).toBeFalsy()
    const item = Project.recentList().find((i) => Project.norm(i.directory) === norm(tmp.path))
    expect(item?.kind).toBe("project")
    expect(item?.projectID).toBe(project.id)
  })

  test("empty project claiming app-managed worktree storage is quarantined even when the directory is gone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)

    // A ghost whose sandbox home was already deleted from disk: identity
    // re-resolution sees only the empty path, but the app-managed data-home
    // location gives it away.
    const deadHome = path.join(Global.Path.data, "worktree", "deadproject0000", "sandbox-9")
    const ghostId = ProjectID.fromDirectory(norm(deadHome))
    mainSqlite()
      .prepare(
        "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, 0, 0) ON CONFLICT(directory) DO UPDATE SET project_id = excluded.project_id",
      )
      .run(norm(deadHome), ghostId)
    mainSqlite()
      .prepare(
        "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'project', ?, ?, 0, 0, 0) ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id",
      )
      .run(`dir:${norm(deadHome)}`, ghostId, norm(deadHome))

    Database.attach(ghostId)
    Database.useProject(ghostId, (d) =>
      d
        .insert(ProjectTable)
        .values({
          id: ghostId,
          worktree: deadHome,
          vcs: "git",
          sandboxes: [],
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .onConflictDoNothing()
        .run(),
    )
    Database.detach(ghostId)

    Database.registerUntrackedProjects(Database.Client())
    for (let i = 0; i < 5 && Database.hasProject(ghostId); i++) {
      Bun.gc(true)
      await Bun.sleep(100)
      cleanupQuarantinedOriginals()
    }

    expect(Database.hasProject(ghostId)).toBeFalse()
    expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE project_id = ?").get(ghostId)).toBeFalsy()
    expect(
      mainSqlite().prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(ghostId),
    ).toBeFalsy()
  })

  test("recentFromDir never revives a stored project kind for a sandbox directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    await Instance.provide({ directory: tmp.path, fn: async () => Session.create({}) })
    const sandboxDir = path.join(tmp.path, "sandbox-ghost-kind")

    await Project.addSandbox(project.id, sandboxDir)
    mainSqlite()
      .prepare(
        "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'project', ?, ?, 0, 0, 0) ON CONFLICT(key) DO UPDATE SET kind = 'project'",
      )
      .run(`dir:${norm(sandboxDir)}`, project.id, norm(sandboxDir))

    const info = Project.recentFromDir(sandboxDir)
    expect(info).toBeDefined()
    expect(info?.kind).toBe("directory")
    expect(info?.worktree).toBeUndefined()
    expect(info?.projectID).toBeUndefined()
    expect(Project.recentList().some((i) => Project.norm(i.directory) === norm(sandboxDir))).toBe(false)
  })

  test("gpm mapping backfills a NULLed project_id for the feed, keyed lookup and project list", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    await Instance.provide({ directory: tmp.path, fn: async () => Session.create({}) })

    mainSqlite()
      .prepare("UPDATE project_recent SET project_id = NULL WHERE key = ?")
      .run(`dir:${norm(tmp.path)}`)
    expect(
      mainSqlite().prepare("SELECT project_id FROM global_project_map WHERE directory = ?").get(norm(tmp.path)),
    ).toBeDefined()

    const feedItem = Project.recentList().find((i) => Project.norm(i.directory) === norm(tmp.path))
    expect(feedItem?.kind).toBe("project")
    expect(feedItem?.projectID).toBe(project.id)

    const info = Project.recentFromDir(tmp.path)
    expect(info?.kind).toBe("project")
    expect(info?.projectID).toBe(project.id)

    expect(Project.list().find((p) => p.id === project.id)).toBeDefined()
  })

  test("a dead pid row hides from the feed but stays resolvable via keyed lookup", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    const deadDir = path.join(tmp.path, "dead-ref")
    const deadPid = ProjectID.fromDirectory(norm(deadDir))

    mainSqlite()
      .prepare(
        "INSERT OR IGNORE INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'directory', ?, ?, 0, 0, 0)",
      )
      .run(`dir:${norm(deadDir)}`, deadPid, norm(deadDir))

    expect(Project.recentList().some((i) => Project.norm(i.directory) === norm(deadDir))).toBe(false)

    const info = Project.recentFromDir(deadDir)
    expect(info?.kind).toBe("directory")
    expect(info?.projectID).toBeUndefined()
    expect(info?.name).toBe("dead-ref")
  })

  test("rename survives a project_recent row rebuild through the directory_meta fallback", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    await Instance.provide({ directory: tmp.path, fn: async () => Session.create({}) })

    await Project.updateDirectoryMeta({ directory: tmp.path, name: "my-rename" })
    mainSqlite()
      .prepare("DELETE FROM project_recent WHERE key = ?")
      .run(`dir:${norm(tmp.path)}`)

    await Project.fromDirectory(tmp.path)

    const feedItem = Project.recentList().find((i) => Project.norm(i.directory) === norm(tmp.path))
    expect(feedItem?.name).toBe("my-rename")
    expect(Project.recentFromDir(tmp.path)?.name).toBe("my-rename")
  })

  test("cutoff window: a re-touched row re-earns exactly one reconcile exemption pass", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    const rowHere = () => mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))

    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeDefined()

    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeFalsy()

    await Bun.sleep(2)
    await Project.fromDirectory(tmp.path)
    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeDefined()

    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeFalsy()
  })

  test("projects without sessions in this channel do not keep a feed row, and re-earn it on activity", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))).toBeDefined()

    // First pass: the row was touched after the previous pass, so a fresh boot
    // registration is presumed live and survives (same-process recovery safety).
    Database.registerUntrackedProjects(Database.Client())
    expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))).toBeDefined()

    // Second pass: nothing re-touched it — registration alone is not activity.
    Database.registerUntrackedProjects(Database.Client())
    expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))).toBeFalsy()
    expect(Project.recentList().some((i) => Project.norm(i.directory) === norm(tmp.path))).toBe(false)

    // Real activity re-earns the row and survives reconciliation.
    await Instance.provide({ directory: tmp.path, fn: async () => Session.create({}) })
    await Project.fromDirectory(tmp.path)
    Database.registerUntrackedProjects(Database.Client())

    expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))).toBeDefined()
    const item = Project.recentList().find((i) => Project.norm(i.directory) === norm(tmp.path))
    expect(item?.kind).toBe("project")
  })
})
