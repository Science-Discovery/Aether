import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { Project } from "../../src/project/project"
import { ProjectID } from "../../src/project/schema"
import { ProjectIdentity } from "../../src/project/identity"
import { ProjectTable } from "../../src/project/project.sql"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageTable, SessionTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { Global } from "../../src/global"
import { cleanupQuarantinedOriginals } from "../../src/storage/db-recovery"
import { Database as BunSqlite } from "bun:sqlite"
import { Log } from "../../src/util/log"
import { converse, tmpdir } from "../fixture/fixture"

const { norm } = ProjectIdentity

Log.init({ print: false })

function mainSqlite() {
  return Database.Client().$client
}

// Seed a fresh feed row without conversation activity (the residue a legacy
// writer or a rename would have left behind).
function seedRecent(directory: string, pid: ProjectID) {
  const now = Date.now()
  mainSqlite()
    .prepare(
      "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'project', ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET time_updated = excluded.time_updated",
    )
    .run(`dir:${norm(directory)}`, pid, norm(directory), now, now, now)
}

// Real app-managed worktree storage: <data>/worktree/<pid>/<sandbox>, with the
// sandbox as a live git worktree of the repo at `repo`.
async function managedSandbox(repo: string, name: string) {
  const pid = ProjectID.fromDirectory(norm(repo))
  const container = path.join(Global.Path.data, "worktree", pid, name)
  await fs.mkdir(path.dirname(container), { recursive: true })
  await $`git worktree add ${container} -b managed-${name}-${Date.now().toString(36)}`.cwd(repo).quiet()
  return container
}

async function dropManagedSandbox(repo: string, container: string) {
  await $`git worktree remove ${container}`
    .cwd(repo)
    .quiet()
    .catch(() => {})
  await fs.rm(path.dirname(container), { recursive: true, force: true })
}

describe("recent feed kind is derived from project identity", () => {
  test("stored kind column is ignored: corrupted kinds cannot surface sandbox entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    await converse(tmp.path)
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
    await converse(tmp.path)

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
    await converse(tmp.path)

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
    await converse(tmp.path)
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
    await converse(tmp.path)
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
    await converse(tmp.path)

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
    await converse(tmp.path)

    await Project.updateDirectoryMeta({ directory: tmp.path, name: "my-rename" })
    mainSqlite()
      .prepare("DELETE FROM project_recent WHERE key = ?")
      .run(`dir:${norm(tmp.path)}`)

    await Project.fromDirectory(tmp.path)

    const feedItem = Project.recentList().find((i) => Project.norm(i.directory) === norm(tmp.path))
    expect(feedItem?.name).toBe("my-rename")
    expect(Project.recentFromDir(tmp.path)?.name).toBe("my-rename")
  })

  test("cutoff window: a re-seeded row re-earns exactly one reconcile exemption pass", async () => {
    await using tmp = await tmpdir({ git: true })
    const pid = ProjectID.fromDirectory(norm(tmp.path))
    await Project.fromDirectory(tmp.path)
    seedRecent(tmp.path, pid)
    const rowHere = () => mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))

    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeDefined()

    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeFalsy()

    await converse(tmp.path)
    await Project.fromDirectory(tmp.path)
    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeDefined()

    // An active project is cutoff-exempt-proof: no pass can take its row.
    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeDefined()
  })

  test("projects without conversations do not keep a feed row, and re-earn it on activity", async () => {
    await using tmp = await tmpdir({ git: true })
    const pid = ProjectID.fromDirectory(norm(tmp.path))
    await Project.fromDirectory(tmp.path)
    seedRecent(tmp.path, pid)
    const rowHere = () => mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))
    expect(rowHere()).toBeDefined()

    // First pass: the row was seeded after the previous pass, so a fresh boot
    // registration is presumed live and survives (same-process recovery safety).
    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeDefined()

    // Second pass: nothing refreshed it — registration alone is not activity.
    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeFalsy()
    expect(Project.recentList().some((i) => Project.norm(i.directory) === norm(tmp.path))).toBe(false)

    // Real activity re-earns the row: touch mints it while active, and no
    // reconcile can take it afterwards.
    await converse(tmp.path)
    await Project.fromDirectory(tmp.path)
    Database.registerUntrackedProjects(Database.Client())
    Database.registerUntrackedProjects(Database.Client())

    expect(rowHere()).toBeDefined()
    const item = Project.recentList().find((i) => Project.norm(i.directory) === norm(tmp.path))
    expect(item?.kind).toBe("project")
  })

  test("sessions without messages are not activity: an empty session never re-earns the feed row", async () => {
    await using tmp = await tmpdir({ git: true })
    const pid = ProjectID.fromDirectory(norm(tmp.path))
    await Project.fromDirectory(tmp.path)
    // The optimistic-UI shape: a session row exists, but no conversation.
    await Instance.provide({ directory: tmp.path, fn: async () => Session.create({}) })
    seedRecent(tmp.path, pid)
    const rowHere = () => mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))
    expect(rowHere()).toBeDefined()

    // Freshly seeded rows survive exactly one pass (same-process safety)...
    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeDefined()
    // ...and an empty session never refreshes the row, so the next reconcile
    // collects it even though sessionCount > 0.
    Database.registerUntrackedProjects(Database.Client())
    expect(rowHere()).toBeFalsy()
    expect(Project.recentList().some((i) => Project.norm(i.directory) === norm(tmp.path))).toBe(false)

    // The app itself re-opens feed directories (project restore churn): that
    // must not resurrect the purged row — reopening is never activity.
    await Project.fromDirectory(tmp.path)
    expect(rowHere()).toBeFalsy()
  })

  test("opening a directory never mints a feed row; the first conversation does", async () => {
    await using tmp = await tmpdir({ git: true })
    await Project.fromDirectory(tmp.path)
    const rowHere = () => mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(tmp.path))
    expect(rowHere()).toBeFalsy()

    await converse(tmp.path)
    expect(rowHere()).toBeDefined()
  })
})

describe("managed worktree storage folds into the owning project", () => {
  test("a subdirectory of a managed sandbox resolves to the sandbox's project, never its own", async () => {
    await using tmp = await tmpdir({ git: true })
    const pid = ProjectID.fromDirectory(norm(tmp.path))
    const container = await managedSandbox(tmp.path, "fold")
    const sub = path.join(container, "packages", "sub")
    await fs.mkdir(sub, { recursive: true })

    try {
      const resolved = ProjectIdentity.resolve(sub)
      expect(resolved.id).toBe(pid)
      expect(resolved.kind).toBeUndefined()

      const { project } = await Project.fromDirectory(sub)
      expect(project.id).toBe(pid)
      expect(norm(project.worktree)).toBe(norm(tmp.path))

      const mapRow = mainSqlite()
        .prepare("SELECT project_id FROM global_project_map WHERE directory = ?")
        .get(norm(sub)) as { project_id: string }
      expect(mapRow?.project_id).toBe(pid)
      // No standalone identity, no feed row, no project db for the subdirectory.
      expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(sub))).toBeFalsy()
      expect(Project.recentList().some((i) => Project.norm(i.directory) === norm(sub))).toBe(false)
      expect(Database.hasProject(ProjectID.fromDirectory(norm(sub)))).toBeFalse()
    } finally {
      await dropManagedSandbox(tmp.path, container)
    }
  })

  test("legacy standalone subdirectory registrations are re-pointed and purged by reconciliation", async () => {
    await using tmp = await tmpdir({ git: true })
    const pid = ProjectID.fromDirectory(norm(tmp.path))
    await Project.fromDirectory(tmp.path)
    await converse(tmp.path)
    const container = await managedSandbox(tmp.path, "legacy")
    const sub = path.join(container, "packages", "sub")
    await fs.mkdir(sub, { recursive: true })
    const ghostId = ProjectID.fromDirectory(norm(sub))

    try {
      // Legacy shape (the packages/opencode ghost): the subdirectory carried
      // its own project db with real conversations, its own feed row and map
      // row, all pointing at a standalone id.
      mainSqlite()
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, 0, 0) ON CONFLICT(directory) DO UPDATE SET project_id = excluded.project_id",
        )
        .run(norm(sub), ghostId)
      mainSqlite()
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, 'project', ?, ?, 0, 0, 0) ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id",
        )
        .run(`dir:${norm(sub)}`, ghostId, norm(sub))
      Database.attach(ghostId)
      Database.useProject(ghostId, (d) => {
        d.insert(ProjectTable)
          .values({
            id: ghostId,
            worktree: sub,
            vcs: "git",
            sandboxes: [],
            time_created: 0,
            time_updated: 0,
          })
          .onConflictDoNothing()
          .run()
        const msg: MessageV2.User = {
          id: MessageID.make("msg_ghostlegacy"),
          sessionID: SessionID.make("ses_ghostlegacy"),
          time: { created: 0 },
          role: "user",
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        }
        const { id: mid, sessionID: msid, ...data } = msg
        d.insert(SessionTable)
          .values({
            id: SessionID.make("ses_ghostlegacy"),
            project_id: ghostId,
            slug: "ghost-legacy",
            directory: sub,
            title: "ghost legacy",
            version: "test",
            time_created: 0,
            time_updated: 0,
          })
          .run()
        d.insert(MessageTable)
          .values({
            id: mid,
            session_id: msid,
            time_created: 0,
            time_updated: 0,
            data,
          })
          .run()
      })
      Database.detach(ghostId)

      Database.registerUntrackedProjects(Database.Client())

      // The feed row and map entry are re-pointed to the owning project, then
      // the internal-directory rule collects the row in the same pass.
      const mapRow = mainSqlite()
        .prepare("SELECT project_id FROM global_project_map WHERE directory = ?")
        .get(norm(sub)) as { project_id: string }
      expect(mapRow?.project_id).toBe(pid)
      expect(mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(sub))).toBeFalsy()
      expect(Project.recentList().some((i) => Project.norm(i.directory) === norm(sub))).toBe(false)
      // Reconciliation is never data loss: the conversations remain on disk.
      expect(Database.hasProject(ghostId)).toBeTrue()

      // The owning project's own feed entry is untouched.
      const owner = Project.recentList().find((i) => Project.norm(i.directory) === norm(tmp.path))
      expect(owner?.kind).toBe("project")
      expect(owner?.projectID).toBe(pid)
    } finally {
      Database.deleteProject(ghostId)
      await dropManagedSandbox(tmp.path, container)
    }
  })
})
