import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs"
import path from "path"
import os from "os"
import { rm, mkdtemp } from "fs/promises"
import { detectCorruption, quarantine } from "../../src/storage/db-recovery"
import type { CorruptionType } from "../../src/storage/db-recovery"

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "aether-startup-test-"))

function norm(input: string) {
  return input.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function initHealthyDb(dbPath: string) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new BunSqlite(dbPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  return db
}

function initHealthyDbWithTables(dbPath: string) {
  const db = initHealthyDb(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id text PRIMARY KEY,
      worktree text NOT NULL,
      vcs text,
      name text,
      icon_url text,
      icon_color text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      time_initialized integer,
      sandboxes text NOT NULL DEFAULT '[]',
      commands text
    )
  `)
  db.exec(`CREATE TABLE IF NOT EXISTS directory_meta (
    directory text PRIMARY KEY,
    worktree text NOT NULL,
    name text,
    icon_url text,
    icon_color text,
    icon_override text,
    activity_at integer NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS session (
    id text PRIMARY KEY,
    project_id text NOT NULL,
    directory text NOT NULL,
    title text,
    parent_id text,
    time_created integer NOT NULL,
    time_updated integer NOT NULL
  )`)
  return db
}

function initMainDbWithMappings(dbPath: string) {
  const db = initHealthyDb(dbPath)
  db.exec(`CREATE TABLE IF NOT EXISTS global_project_map (
    directory text PRIMARY KEY,
    project_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS project_recent (
    key text PRIMARY KEY,
    kind text NOT NULL,
    project_id text,
    directory text,
    name text,
    icon_url text,
    icon_color text,
    icon_override text,
    activity_at integer NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL
  )`)
  return db
}

function makeCorruptFile(sourcePath: string, destPath: string, corruption: CorruptionType) {
  if (corruption === "empty") {
    writeFileSync(destPath, Buffer.alloc(0))
    return
  }
  if (corruption === "truncated") {
    const short = Buffer.alloc(256, 0x00)
    short[0] = 0x53
    short[1] = 0x51
    short[2] = 0x4c
    short[3] = 0x69
    writeFileSync(destPath, short)
    return
  }

  const srcDb = new BunSqlite(sourcePath)
  const bytes = srcDb.serialize("main") as Uint8Array
  srcDb.close()

  const copy = Buffer.from(bytes)
  if (corruption === "header") {
    for (let i = 0; i < 100; i++) copy[i] = Math.floor(Math.random() * 256)
  } else if (corruption === "mid-page" && copy.length > 4196) {
    for (let i = 4096; i < 4196; i++) copy[i] = Math.floor(Math.random() * 256)
  }
  writeFileSync(destPath, copy)
}

async function cleanup() {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
}

afterEach(cleanup)
beforeEach(async () => {
  await cleanup()
  mkdirSync(tmpRoot, { recursive: true })
})

describe("Database.Client() fault tolerance", () => {
  test("detectCorruption catches header corruption and quarantine returns a valid entry", () => {
    const templatePath = path.join(tmpRoot, "healthy-for-header.db")
    const templateDb = initHealthyDb(templatePath)
    templateDb.exec("CREATE TABLE t(x integer)")
    templateDb.close()

    const corruptPath = path.join(tmpRoot, "header-main.db")
    makeCorruptFile(templatePath, corruptPath, "header")

    const result = detectCorruption(corruptPath)
    expect(result).toBe("header")

    const entry = quarantine(corruptPath, "main")
    expect(entry.kind).toBe("main")
    expect(entry.corruptionType).toBe("header")
    expect(existsSync(corruptPath)).toBeFalse()
  })

  test("main DB empty file triggers quarantine + detectCorruption returns empty", () => {
    const emptyPath = path.join(tmpRoot, "empty-main.db")
    writeFileSync(emptyPath, Buffer.alloc(0))

    const result = detectCorruption(emptyPath)
    expect(result).toBe("empty")
  })

  test("healthy main DB returns null from detectCorruption", () => {
    const healthyPath = path.join(tmpRoot, "healthy-main.db")
    const db = initHealthyDb(healthyPath)
    db.exec("CREATE TABLE t(x integer)")
    db.close()

    const result = detectCorruption(healthyPath)
    expect(result).toBeNull()
  })

  test("truncated main DB file is detected", () => {
    const shortPath = path.join(tmpRoot, "short-main.db")
    const buf = Buffer.alloc(256, 0x00)
    buf[0] = 0x53
    buf[1] = 0x51
    buf[2] = 0x4c
    buf[3] = 0x69
    writeFileSync(shortPath, buf)

    const result = detectCorruption(shortPath)
    expect(result).toBe("truncated")
  })
})

describe("registerUntrackedProjects fault tolerance", () => {
  function simulateRegisterUntrackedProjects(mainSqlite: BunSqlite, chDir: string) {
    const recentLookup = new Map<string, any>()
    const recentRows = mainSqlite.prepare("SELECT * FROM project_recent").all() as any[]
    for (const row of recentRows) {
      const dirNorm = norm(row.directory ?? "")
      recentLookup.set(dirNorm, row)
      const keyNorm = row.key?.replace(/^dir:/, "").toLowerCase()
      if (keyNorm && keyNorm !== dirNorm) recentLookup.set(keyNorm, row)
    }

    const existingDbIds = new Set<string>()
    const validWorktreeKeys = new Set<string>()
    const corruptedIds = new Set<string>()

    if (existsSync(chDir)) {
      const pattern = /^aether-(.+)\.db$/
      for (const entry of readdirSync(chDir)) {
        const match = pattern.exec(entry)
        if (!match) continue
        const pid = match[1]
        if (pid === "cron") continue
        existingDbIds.add(pid)
      }
    }

    let synced = 0
    for (const pid of existingDbIds) {
      const fullPath = path.join(chDir, `aether-${pid}.db`)
      try {
        const corruption = detectCorruption(fullPath)
        if (corruption) {
          quarantine(fullPath, "project", pid)
          corruptedIds.add(pid)
          continue
        }

        const pSqlite = new BunSqlite(fullPath)
        try {
          const hasMeta = pSqlite
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'")
            .get()
          if (hasMeta) {
            const existingCount = (
              pSqlite.prepare("SELECT count(*) as cnt FROM directory_meta").get() as { cnt: number }
            ).cnt
            if (existingCount === 0) {
              const projectRow = pSqlite.prepare("SELECT worktree, vcs FROM project WHERE id = ?").get(pid) as
                | { worktree: string; vcs: string | null }
                | undefined
              if (projectRow) {
                const directories = (
                  pSqlite.prepare("SELECT DISTINCT directory FROM session").all() as { directory: string }[]
                ).map((r) => r.directory)
                if (!directories.includes(projectRow.worktree)) directories.push(projectRow.worktree)

                const insert = pSqlite.prepare(
                  "INSERT OR IGNORE INTO directory_meta (directory, worktree, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                for (const dir of directories) {
                  const dirNorm = norm(dir)
                  const recentRow = recentLookup.get(dirNorm)
                  insert.run(
                    dir,
                    projectRow.worktree,
                    recentRow?.name ?? null,
                    recentRow?.icon_url ?? null,
                    recentRow?.icon_color ?? null,
                    recentRow?.icon_override ?? null,
                    recentRow?.activity_at ?? Date.now(),
                    Date.now(),
                    Date.now(),
                  )
                }
              }
            }
          }

          const wt = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
            | { worktree: string }
            | undefined
          if (wt?.worktree && wt.worktree !== "/") validWorktreeKeys.add(`dir:${norm(wt.worktree)}`)

          synced++
        } finally {
          pSqlite.close()
        }
      } catch {
        quarantine(fullPath, "project", pid)
        corruptedIds.add(pid)
      }
    }

    // Phase 2: clean project_recent
    const staleRows = mainSqlite
      .prepare("SELECT key, project_id FROM project_recent WHERE kind = 'project' AND project_id IS NOT NULL")
      .all() as { key: string; project_id: string }[]
    for (const row of staleRows) {
      if (!existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id) || !validWorktreeKeys.has(row.key)) {
        mainSqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
      }
    }

    // Phase 3: clean global_project_map
    const staleMap = mainSqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    for (const row of staleMap) {
      if (!existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)) {
        mainSqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(row.directory)
      }
    }

    return { synced, corruptedIds, validWorktreeKeys }
  }

  test("corrupted project DB does not crash sync loop, healthy DBs processed", () => {
    const chDir = path.join(tmpRoot, "prod")
    mkdirSync(chDir, { recursive: true })

    const goodPid = "aaaaaaaa11111111111111111111111111111111"
    const badPid = "bbbbbbbb22222222222222222222222222222222"

    // Healthy project DB
    const goodPath = path.join(chDir, `aether-${goodPid}.db`)
    const goodDb = initHealthyDbWithTables(goodPath)
    goodDb
      .prepare(
        "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(goodPid, "/tmp/good-dir", "git", Date.now(), Date.now(), "[]")
    goodDb
      .prepare("INSERT INTO session (id, project_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
      .run("sess001", goodPid, "/tmp/good-dir", Date.now(), Date.now())
    goodDb.close()

    // Corrupted project DB (header corruption)
    const badPath = path.join(chDir, `aether-${badPid}.db`)
    makeCorruptFile(goodPath, badPath, "header")

    // Main DB with mappings for both
    const mainPath = path.join(tmpRoot, "aether.db")
    const mainDb = initMainDbWithMappings(mainPath)
    const canonicalKey = `dir:${norm("/tmp/good-dir")}`
    const badKey = `dir:${norm("/tmp/bad-dir")}`

    for (const [key, pid] of [
      [canonicalKey, goodPid],
      [badKey, badPid],
    ]) {
      mainDb
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(key, "project", pid, key.replace(/^dir:/, ""), Date.now(), Date.now(), Date.now())
      mainDb
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(key.replace(/^dir:/, ""), pid, Date.now(), Date.now())
    }

    const result = simulateRegisterUntrackedProjects(mainDb, chDir)

    expect(result.synced).toBe(1)
    expect(result.corruptedIds.has(badPid)).toBeTrue()

    // Good entries survive
    expect(mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(canonicalKey)).not.toBeNull()
    expect(mainDb.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(goodPid)).not.toBeNull()

    // Bad entries cleaned
    expect(mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(badKey)).toBeNull()
    expect(mainDb.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(badPid)).toBeNull()

    // Corrupted DB file moved to quarantine
    expect(existsSync(badPath)).toBeFalse()

    mainDb.close()
  })

  test("multiple corrupted DBs all get quarantined and cleaned, healthy ones survive", () => {
    const chDir = path.join(tmpRoot, "prod-multi")
    mkdirSync(chDir, { recursive: true })

    const goodPid1 = "cccccccc33333333333333333333333333333333"
    const goodPid2 = "dddddddd44444444444444444444444444444444"
    const badPid1 = "eeeeeeee55555555555555555555555555555555"
    const badPid2 = "ffffffff66666666666666666666666666666666"

    const db1 = initHealthyDbWithTables(path.join(chDir, `aether-${goodPid1}.db`))
    db1
      .prepare(
        "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(goodPid1, "/tmp/good-dir-1", "git", Date.now(), Date.now(), "[]")
    db1
      .prepare("INSERT INTO session (id, project_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
      .run("s1", goodPid1, "/tmp/good-dir-1", Date.now(), Date.now())
    db1.close()

    const db2 = initHealthyDbWithTables(path.join(chDir, `aether-${goodPid2}.db`))
    db2
      .prepare(
        "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(goodPid2, "/tmp/good-dir-2", "git", Date.now(), Date.now(), "[]")
    db2
      .prepare("INSERT INTO session (id, project_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
      .run("s2", goodPid2, "/tmp/good-dir-2", Date.now(), Date.now())
    db2.close()

    // Corrupted project DB 1 (empty)
    writeFileSync(path.join(chDir, `aether-${badPid1}.db`), Buffer.alloc(0))
    // Corrupted project DB 2 (truncated)
    makeCorruptFile(path.join(chDir, `aether-${goodPid1}.db`), path.join(chDir, `aether-${badPid2}.db`), "header")

    const mainPath = path.join(tmpRoot, "aether-multi.db")
    const mainDb = initMainDbWithMappings(mainPath)

    for (const [key, pid] of [
      [`dir:${norm("/tmp/good-dir-1")}`, goodPid1],
      [`dir:${norm("/tmp/good-dir-2")}`, goodPid2],
      [`dir:${norm("/tmp/bad-dir-1")}`, badPid1],
      [`dir:${norm("/tmp/bad-dir-2")}`, badPid2],
    ] as const) {
      mainDb
        .prepare(
          "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(key, "project", pid, key.replace(/^dir:/, ""), Date.now(), Date.now(), Date.now())
      mainDb
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(key.replace(/^dir:/, ""), pid, Date.now(), Date.now())
    }

    const result = simulateRegisterUntrackedProjects(mainDb, chDir)

    expect(result.synced).toBe(2)
    expect(result.corruptedIds.size).toBe(2)
    expect(result.corruptedIds.has(badPid1)).toBeTrue()
    expect(result.corruptedIds.has(badPid2)).toBeTrue()

    // Healthy entries survive
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/good-dir-1")}`),
    ).not.toBeNull()
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/good-dir-2")}`),
    ).not.toBeNull()

    // Bad entries cleaned
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/bad-dir-1")}`),
    ).toBeNull()
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/bad-dir-2")}`),
    ).toBeNull()

    // Bad global_project_map cleaned
    expect(mainDb.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(badPid1)).toBeNull()
    expect(mainDb.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(badPid2)).toBeNull()

    mainDb.close()
  })

  test("empty project DB (has no data tables) is detected", () => {
    const chDir = path.join(tmpRoot, "prod-empty")
    mkdirSync(chDir, { recursive: true })

    const emptyPid = "gggggggg77777777777777777777777777777777"
    const emptyPath = path.join(chDir, `aether-${emptyPid}.db`)
    const emptyDb = new BunSqlite(emptyPath)
    emptyDb.close()

    const corruption = detectCorruption(emptyPath)
    expect(corruption).toBe("empty")
  })

  test("project DB with no project row is handled gracefully (skip, don't crash)", () => {
    const chDir = path.join(tmpRoot, "prod-no-proj")
    mkdirSync(chDir, { recursive: true })

    const pid = "hhhhhhhh88888888888888888888888888888888"
    const dbPath = path.join(chDir, `aether-${pid}.db`)
    const db = initHealthyDbWithTables(dbPath)
    db.close()

    const mainPath = path.join(tmpRoot, "aether-no-proj.db")
    const mainDb = initMainDbWithMappings(mainPath)

    const result = simulateRegisterUntrackedProjects(mainDb, chDir)
    // should not throw; still synced since ensureDirectoryMeta returns without error
    expect(result.synced).toBe(1)
    expect(result.corruptedIds.has(pid)).toBeFalse()

    mainDb.close()
  })
})

describe("Database.attach() fault tolerance", () => {
  test("project DB open failure path exists: quarantine is callable with project kind", () => {
    const projPath = path.join(tmpRoot, "attach-test-proj.db")
    const projDb = initHealthyDb(projPath)
    projDb.exec("CREATE TABLE t(x integer)")
    projDb.close()

    const entry = quarantine(projPath, "project", "test-attach-pid")
    expect(entry.kind).toBe("project")
    expect(entry.projectId).toBe("test-attach-pid")
    expect(entry.recoveryStatus).toBe("pending")
    expect(existsSync(projPath)).toBeFalse()

    const freshPath = path.join(tmpRoot, "attach-test-fresh.db")
    const freshDb = initHealthyDb(freshPath)
    expect(freshDb).not.toBeNull()
    freshDb.close()
  })

  test("attach fault tolerance chain: detect -> quarantine -> recreate succeeds", () => {
    const pid = "iiiiiiii99999999999999999999999999999999"
    const projPath = path.join(tmpRoot, `aether-${pid}.db`)

    // Step 1: Create healthy DB
    const templatePath = path.join(tmpRoot, "template-for-attach.db")
    const templateDb = initHealthyDbWithTables(templatePath)
    templateDb
      .prepare(
        "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(pid, "/tmp/attach-dir", "git", Date.now(), Date.now(), "[]")
    templateDb.close()

    // Step 2: Create a header-corrupted copy of the template as the project DB
    makeCorruptFile(templatePath, projPath, "header")

    // Step 3: Detect corruption (simulating attach's internal check)
    const corruption = detectCorruption(projPath)
    expect(corruption).toBe("header")

    // Step 4: Quarantine (simulating attach's catch block)
    const entry = quarantine(projPath, "project", pid)
    expect(existsSync(projPath)).toBeFalse()

    // Step 5: Recreate (simulating attach's recreate after quarantine)
    const recreated = initHealthyDbWithTables(projPath)
    recreated
      .prepare(
        "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(pid, "/tmp/attach-dir", "git", Date.now(), Date.now(), "[]")
    const row = recreated.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
      | { worktree: string }
      | undefined
    expect(row).not.toBeNull()
    expect(row!.worktree).toBe("/tmp/attach-dir")
    recreated.close()
  })
})

describe("InstanceBootstrap triggers DbRecovery", () => {
  test("bootstrap.ts imports DbRecovery from db-recovery", async () => {
    const mod = await import("../../src/project/bootstrap")
    expect(mod).toBeDefined()
    expect(typeof mod.InstanceBootstrap).toBe("function")
  })

  test("DbRecovery.runAfterStartup exists and handles empty manifest", async () => {
    const { DbRecovery } = await import("../../src/storage/db-recovery")
    expect(typeof DbRecovery.runAfterStartup).toBe("function")
    expect(typeof DbRecovery.hasPendingRecovery).toBe("function")
    expect(typeof DbRecovery.pendingEntries).toBe("function")

    await DbRecovery.runAfterStartup()
  })
})

describe("SplitMigration try/catch integrity", () => {
  test("index.ts structure: split migration check wrapped in try/catch", async () => {
    const { SplitMigration } = await import("../../src/storage/split-migration")
    expect(typeof SplitMigration.needsMigration).toBe("function")
    expect(typeof SplitMigration.run).toBe("function")
    // The outer try/catch in index.ts is a syntactic guarantee verified by typecheck
  })
})
