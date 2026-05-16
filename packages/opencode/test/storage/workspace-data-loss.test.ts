import { Database as BunSqlite } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs"
import path from "path"
import os from "os"
import { rm } from "fs/promises"

const tmpBase = path.join(os.tmpdir(), "aether-workspace-dl-test")

function norm(input: string) {
  return path.resolve(input).replace(/\\/g, "/").toLowerCase()
}

function getMigrationEntries() {
  const dir = path.join(import.meta.dirname, "../../migration")
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  return dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return undefined
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: (() => {
          const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
          if (!match) return 0
          return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])
        })(),
        name,
      }
    })
    .filter((x): x is { sql: string; timestamp: number; name: string } => x !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)
}

function initDb(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const sqlite = new BunSqlite(filePath)
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = NORMAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec("PRAGMA foreign_keys = ON")
  const db = drizzle({ client: sqlite })
  migrate(db, getMigrationEntries())
  return sqlite
}

function initDbWithoutWorkspace(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const sqlite = new BunSqlite(filePath)
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = NORMAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec("PRAGMA foreign_keys = ON")
  const db = drizzle({ client: sqlite })
  migrate(
    db,
    getMigrationEntries().filter((e) => !e.name.includes("workspace")),
  )
  return sqlite
}

function initMainDb(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const sqlite = new BunSqlite(filePath)
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = NORMAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec("PRAGMA foreign_keys = ON")
  const db = drizzle({ client: sqlite })
  migrate(db, getMigrationEntries())
  return sqlite
}

function makeTmpDir() {
  const dir = path.join(tmpBase, Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  return dir
}

async function rmTmpDir(dir: string) {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

function simulateRegisterUntrackedProjects(mainSqlite: BunSqlite, channelDir: string) {
  const existingDbIds = new Set<string>()
  const validWorktreeKeys = new Set<string>()

  if (existsSync(channelDir)) {
    const pattern = /^aether-(.+)\.db$/
    for (const entry of readdirSync(channelDir)) {
      const match = pattern.exec(entry)
      if (!match) continue
      const pid = match[1]
      if (pid === "cron") continue
      existingDbIds.add(pid)
    }
  }

  for (const pid of existingDbIds) {
    const fullPath = path.join(channelDir, `aether-${pid}.db`)
    const pSqlite = new BunSqlite(fullPath)
    try {
      const wt = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
        | { worktree: string }
        | undefined
      if (wt?.worktree && wt.worktree !== "/") validWorktreeKeys.add(`dir:${norm(wt.worktree)}`)

      const hasWorkspace = pSqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'")
        .get()
      if (hasWorkspace) {
        const workspaceRows = pSqlite.prepare("SELECT directory FROM workspace WHERE project_id = ?").all(pid) as {
          directory: string
        }[]
        for (const ws of workspaceRows) {
          if (ws.directory) validWorktreeKeys.add(`dir:${norm(ws.directory)}`)
        }
      }
    } finally {
      pSqlite.close()
    }
  }

  const staleRows = mainSqlite
    .prepare("SELECT key, project_id FROM project_recent WHERE kind = 'project' AND project_id IS NOT NULL")
    .all() as { key: string; project_id: string }[]

  for (const row of staleRows) {
    if (!existingDbIds.has(row.project_id) || !validWorktreeKeys.has(row.key)) {
      mainSqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
    }
  }
}

function verifyWorkspaceCount(channelDir: string, projectIds: Set<string>, expectedWorkspaces: number): boolean {
  let totalWorkspaces = 0
  for (const pid of projectIds) {
    const pPath = path.join(channelDir, `aether-${pid}.db`)
    if (!existsSync(pPath)) continue
    const pDb = new BunSqlite(pPath)
    const hasWorkspace = pDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'").get()
    if (hasWorkspace) {
      totalWorkspaces += (pDb.prepare("SELECT count(*) as cnt FROM workspace").get() as { cnt: number }).cnt
    }
    pDb.close()
  }
  return totalWorkspaces === expectedWorkspaces
}

describe("workspace data-loss regression tests", () => {
  describe("Fix 1: workspace FK constraint - project row must exist before workspace insert", () => {
    const pid = "proj_fktest001"
    let tmpDir: string
    let projDb: BunSqlite

    beforeEach(() => {
      tmpDir = makeTmpDir()
      projDb = initDb(path.join(tmpDir, `aether-${pid}.db`))
    })

    afterEach(async () => {
      projDb.close()
      await rmTmpDir(tmpDir)
    })

    test("inserting workspace without project row fails due to FK constraint", () => {
      const result = projDb.prepare("SELECT count(*) as cnt FROM project WHERE id = ?").get(pid) as { cnt: number }
      expect(result.cnt).toBe(0)

      projDb.exec("PRAGMA foreign_keys = ON")
      expect(() => {
        projDb
          .prepare(
            "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws_no_project", "worktree", "main", "test", "/tmp/ws", null, pid)
      }).toThrow()

      const ws = projDb.prepare("SELECT count(*) as cnt FROM workspace").get() as { cnt: number }
      expect(ws.cnt).toBe(0)
    })

    test("inserting workspace after upserting project row succeeds", () => {
      projDb.exec("PRAGMA foreign_keys = ON")

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET worktree = excluded.worktree, name = excluded.name, time_updated = excluded.time_updated",
        )
        .run(pid, "/tmp/project", "git", "Test Project", Date.now(), Date.now(), JSON.stringify([]))

      expect(() => {
        projDb
          .prepare(
            "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws_with_project", "worktree", "main", "test", "/tmp/ws", null, pid)
      }).not.toThrow()

      const ws = projDb.prepare("SELECT * FROM workspace WHERE id = ?").get("ws_with_project") as any
      expect(ws).toBeDefined()
      expect(ws.project_id).toBe(pid)
      expect(ws.type).toBe("worktree")
    })

    test("onConflictDoUpdate on existing project row still allows workspace insert", () => {
      projDb.exec("PRAGMA foreign_keys = ON")

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, "/tmp/project-v1", "git", "Project V1", Date.now(), Date.now(), JSON.stringify([]))

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET worktree = excluded.worktree, name = excluded.name, time_updated = excluded.time_updated",
        )
        .run(pid, "/tmp/project-v2", "git", "Project V2", Date.now(), Date.now(), JSON.stringify([]))

      const proj = projDb.prepare("SELECT worktree, name FROM project WHERE id = ?").get(pid) as any
      expect(proj.worktree).toBe("/tmp/project-v2")
      expect(proj.name).toBe("Project V2")

      projDb
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_upsert", "worktree", "main", "test", "/tmp/ws", null, pid)

      const ws = projDb.prepare("SELECT * FROM workspace WHERE id = ?").get("ws_upsert") as any
      expect(ws).toBeDefined()
      expect(ws.project_id).toBe(pid)
    })

    test("FK ON DELETE CASCADE removes workspace rows when project row is deleted", () => {
      projDb.exec("PRAGMA foreign_keys = ON")

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, "/tmp/project", "git", "Test Project", Date.now(), Date.now(), JSON.stringify([]))

      projDb
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_cascade_test", "worktree", "main", "test", "/tmp/ws", null, pid)

      expect((projDb.prepare("SELECT count(*) as cnt FROM workspace").get() as { cnt: number }).cnt).toBe(1)

      projDb.prepare("DELETE FROM project WHERE id = ?").run(pid)

      expect((projDb.prepare("SELECT count(*) as cnt FROM workspace").get() as { cnt: number }).cnt).toBe(0)
    })

    test("workspace insert fails silently when FK enabled but project row missing (regression guard)", () => {
      projDb.exec("PRAGMA foreign_keys = ON")

      const wsCountBefore = (projDb.prepare("SELECT count(*) as cnt FROM workspace").get() as { cnt: number }).cnt

      expect(() => {
        projDb
          .prepare(
            "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("ws_orphan", "worktree", "main", "orphan", "/tmp/orphan", null, pid)
      }).toThrow()

      const wsCountAfter = (projDb.prepare("SELECT count(*) as cnt FROM workspace").get() as { cnt: number }).cnt
      expect(wsCountAfter).toBe(wsCountBefore)
    })
  })

  describe("Fix 2: registerUntrackedProjects preserves workspace worktree paths", () => {
    let tmpDir: string
    let mainDb: BunSqlite
    let channelDirPath: string

    beforeEach(() => {
      tmpDir = makeTmpDir()
      channelDirPath = path.join(tmpDir, "channel")
      mkdirSync(channelDirPath, { recursive: true })
      mainDb = initMainDb(path.join(tmpDir, "aether.db"))
    })

    afterEach(async () => {
      mainDb.close()
      await rmTmpDir(tmpDir)
    })

    test("workspace directory is preserved in project_recent after cleanup", () => {
      const pid = "proj_ws_preserve"
      const projDb = initDb(path.join(channelDirPath, `aether-${pid}.db`))

      const canonicalWorktree = "/tmp/canonical-project-dir"
      const wsDirectory = "/tmp/workspace-worktree-dir"

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, canonicalWorktree, "git", "Project", Date.now(), Date.now(), JSON.stringify([]))

      projDb
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_preserve_test", "worktree", "fix/bug", "preserve-test", wsDirectory, null, pid)

      const wsKey = `dir:${norm(wsDirectory)}`
      const canonicalKey = `dir:${norm(canonicalWorktree)}`

      mainDb
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(wsKey, "project", pid, wsDirectory, Date.now(), Date.now(), Date.now())

      mainDb
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(canonicalKey, "project", pid, canonicalWorktree, Date.now(), Date.now(), Date.now())

      mainDb
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(norm(wsDirectory), pid, Date.now(), Date.now())

      mainDb
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(norm(canonicalWorktree), pid, Date.now(), Date.now())

      projDb.close()

      simulateRegisterUntrackedProjects(mainDb, channelDirPath)

      const rows = mainDb.prepare("SELECT key FROM project_recent WHERE kind = 'project'").all() as { key: string }[]
      const keys = new Set(rows.map((r) => r.key))

      expect(keys.has(wsKey)).toBeTrue()
      expect(keys.has(canonicalKey)).toBeTrue()
    })

    test("project_recent entry for workspace directory would be deleted without workspace row (regression guard)", () => {
      const pid = "proj_ws_no_ws_row"
      const projDb = initDb(path.join(channelDirPath, `aether-${pid}.db`))

      const canonicalWorktree = "/tmp/canonical-only-dir"

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, canonicalWorktree, "git", "Project", Date.now(), Date.now(), JSON.stringify([]))

      const phantomKey = `dir:${norm("/tmp/phantom-worktree-dir")}`
      const canonicalKey = `dir:${norm(canonicalWorktree)}`

      mainDb
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(phantomKey, "project", pid, "/tmp/phantom-worktree-dir", Date.now(), Date.now(), Date.now())

      mainDb
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(canonicalKey, "project", pid, canonicalWorktree, Date.now(), Date.now(), Date.now())

      mainDb
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(norm(canonicalWorktree), pid, Date.now(), Date.now())

      projDb.close()

      simulateRegisterUntrackedProjects(mainDb, channelDirPath)

      const rows = mainDb.prepare("SELECT key FROM project_recent WHERE kind = 'project'").all() as { key: string }[]
      const keys = new Set(rows.map((r) => r.key))

      expect(keys.has(canonicalKey)).toBeTrue()
      expect(keys.has(phantomKey)).toBeFalse()
    })

    test("multiple workspace directories are all preserved", () => {
      const pid = "proj_multi_ws"
      const projDb = initDb(path.join(channelDirPath, `aether-${pid}.db`))

      const canonicalWorktree = "/tmp/multi-canonical"
      const wsDirs = ["/tmp/ws-alpha", "/tmp/ws-beta"]

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, canonicalWorktree, "git", "MultiWS", Date.now(), Date.now(), JSON.stringify([]))

      for (let i = 0; i < wsDirs.length; i++) {
        projDb
          .prepare(
            "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(`ws_multi_${i}`, "worktree", `fix/${i}`, `ws-${i}`, wsDirs[i], null, pid)
      }

      const allKeys = [`dir:${norm(canonicalWorktree)}`, ...wsDirs.map((d) => `dir:${norm(d)}`)]
      for (const key of allKeys) {
        const dir = key.replace(/^dir:/, "")
        mainDb
          .prepare(
            "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(key, "project", pid, dir, Date.now(), Date.now(), Date.now())
        mainDb
          .prepare(
            "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
          )
          .run(norm(dir), pid, Date.now(), Date.now())
      }

      projDb.close()

      simulateRegisterUntrackedProjects(mainDb, channelDirPath)

      const rows = mainDb.prepare("SELECT key FROM project_recent WHERE kind = 'project'").all() as { key: string }[]
      const keys = new Set(rows.map((r) => r.key))

      for (const key of allKeys) {
        expect(keys.has(key)).toBeTrue()
      }
    })

    test("workspace with null directory is not added to validWorktreeKeys", () => {
      const pid = "proj_null_dir"
      const projDb = initDb(path.join(channelDirPath, `aether-${pid}.db`))

      const canonicalWorktree = "/tmp/null-dir-canonical"

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, canonicalWorktree, "git", "NullDirProject", Date.now(), Date.now(), JSON.stringify([]))

      projDb
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_null_dir", "worktree", "main", "null-dir-ws", null, null, pid)

      projDb.close()

      const canonicalKey = `dir:${norm(canonicalWorktree)}`

      mainDb
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(canonicalKey, "project", pid, canonicalWorktree, Date.now(), Date.now(), Date.now())

      mainDb
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(norm(canonicalWorktree), pid, Date.now(), Date.now())

      simulateRegisterUntrackedProjects(mainDb, channelDirPath)

      const rows = mainDb.prepare("SELECT key FROM project_recent WHERE kind = 'project'").all() as { key: string }[]
      const keys = new Set(rows.map((r) => r.key))

      expect(keys.has(canonicalKey)).toBeTrue()
    })
  })

  describe("Fix 4: split migration verification includes workspace count", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = makeTmpDir()
    })

    afterEach(async () => {
      await rmTmpDir(tmpDir)
    })

    test("workspace count mismatch is detected by verification logic", () => {
      const pid = "proj_verify_ws"
      const channelDir = path.join(tmpDir, "channel")
      mkdirSync(channelDir, { recursive: true })

      const projDb = initDb(path.join(channelDir, `aether-${pid}.db`))

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, "/tmp/verify-project", "git", "VerifyProject", Date.now(), Date.now(), JSON.stringify([]))

      projDb
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_verify_1", "worktree", "main", "verify-ws-1", "/tmp/ws1", null, pid)

      projDb
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_verify_2", "worktree", "fix/bug", "verify-ws-2", "/tmp/ws2", null, pid)

      projDb.close()

      expect(verifyWorkspaceCount(channelDir, new Set([pid]), 2)).toBeTrue()
      expect(verifyWorkspaceCount(channelDir, new Set([pid]), 3)).toBeFalse()
    })

    test("verification passes when workspace count matches exactly", () => {
      const pid = "proj_verify_ok"
      const channelDir = path.join(tmpDir, "channel")
      mkdirSync(channelDir, { recursive: true })

      const projDb = initDb(path.join(channelDir, `aether-${pid}.db`))

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, "/tmp/verify-ok", "git", "OKProject", Date.now(), Date.now(), JSON.stringify([]))

      projDb
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_ok_1", "worktree", "main", "ok-ws", "/tmp/ws-ok", null, pid)

      projDb.close()

      expect(verifyWorkspaceCount(channelDir, new Set([pid]), 1)).toBeTrue()
    })

    test("verification handles project DB without workspace table gracefully", () => {
      const pid = "proj_no_ws_table"
      const channelDir = path.join(tmpDir, "channel")
      mkdirSync(channelDir, { recursive: true })

      const projDb = initDbWithoutWorkspace(path.join(channelDir, `aether-${pid}.db`))

      projDb
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid, "/tmp/no-ws-project", "git", "NoWSProject", Date.now(), Date.now(), JSON.stringify([]))

      projDb.close()

      expect(verifyWorkspaceCount(channelDir, new Set([pid]), 0)).toBeTrue()
    })

    test("workspace rows are counted across multiple project DBs", () => {
      const channelDir = path.join(tmpDir, "channel")
      mkdirSync(channelDir, { recursive: true })

      const pid1 = "proj_multi_1"
      const pid2 = "proj_multi_2"

      const projDb1 = initDb(path.join(channelDir, `aether-${pid1}.db`))
      projDb1
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid1, "/tmp/multi-1", "git", "Multi1", Date.now(), Date.now(), JSON.stringify([]))
      projDb1
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_m1_a", "worktree", "main", "m1-a", "/tmp/ws-m1-a", null, pid1)
      projDb1
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_m1_b", "worktree", "fix/1", "m1-b", "/tmp/ws-m1-b", null, pid1)
      projDb1.close()

      const projDb2 = initDb(path.join(channelDir, `aether-${pid2}.db`))
      projDb2
        .prepare(
          "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(pid2, "/tmp/multi-2", "git", "Multi2", Date.now(), Date.now(), JSON.stringify([]))
      projDb2
        .prepare(
          "INSERT INTO workspace (id, type, branch, name, directory, extra, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("ws_m2_a", "worktree", "main", "m2-a", "/tmp/ws-m2-a", null, pid2)
      projDb2.close()

      expect(verifyWorkspaceCount(channelDir, new Set([pid1, pid2]), 3)).toBeTrue()
      expect(verifyWorkspaceCount(channelDir, new Set([pid1, pid2]), 2)).toBeFalse()
    })
  })
})
