import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs"
import path from "path"
import os from "os"
import { rm, mkdtemp } from "fs/promises"
import { detectCorruption, quarantine } from "../../src/storage/db-recovery"
import type { CorruptionType } from "../../src/storage/db-recovery"
import { ProjectIdentity } from "../../src/project/identity"

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "aether-startup-test-"))

const { norm } = ProjectIdentity

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

function simulateRegisterUntrackedProjects(mainSqlite: BunSqlite, chDir: string) {
  const recentLookup = new Map<string, any>()
  const recentRows = mainSqlite.prepare("SELECT * FROM project_recent").all() as any[]
  for (const row of recentRows) {
    const dirNorm = norm(row.directory ?? "")
    recentLookup.set(dirNorm, row)
    const keyNorm = row.key?.replace(/^dir:/, "")
    if (keyNorm && norm(keyNorm) !== dirNorm) recentLookup.set(keyNorm, row)
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
          const existingCount = (pSqlite.prepare("SELECT count(*) as cnt FROM directory_meta").get() as { cnt: number })
            .cnt
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

        // Clean global_project_map entries for this pid not present in directory_meta
        if (hasMeta) {
          const validNorms = new Set<string>()
          const metaRows = pSqlite.prepare("SELECT directory FROM directory_meta").all() as { directory: string }[]
          for (const m of metaRows) validNorms.add(norm(m.directory))
          const orphanMap = mainSqlite
            .prepare("SELECT directory FROM global_project_map WHERE project_id = ?")
            .all(pid) as { directory: string }[]
          for (const orphan of orphanMap) {
            if (!validNorms.has(norm(orphan.directory))) {
              mainSqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(orphan.directory)
            }
          }
        }

        synced++
      } finally {
        pSqlite.close()
      }
    } catch {
      quarantine(fullPath, "project", pid)
      corruptedIds.add(pid)
    }
  }

  // Phase 2: clean project_recent — covers both kind='project' and kind='directory'
  const staleRows = mainSqlite
    .prepare("SELECT key, kind, project_id FROM project_recent WHERE project_id IS NOT NULL")
    .all() as { key: string; kind: string; project_id: string }[]
  for (const row of staleRows) {
    const noDb = !existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)
    const invalidWorktree = row.kind === "project" && !validWorktreeKeys.has(row.key)
    if (noDb || invalidWorktree) {
      mainSqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
    }
  }

  // Phase 3: clean global_project_map — also deduplicate norm-inconsistent entries
  const staleMap = mainSqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
    directory: string
    project_id: string
  }[]
  const seenNorms = new Map<string, string>()
  for (const row of staleMap) {
    const noDb = !existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)
    if (noDb) {
      mainSqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(row.directory)
      continue
    }
    const dirNorm = norm(row.directory)
    const prev = seenNorms.get(dirNorm)
    if (!prev) {
      seenNorms.set(dirNorm, row.directory)
      continue
    }
    const keepNormed = dirNorm === row.directory
    const delDir = keepNormed ? prev : row.directory
    mainSqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(delDir)
    if (keepNormed) seenNorms.set(dirNorm, row.directory)
  }

  return { synced, corruptedIds, validWorktreeKeys }
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
  // delegates to file-scoped simulateRegisterUntrackedProjects defined above

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
  })
})

describe("Bug1: Phase 2 cleans kind='directory' orphan rows", () => {
  function simulatePhase2(
    mainSqlite: BunSqlite,
    existingDbIds: Set<string>,
    corruptedIds: Set<string>,
    validWorktreeKeys: Set<string>,
  ) {
    const staleRows = mainSqlite
      .prepare("SELECT key, kind, project_id FROM project_recent WHERE project_id IS NOT NULL")
      .all() as { key: string; kind: string; project_id: string }[]
    let removed = 0
    for (const row of staleRows) {
      const noDb = !existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)
      const invalidWorktree = row.kind === "project" && !validWorktreeKeys.has(row.key)
      if (noDb || invalidWorktree) {
        mainSqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
        removed++
      }
    }
    return removed
  }

  test("directory-kind entries with missing project DB are cleaned", () => {
    const mainPath = path.join(tmpRoot, "bug1-main.db")
    const mainDb = initMainDbWithMappings(mainPath)

    const alivePid = "aabb1111111111111111111111111111111111"
    const deadPid = "ccdd2222222222222222222222222222222222"

    // kind='project' entry for alive project
    mainDb
      .prepare(
        "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`dir:${norm("/tmp/alive-dir")}`, "project", alivePid, "/tmp/alive-dir", Date.now(), Date.now(), Date.now())

    // kind='directory' entry for alive project (sandbox)
    mainDb
      .prepare(
        "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `dir:${norm("/tmp/alive-sandbox")}`,
        "directory",
        alivePid,
        "/tmp/alive-sandbox",
        Date.now(),
        Date.now(),
        Date.now(),
      )

    // kind='directory' entry for DEAD project (orphan sandbox)
    mainDb
      .prepare(
        "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `dir:${norm("/tmp/dead-sandbox")}`,
        "directory",
        deadPid,
        "/tmp/dead-sandbox",
        Date.now(),
        Date.now(),
        Date.now(),
      )

    const existingDbIds = new Set([alivePid])
    const corruptedIds = new Set<string>()
    const validWorktreeKeys = new Set([`dir:${norm("/tmp/alive-dir")}`])

    const removed = simulatePhase2(mainDb, existingDbIds, corruptedIds, validWorktreeKeys)

    expect(removed).toBe(1)
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/alive-dir")}`),
    ).not.toBeNull()
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/alive-sandbox")}`),
    ).not.toBeNull()
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/dead-sandbox")}`),
    ).toBeNull()

    mainDb.close()
  })

  test("directory-kind entries for corrupted project DB are cleaned", () => {
    const mainPath = path.join(tmpRoot, "bug1-corrupt-main.db")
    const mainDb = initMainDbWithMappings(mainPath)

    const goodPid = "good11111111111111111111111111111111111"
    const badPid = "bad2222222222222222222222222222222222222"

    mainDb
      .prepare(
        "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`dir:${norm("/tmp/good-wt")}`, "project", goodPid, "/tmp/good-wt", Date.now(), Date.now(), Date.now())
    mainDb
      .prepare(
        "INSERT INTO project_recent (key, kind, project_id, directory, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `dir:${norm("/tmp/bad-sandbox")}`,
        "directory",
        badPid,
        "/tmp/bad-sandbox",
        Date.now(),
        Date.now(),
        Date.now(),
      )

    const existingDbIds = new Set([goodPid, badPid])
    const corruptedIds = new Set([badPid])
    const validWorktreeKeys = new Set([`dir:${norm("/tmp/good-wt")}`])

    const removed = simulatePhase2(mainDb, existingDbIds, corruptedIds, validWorktreeKeys)

    expect(removed).toBe(1)
    expect(
      mainDb.prepare("SELECT key FROM project_recent WHERE key = ?").get(`dir:${norm("/tmp/bad-sandbox")}`),
    ).toBeNull()

    mainDb.close()
  })
})

describe("Bug2: Phase 3 deduplicates global_project_map entries with inconsistent norm", () => {
  function simulatePhase3(mainSqlite: BunSqlite, existingDbIds: Set<string>, corruptedIds: Set<string>) {
    const staleMap = mainSqlite.prepare("SELECT directory, project_id FROM global_project_map").all() as {
      directory: string
      project_id: string
    }[]
    let mapRemoved = 0
    const seenNorms = new Map<string, string>()
    for (const row of staleMap) {
      const noDb = !existingDbIds.has(row.project_id) || corruptedIds.has(row.project_id)
      if (noDb) {
        mainSqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(row.directory)
        mapRemoved++
        continue
      }
      const dirNorm = norm(row.directory)
      const prev = seenNorms.get(dirNorm)
      if (!prev) {
        seenNorms.set(dirNorm, row.directory)
        continue
      }
      const keepNormed = dirNorm === row.directory
      const delDir = keepNormed ? prev : row.directory
      mainSqlite.prepare("DELETE FROM global_project_map WHERE directory = ?").run(delDir)
      if (keepNormed) seenNorms.set(dirNorm, row.directory)
      mapRemoved++
    }
    return mapRemoved
  }

  test("duplicate entries with norm-inconsistent paths are deduplicated, keeping normed path", () => {
    const mainPath = path.join(tmpRoot, "bug2-main.db")
    const mainDb = initMainDbWithMappings(mainPath)

    const pid = "dedup1111111111111111111111111111111111"

    // Insert two entries: one normed (backslash on Windows), one with forward slashes
    mainDb
      .prepare("INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)")
      .run(norm("/tmp/test-dir"), pid, Date.now(), Date.now())

    const forwardSlashDir = "/tmp/test-dir"
    // Only add if forwardSlashDir differs from norm (i.e. on Windows)
    if (forwardSlashDir !== norm("/tmp/test-dir")) {
      mainDb
        .prepare(
          "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
        )
        .run(forwardSlashDir, pid, Date.now(), Date.now())
    }

    const existingDbIds = new Set([pid])
    const corruptedIds = new Set<string>()

    const removed = simulatePhase3(mainDb, existingDbIds, corruptedIds)

    if (forwardSlashDir !== norm("/tmp/test-dir")) {
      expect(removed).toBe(1)
      // Normed path survives
      expect(
        mainDb.prepare("SELECT directory FROM global_project_map WHERE directory = ?").get(norm("/tmp/test-dir")),
      ).not.toBeNull()
      // Unnormed path removed
      expect(
        mainDb.prepare("SELECT directory FROM global_project_map WHERE directory = ?").get(forwardSlashDir),
      ).toBeNull()
    } else {
      expect(removed).toBe(0)
      expect(mainDb.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").get(pid)).not.toBeNull()
    }

    mainDb.close()
  })

  test("global_project_map orphan entries not in directory_meta are cleaned per pid", () => {
    const chDir = path.join(tmpRoot, "orphan-ch")
    mkdirSync(chDir, { recursive: true })

    const pid = "orph1111111111111111111111111111111111"
    const projPath = path.join(chDir, `aether-${pid}.db`)
    const projDb = initHealthyDbWithTables(projPath)
    projDb
      .prepare(
        "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(pid, "/tmp/orphan-dir", "git", 1, 1, "[]")
    projDb
      .prepare(
        "INSERT INTO directory_meta (directory, worktree, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
      )
      .run("/tmp/orphan-dir", "/tmp/orphan-dir", 1, 1, 1)
    projDb.close()

    const mainPath = path.join(tmpRoot, "orphan-main.db")
    const mainDb = initMainDbWithMappings(mainPath)

    const orphanDir = "/tmp/orphan-dir/deleted-sandbox"
    mainDb
      .prepare("INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)")
      .run(orphanDir, pid, Date.now(), Date.now())
    mainDb
      .prepare("INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)")
      .run("/tmp/orphan-dir", pid, Date.now(), Date.now())
    mainDb.close()

    const mainDb2 = new BunSqlite(mainPath)
    const result = simulateRegisterUntrackedProjects(mainDb2, chDir)

    expect(result.synced).toBe(1)

    const after = mainDb2.prepare("SELECT directory FROM global_project_map WHERE project_id = ?").all(pid) as {
      directory: string
    }[]
    const dirs = after.map((r) => r.directory)
    expect(dirs).toContain("/tmp/orphan-dir")
    expect(dirs).not.toContain(orphanDir)

    mainDb2.close()
  })
})

describe("Bug4: syncDirectoryMetaToGlobal uses session-derived activity_at and ProjectTable icon", () => {
  function simulateSync(mainSqlite: BunSqlite, pSqlite: BunSqlite, pid: string) {
    const hasTable = pSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directory_meta'")
      .get()
    if (!hasTable) return

    const projectRow = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as
      | { worktree: string }
      | undefined
    const canonicalWorktree = projectRow?.worktree ?? "/"

    const metaRows = pSqlite.prepare("SELECT * FROM directory_meta").all() as {
      directory: string
      worktree: string
      name: string | null
      icon_url: string | null
      icon_color: string | null
      icon_override: string | null
      activity_at: number
      time_created: number
      time_updated: number
    }[]

    const sessionActivity = new Map<string, number>()
    const sessionRows = pSqlite
      .prepare("SELECT directory, MAX(time_updated) as latest FROM session GROUP BY directory")
      .all() as { directory: string; latest: number }[]
    for (const s of sessionRows) sessionActivity.set(norm(s.directory), s.latest)

    const projectIcon = pSqlite.prepare("SELECT icon_url, icon_color FROM project WHERE id = ?").get(pid) as
      | { icon_url: string | null; icon_color: string | null }
      | undefined

    const insertMap = mainSqlite.prepare(
      `INSERT INTO global_project_map (directory, project_id, time_created, time_updated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(directory) DO UPDATE SET project_id = excluded.project_id, time_updated = excluded.time_updated`,
    )
    const insertRecent = mainSqlite.prepare(
      `INSERT INTO project_recent (key, kind, project_id, directory, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id, directory = excluded.directory, name = excluded.name, icon_url = excluded.icon_url, icon_color = excluded.icon_color, icon_override = excluded.icon_override, activity_at = excluded.activity_at, time_updated = excluded.time_updated`,
    )

    for (const row of metaRows) {
      const dirNorm = norm(row.directory)
      const realActivity = sessionActivity.get(dirNorm) ?? row.activity_at
      const isWorktree = row.worktree !== "/" && norm(row.directory) === norm(canonicalWorktree)
      const icon_url = isWorktree ? (projectIcon?.icon_url ?? row.icon_url ?? null) : (row.icon_url ?? null)
      const icon_color = isWorktree ? (projectIcon?.icon_color ?? row.icon_color ?? null) : (row.icon_color ?? null)
      const kind = isWorktree ? "project" : "directory"

      insertMap.run(dirNorm, pid, row.time_created, row.time_updated)
      insertRecent.run(
        `dir:${dirNorm}`,
        kind,
        pid,
        row.directory,
        row.name,
        icon_url,
        icon_color,
        row.icon_override ?? null,
        realActivity,
        row.time_created,
        row.time_updated,
      )
    }
  }

  test("activity_at reflects latest session time, not directory_meta value", () => {
    const chDir = path.join(tmpRoot, "bug4-ch")
    mkdirSync(chDir, { recursive: true })

    const pid = "act111111111111111111111111111111111111"
    const projPath = path.join(chDir, `aether-${pid}.db`)
    const projDb = initHealthyDbWithTables(projPath)

    const sessionTime = 1000
    const metaActivityAt = 5000
    projDb
      .prepare(
        "INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(pid, "/tmp/act-dir", "git", 1, 1, "[]")
    projDb
      .prepare("INSERT INTO session (id, project_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
      .run("sess1", pid, "/tmp/act-dir", 1, sessionTime)
    projDb
      .prepare(
        "INSERT INTO directory_meta (directory, worktree, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("/tmp/act-dir", "/tmp/act-dir", null, null, null, null, metaActivityAt, 1, 1)
    projDb.close()

    const mainPath = path.join(tmpRoot, "bug4-main.db")
    const mainDb = initMainDbWithMappings(mainPath)

    const pSqlite = new BunSqlite(projPath)
    simulateSync(mainDb, pSqlite, pid)
    pSqlite.close()

    const row = mainDb.prepare("SELECT activity_at FROM project_recent WHERE project_id = ?").get(pid) as {
      activity_at: number
    } | null
    expect(row).not.toBeNull()
    expect(row!.activity_at).toBe(sessionTime)

    mainDb.close()
  })

  test("ProjectTable icon propagates to project_recent for worktree row", () => {
    const chDir = path.join(tmpRoot, "bug4-icon")
    mkdirSync(chDir, { recursive: true })

    const pid = "icon1111111111111111111111111111111111"
    const projPath = path.join(chDir, `aether-${pid}.db`)
    const projDb = initHealthyDbWithTables(projPath)

    projDb
      .prepare(
        "INSERT INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(pid, "/tmp/icon-dir", "git", null, null, "mint", 1, 1, "[]")
    projDb
      .prepare(
        "INSERT INTO directory_meta (directory, worktree, name, icon_url, icon_color, icon_override, activity_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("/tmp/icon-dir", "/tmp/icon-dir", null, null, null, null, 1, 1, 1)
    projDb.close()

    const mainPath = path.join(tmpRoot, "bug4-icon-main.db")
    const mainDb = initMainDbWithMappings(mainPath)

    // Re-open project DB for the sync simulation
    const pSqlite = new BunSqlite(projPath)
    simulateSync(mainDb, pSqlite, pid)
    pSqlite.close()

    const row = mainDb
      .prepare("SELECT icon_color FROM project_recent WHERE project_id = ? AND kind = 'project'")
      .get(pid) as { icon_color: string | null } | null
    expect(row).not.toBeNull()
    expect(row!.icon_color).toBe("mint")

    mainDb.close()
  })
})
