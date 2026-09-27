import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Database as BunSqlite } from "bun:sqlite"
import { Database } from "../../src/storage/db"
import {
  cleanupQuarantinedOriginals,
  detectCorruption,
  isCorruptionError,
  readManifest,
} from "../../src/storage/db-recovery"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function pid() {
  return Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
}

function register(id: string) {
  Database.Client()
    .$client.prepare(
      "INSERT INTO global_project_map (directory, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)",
    )
    .run("/regression-" + id, id, Date.now(), Date.now())
}

function dbPath(id: string) {
  return Database.projectPath(id)
}

function rmQuiet(p: string) {
  for (const ext of ["", "-wal", "-shm"]) {
    for (let i = 0; ; i++) {
      try {
        rmSync(p + ext, { force: true })
        break
      } catch {
        if (i > 20) break
        Bun.sleepSync(50)
      }
    }
  }
}

function danglingLink(p: string) {
  symlinkSync(p + ".missing-target", p, process.platform === "win32" ? "junction" : "file")
}

function garbage(path_: string) {
  const buf = Buffer.alloc(4096)
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256)
  writeFileSync(path_, buf)
}

describe("isCorruptionError", () => {
  test("sqlite corruption codes and messages are corruption", () => {
    expect(
      isCorruptionError(Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" })),
    ).toBe(true)
    expect(isCorruptionError(Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" }))).toBe(true)
    expect(isCorruptionError(new Error("file is not a database"))).toBe(true)
    expect(isCorruptionError(new Error("malformed database schema (session)"))).toBe(true)
  })

  test("drizzle-style cause chains are unwrapped", () => {
    const wrapped: any = new Error("Failed to run the query 'PRAGMA journal_mode = WAL'")
    wrapped.cause = Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" })
    expect(isCorruptionError(wrapped)).toBe(true)

    const transient: any = new Error("Failed to run the query 'PRAGMA journal_mode = WAL'")
    transient.cause = Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" })
    expect(isCorruptionError(transient)).toBe(false)
  })

  test("transient and environmental errors are not corruption", () => {
    expect(
      isCorruptionError(Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" })),
    ).toBe(false)
    expect(isCorruptionError(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }))).toBe(false)
    expect(isCorruptionError(new Error("disk I/O error"))).toBe(false)
    expect(isCorruptionError(new Error("database is locked"))).toBe(false)
    expect(isCorruptionError(undefined)).toBe(false)
  })
})

describe("detectCorruption unreadable files", () => {
  test("dangling link is not treated as corruption", () => {
    const p = path.join(Database.ensureChannelDir(), `detect-probe-${pid()}`)
    danglingLink(p)
    try {
      expect(detectCorruption(p)).toBeNull()
    } finally {
      try {
        rmSync(p, { force: true })
      } catch {}
    }
  })

  test("garbage file is detected as header corruption", () => {
    const p = path.join(Database.ensureChannelDir(), `detect-probe-${pid()}`)
    garbage(p)
    try {
      expect(detectCorruption(p)).toBe("header")
    } finally {
      rmQuiet(p)
    }
  })
})

describe("attach transient failure quarantine guard (issue #1452)", () => {
  test("attach rethrows transient open failure and never quarantines", () => {
    const id = pid()
    register(id)
    const p = dbPath(id)
    // a directory cannot be opened as a sqlite database on any platform,
    // which simulates a transient open failure without destroying anything
    mkdirSync(p)
    try {
      expect(() => Database.attach(id)).toThrow()
      expect(statSync(p).isDirectory()).toBe(true)
      expect(readManifest().some((e) => e.originalPath === p)).toBe(false)
    } finally {
      try {
        rmdirSync(p)
      } catch {}
      Database.detach(id)
      Database.Client().$client.prepare("DELETE FROM global_project_map WHERE project_id = ?").run(id)
    }
  })

  test("attach still quarantines and recreates on proven corruption", () => {
    const id = pid()
    register(id)
    const p = dbPath(id)
    garbage(p)
    const client = Database.attach(id)
    try {
      expect(client).toBeDefined()
      expect(readManifest().some((e) => e.originalPath === p)).toBe(true)
      expect(existsSync(p)).toBe(true)
      const db = new BunSqlite(p, { readonly: true })
      const tables = db.prepare("select count(*) as n from sqlite_master where type='table'").get() as { n: number }
      db.close()
      expect(tables.n).toBeGreaterThan(0)
    } finally {
      Database.detach(id)
      rmQuiet(p)
      Database.Client().$client.prepare("DELETE FROM global_project_map WHERE project_id = ?").run(id)
    }
  })
})

describe("cleanupQuarantinedOriginals leftover identity", () => {
  const manifestFile = path.join(Global.Path.data, "corrupt", "recovery-manifest.json")

  function entry(main: string, leftover?: { ino: number; size: number }, leftoverWal?: { ino: number; size: number }) {
    return {
      id: "t-" + pid(),
      kind: "project" as const,
      originalPath: main,
      quarantinePath: main + ".q",
      corruptionType: "unknown" as const,
      recoveryStatus: "pending" as const,
      recoveredTables: [] as string[],
      failedTables: [] as string[],
      recoveredRows: 0,
      timestamp: Date.now(),
      leftover,
      leftoverWal,
    }
  }

  function withEntry(e: ReturnType<typeof entry>, fn: () => void) {
    const before = readManifest()
    writeFileSync(manifestFile, JSON.stringify([...before, e], null, 2))
    try {
      fn()
    } finally {
      writeFileSync(manifestFile, JSON.stringify(before, null, 2))
    }
  }

  function probe() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qclean-"))
    const main = path.join(dir, "aether-probe.db")
    return { dir, main }
  }

  test("cleans main + wal when both match their recorded quarantine identity", () => {
    const { dir, main } = probe()
    writeFileSync(main, Buffer.alloc(4096, 1))
    writeFileSync(main + "-wal", Buffer.alloc(4096, 2))
    const ms = statSync(main)
    const ws = statSync(main + "-wal")
    withEntry(entry(main, { ino: ms.ino, size: ms.size }, { ino: ws.ino, size: ws.size }), () => {
      cleanupQuarantinedOriginals()
      expect(existsSync(main)).toBe(false)
      expect(existsSync(main + "-wal")).toBe(false)
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test("never cleans when a fresh wal without recorded identity sits at the path", () => {
    const { dir, main } = probe()
    writeFileSync(main, Buffer.alloc(4096, 1))
    writeFileSync(main + "-wal", Buffer.alloc(4096, 2))
    const ms = statSync(main)
    withEntry(entry(main, { ino: ms.ino, size: ms.size }), () => {
      cleanupQuarantinedOriginals()
      expect(existsSync(main)).toBe(true)
      expect(existsSync(main + "-wal")).toBe(true)
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test("never cleans when the main file is a rebuilt generation", () => {
    const { dir, main } = probe()
    writeFileSync(main, Buffer.alloc(4096, 3))
    const ws = statSync(main)
    withEntry(entry(main, { ino: 999999, size: 1 }, { ino: ws.ino, size: ws.size }), () => {
      cleanupQuarantinedOriginals()
      expect(existsSync(main)).toBe(true)
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test("removes a proven stale wal left where the main db is gone", () => {
    const { dir, main } = probe()
    writeFileSync(main + "-wal", Buffer.alloc(4096, 2))
    const ws = statSync(main + "-wal")
    withEntry(entry(main, { ino: 999999, size: 1 }, { ino: ws.ino, size: ws.size }), () => {
      cleanupQuarantinedOriginals()
      expect(existsSync(main)).toBe(false)
      expect(existsSync(main + "-wal")).toBe(false)
    })
    rmSync(dir, { recursive: true, force: true })
  })
})
