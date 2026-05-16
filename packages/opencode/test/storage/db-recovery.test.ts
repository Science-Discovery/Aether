import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import { rm, mkdtemp, unlink } from "fs/promises"
import os from "os"
import path from "path"
import { Database as BunSqlite } from "bun:sqlite"
import { detectCorruption, quarantine, DbRecovery, readManifest } from "../../src/storage/db-recovery"
import type { RecoveryEntry } from "../../src/storage/db-recovery"
import { Database } from "../../src/storage/db"
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

describe("registerUntrackedProjects fault tolerance", () => {
  test("corrupted project DB does not crash registerUntrackedProjects", async () => {
    // Create a main DB
    const mainPath = path.join(tmpRoot, "reg-main.db")
    const mainDb = Database.Client()

    // Create a project DB file with corrupted header in the channel dir
    const chDir = Database.channelDir()
    fs.mkdirSync(chDir, { recursive: true })
    const corruptProjPath = path.join(chDir, "aether-deadbeef1234567890abcdef1234567890abcd.db")
    const buf = Buffer.alloc(221184)
    for (let i = 0; i < 100; i++) buf[i] = Math.floor(Math.random() * 256)
    writeFileSync(corruptProjPath, buf)

    // Create a healthy project DB too
    const healthyProjPath = Database.projectPath("abc123def456")
    const hdb = new BunSqlite(healthyProjPath, { create: true })
    hdb.exec(`
      create table project(id text primary key, worktree text);
      insert into project values('abc123def456', '/tmp/test');
      create table directory_meta(directory text primary key, worktree text, name text, icon_url text, icon_color text, icon_override text, activity_at integer, time_created integer, time_updated integer);
      create table session(id text primary key, directory text);
    `)
    hdb.close()

    // Call registerUntrackedProjects - should not throw
    Database.registerUntrackedProjects(mainDb)

    // Verify the corrupted DB was quarantined (moved out of channel dir)
    expect(existsSync(corruptProjPath)).toBeFalse()

    // Verify the healthy DB still exists
    expect(existsSync(healthyProjPath)).toBeTrue()

    // Clean up
    Database.detach("abc123def456")
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(healthyProjPath + ext)
      } catch {}
    }
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
