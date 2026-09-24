import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import { rm, mkdtemp, unlink } from "fs/promises"
import os from "os"
import path from "path"
import { Database as BunSqlite } from "bun:sqlite"
import {
  cleanupQuarantinedOriginals,
  detectCorruption,
  quarantine,
  DbRecovery,
  readManifest,
} from "../../src/storage/db-recovery"
import type { RecoveryEntry } from "../../src/storage/db-recovery"
import { Global } from "../../src/global"

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "aether-recovery-test-"))

beforeAll(async () => {
  await fs.promises.mkdir(path.join(tmpRoot, "corrupt"), { recursive: true })
})

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe("detectCorruption", () => {
  test("returns null for :memory:", () => {
    expect(detectCorruption(":memory:")).toBeNull()
  })

  test("returns null for healthy db", async () => {
    const dbPath = path.join(tmpRoot, "healthy.db")
    const db = new BunSqlite(dbPath, { create: true })
    db.exec("create table test(x integer); insert into test values(1);")
    db.close()
    expect(detectCorruption(dbPath)).toBeNull()
  })

  test("returns 'empty' for 0-byte file", async () => {
    const filePath = path.join(tmpRoot, "empty.db")
    await Bun.write(filePath, "")
    expect(detectCorruption(filePath)).toBe("empty")
  })

  test("returns 'truncated' for sub-512 byte file", async () => {
    const filePath = path.join(tmpRoot, "truncated.db")
    const buf = Buffer.alloc(256)
    for (let i = 0; i < 16; i++) buf[i] = 0
    buf[0] = 0x53
    buf[1] = 0x51
    buf[2] = 0x4c
    buf[3] = 0x69
    await Bun.write(filePath, buf)
    expect(detectCorruption(filePath)).toBe("truncated")
  })

  test("returns 'header' for header-corrupted file", async () => {
    const srcPath = path.join(tmpRoot, "healthy-header.db")
    const src = new BunSqlite(srcPath, { create: true })
    src.exec("create table test(x integer); insert into test values(1);")
    src.close()

    const corruptPath = path.join(tmpRoot, "header-corrupt.db")
    const buf = readFileSync(srcPath)
    for (let i = 0; i < 100; i++) buf[i] = Math.floor(Math.random() * 256)
    writeFileSync(corruptPath, buf)

    const result = detectCorruption(corruptPath)
    expect(result).toBe("header")
  })

  test("returns 'mid-page' for page-corrupted file", async () => {
    const srcPath = path.join(tmpRoot, "healthy-mid.db")
    const src = new BunSqlite(srcPath, { create: true })
    src.exec("create table test(x integer); insert into test values(1);")
    src.close()

    const corruptPath = path.join(tmpRoot, "mid-corrupt.db")
    const buf = readFileSync(srcPath)
    if (buf.length > 4196) {
      for (let i = 4096; i < 4196; i++) buf[i] = Math.floor(Math.random() * 256)
    }
    writeFileSync(corruptPath, buf)

    const result = detectCorruption(corruptPath)
    expect(result === "mid-page" || result === "unknown").toBeTrue()
  })

  test("returns null for nonexistent file", () => {
    const nonexistent = path.join(tmpRoot, "does-not-exist.db")
    expect(detectCorruption(nonexistent)).toBeNull()
  })
})

describe("quarantine", () => {
  test("throws for :memory:", () => {
    expect(() => quarantine(":memory:", "main")).toThrow()
  })

  test("moves db files to corrupt dir and creates manifest entry", async () => {
    const dbPath = path.join(tmpRoot, "to-quarantine.db")
    const db = new BunSqlite(dbPath, { create: true })
    db.exec("create table test(x integer); insert into test values(1);")
    db.close()

    const entry = quarantine(dbPath, "project", "testpid123")
    expect(entry.kind).toBe("project")
    expect(entry.projectId).toBe("testpid123")
    expect(entry.recoveryStatus).toBe("pending")
    expect(existsSync(dbPath)).toBeFalse()
    expect(existsSync(entry.quarantinePath)).toBeTrue()

    const manifest = readManifest()
    expect(manifest.length).toBeGreaterThan(0)
    const found = manifest.find((e) => e.id === entry.id)
    expect(found).toBeDefined()
  })
})

describe("DbRecovery BAB strategy", () => {
  test("hasPendingRecovery and pendingEntries work correctly", () => {
    const pending = DbRecovery.pendingEntries()
    const hasPending = DbRecovery.hasPendingRecovery()
    expect(hasPending).toBe(pending.length > 0)
  })
})

describe("cleanupQuarantinedOriginals", () => {
  function storeManifest(entries: RecoveryEntry[]) {
    const file = path.join(Global.Path.data, "corrupt", "recovery-manifest.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(entries))
  }

  function healthyDb(p: string, tag: string) {
    const db = new BunSqlite(p, { create: true })
    db.exec(`create table session(id integer primary key, tag text); insert into session(tag) values('${tag}')`)
    db.close()
  }

  function idOf(p: string) {
    const st = fs.statSync(p)
    return { ino: st.ino, size: st.size }
  }

  function manifestEntry(originalPath: string, quarantinePath: string, leftover?: { ino: number; size: number }) {
    return {
      id: `t-${Math.random().toString(36).slice(2)}`,
      kind: "project" as const,
      originalPath,
      quarantinePath,
      corruptionType: "header" as const,
      recoveryStatus: "pending" as const,
      recoveredTables: [],
      failedTables: [],
      recoveredRows: 0,
      timestamp: Date.now(),
      leftover,
    }
  }

  test("spares a rebuilt same-size database whose new sessions live only in the wal", () => {
    const orig = path.join(tmpRoot, "rebuilt-live.db")
    const prev = path.join(tmpRoot, "rebuilt-live-prev.db")
    const qcopy = path.join(tmpRoot, "rebuilt-live-q.db")
    healthyDb(prev, "bravo")
    fs.copyFileSync(prev, qcopy)
    healthyDb(orig, "alpha")
    expect(fs.statSync(orig).size).toBe(fs.statSync(qcopy).size)
    expect(idOf(orig).ino).not.toBe(idOf(prev).ino)

    const db = new BunSqlite(orig)
    db.exec("pragma journal_mode = wal")
    db.exec("insert into session(tag) values('session-after-quarantine')")
    storeManifest([manifestEntry(orig, qcopy, idOf(prev))])

    cleanupQuarantinedOriginals()

    expect(existsSync(orig)).toBeTrue()
    expect(existsSync(orig + "-wal")).toBeTrue()
    const row = db.prepare("select count(*) as n from session where tag = 'session-after-quarantine'").get() as {
      n: number
    }
    expect(row.n).toBe(1)
    db.close()
  })

  test("spares a same-size database with different content when the inode differs", () => {
    const orig = path.join(tmpRoot, "rebuilt-closed.db")
    const prev = path.join(tmpRoot, "rebuilt-closed-prev.db")
    const qcopy = path.join(tmpRoot, "rebuilt-closed-q.db")
    healthyDb(prev, "bravo")
    fs.copyFileSync(prev, qcopy)
    healthyDb(orig, "alpha")
    expect(fs.statSync(orig).size).toBe(fs.statSync(qcopy).size)
    storeManifest([manifestEntry(orig, qcopy, idOf(prev))])

    cleanupQuarantinedOriginals()

    expect(existsSync(orig)).toBeTrue()
    expect(idOf(orig).size).toBe(idOf(qcopy).size)
  })

  test("removes the recorded leftover when identity still matches and no wal exists", () => {
    const qcopy = path.join(tmpRoot, "leftover-q.db")
    healthyDb(qcopy, "original")
    const orig = path.join(tmpRoot, "leftover.db")
    fs.copyFileSync(qcopy, orig)
    fs.writeFileSync(orig + "-shm", "stale")
    storeManifest([manifestEntry(orig, qcopy, idOf(orig))])

    cleanupQuarantinedOriginals()

    expect(existsSync(orig)).toBeFalse()
    expect(existsSync(orig + "-shm")).toBeFalse()
    expect(existsSync(qcopy)).toBeTrue()
  })

  test("spares the recorded leftover while a wal sidecar exists", () => {
    const qcopy = path.join(tmpRoot, "leftover-wal-q.db")
    healthyDb(qcopy, "original")
    const orig = path.join(tmpRoot, "leftover-wal.db")
    fs.copyFileSync(qcopy, orig)
    fs.writeFileSync(orig + "-wal", "live-connection-wal")
    storeManifest([manifestEntry(orig, qcopy, idOf(orig))])

    cleanupQuarantinedOriginals()

    expect(existsSync(orig)).toBeTrue()
  })

  test("legacy entries without a leftover record are never touched", () => {
    const orig = path.join(tmpRoot, "legacy-entry.db")
    const qcopy = path.join(tmpRoot, "legacy-entry-q.db")
    healthyDb(orig, "alpha")
    healthyDb(qcopy, "bravo")
    expect(fs.statSync(orig).size).toBe(fs.statSync(qcopy).size)
    storeManifest([manifestEntry(orig, qcopy)])

    cleanupQuarantinedOriginals()

    expect(existsSync(orig)).toBeTrue()
  })

  test("happy-path quarantine records no leftover", () => {
    const dbPath = path.join(tmpRoot, `happy-${Date.now()}.db`)
    healthyDb(dbPath, "data")
    const e = quarantine(dbPath, "project", `pid-${Date.now()}`)
    expect(e.leftover).toBeUndefined()
    expect(existsSync(dbPath)).toBeFalse()
  })
})

function readFileSync(p: string): Buffer {
  return fs.readFileSync(p) as Buffer
}

function writeFileSync(p: string, data: Buffer | string) {
  fs.writeFileSync(p, data)
}

function existsSync(p: string): boolean {
  return fs.existsSync(p)
}
