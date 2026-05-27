import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { Git } from "../../src/git"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ProjectIdentity } from "../../src/project/identity"
import { SessionTable } from "../../src/session/session.sql"
import { DirectoryMetaTable } from "../../src/project/project.sql"
import { eq } from "drizzle-orm"
import { ManagedRuntime } from "effect"

const { norm } = ProjectIdentity

Log.init({ print: false })

async function withGit<T>(body: (rt: ManagedRuntime.ManagedRuntime<Git.Service, never>) => Promise<T>) {
  const rt = ManagedRuntime.make(Git.defaultLayer)
  try {
    return await body(rt)
  } finally {
    await rt.dispose()
  }
}

function mainSqlite() {
  return Database.Client().$client
}

describe("addSandbox writes project_recent immediately", () => {
  test("sandbox appears in project_recent with kind=directory after addSandbox", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const sandboxDir = path.join(tmp.path, "sandbox-test")

    await Project.addSandbox(project.id, sandboxDir)

    const row = mainSqlite()
      .prepare("SELECT key, kind, project_id, directory FROM project_recent WHERE directory = ?")
      .get(norm(sandboxDir)) as { key: string; kind: string; project_id: string; directory: string } | undefined

    expect(row).toBeDefined()
    expect(row!.kind).toBe("directory")
    expect(row!.project_id).toBe(project.id)
  })
})

describe("removeSandbox cleans up all related data", () => {
  test("removes directory_meta, sessions, project_recent, and global_project_map entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const sandboxDir = path.join(tmp.path, "sandbox-cleanup")

    await Project.addSandbox(project.id, sandboxDir)

    await Instance.provide({
      directory: sandboxDir,
      project: project,
      worktree: tmp.path,
      fn: async () => {
        await Session.create({})
      },
    })

    const dirMetaBefore = Database.useProject(project.id, (d) =>
      d
        .select()
        .from(DirectoryMetaTable)
        .where(eq(DirectoryMetaTable.directory, norm(sandboxDir)))
        .get(),
    )
    expect(dirMetaBefore).toBeDefined()

    const sessionsBefore = Database.useProject(project.id, (d) =>
      d
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.directory, norm(sandboxDir)))
        .all(),
    )
    expect(sessionsBefore.length).toBeGreaterThan(0)

    const recentBefore = mainSqlite()
      .prepare("SELECT key FROM project_recent WHERE directory = ?")
      .get(norm(sandboxDir))
    expect(recentBefore).toBeDefined()

    const gpmBefore = mainSqlite()
      .prepare("SELECT directory FROM global_project_map WHERE directory = ?")
      .get(norm(sandboxDir))
    expect(gpmBefore).toBeDefined()

    await Project.removeSandbox(project.id, sandboxDir)

    const dirMetaAfter = Database.useProject(project.id, (d) =>
      d
        .select()
        .from(DirectoryMetaTable)
        .where(eq(DirectoryMetaTable.directory, norm(sandboxDir)))
        .get(),
    )
    expect(dirMetaAfter).toBeUndefined()

    const sessionsAfter = Database.useProject(project.id, (d) =>
      d
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.directory, norm(sandboxDir)))
        .all(),
    )
    expect(sessionsAfter.length).toBe(0)

    const recentAfter = mainSqlite().prepare("SELECT key FROM project_recent WHERE directory = ?").get(norm(sandboxDir))
    expect(recentAfter).toBeFalsy()

    const gpmAfter = mainSqlite()
      .prepare("SELECT directory FROM global_project_map WHERE directory = ?")
      .get(norm(sandboxDir))
    expect(gpmAfter).toBeFalsy()
  })
})

describe("sandbox project_recent.kind stays directory after fromDirectory on main worktree", () => {
  test("opening main worktree does not overwrite sandbox kind to project", async () => {
    await using tmp = await tmpdir({ git: true })

    const { project } = await Project.fromDirectory(tmp.path)

    const wtPath = path.join(tmp.path, "..", `wt-${Date.now().toString(36)}`)
    await $`git worktree add ${wtPath} -b test-${Date.now()}`.cwd(tmp.path).quiet()

    await Project.addSandbox(project.id, wtPath)

    const wtRow = mainSqlite().prepare("SELECT kind FROM project_recent WHERE directory = ?").get(norm(wtPath)) as
      | { kind: string }
      | undefined
    expect(wtRow).toBeDefined()
    expect(wtRow!.kind).toBe("directory")

    await Project.fromDirectory(tmp.path)

    const wtRowAfter = mainSqlite().prepare("SELECT kind FROM project_recent WHERE directory = ?").get(norm(wtPath)) as
      | { kind: string }
      | undefined
    expect(wtRowAfter).toBeDefined()
    expect(wtRowAfter!.kind).toBe("directory")

    await $`git worktree remove ${wtPath}`
      .cwd(tmp.path)
      .quiet()
      .catch(() => {})
  })
})

describe("mergeSandboxSessions migrates session directory to main worktree", () => {
  test("sessions with sandbox directory get moved to main worktree directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const sandboxDir = path.join(tmp.path, "sandbox-merge")

    await Project.addSandbox(project.id, sandboxDir)

    await Instance.provide({
      directory: sandboxDir,
      project: project,
      worktree: tmp.path,
      fn: async () => {
        await Session.create({})
        await Session.create({})
      },
    })

    const before = Database.useProject(project.id, (d) =>
      d
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.directory, norm(sandboxDir)))
        .all(),
    )
    expect(before.length).toBe(2)

    const count = await Project.mergeSandboxSessions(project.id, sandboxDir)
    expect(count).toBe(2)

    const after = Database.useProject(project.id, (d) =>
      d
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.directory, norm(sandboxDir)))
        .all(),
    )
    expect(after.length).toBe(0)

    const moved = Database.useProject(project.id, (d) =>
      d
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.directory, norm(tmp.path)))
        .all(),
    )
    expect(moved.length).toBeGreaterThanOrEqual(2)
  })

  test("returns 0 when no sessions exist for the sandbox directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    const sandboxDir = path.join(tmp.path, "sandbox-empty")

    await Project.addSandbox(project.id, sandboxDir)

    const count = await Project.mergeSandboxSessions(project.id, sandboxDir)
    expect(count).toBe(0)
  })
})

describe("defaultBranch falls back to HEAD branch", () => {
  test("returns HEAD branch when no remote and branch is not main/master", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M dev`.cwd(tmp.path).quiet()

    await withGit(async (rt) => {
      const base = await rt.runPromise(Git.Service.use((git) => git.defaultBranch(tmp.path)))
      expect(base).toBeDefined()
      expect(base!.name).toBe("dev")
      expect(base!.ref).toBe("dev")
    })
  })
})
