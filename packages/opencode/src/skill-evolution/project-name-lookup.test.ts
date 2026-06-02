import { describe, expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readWorktree } from "./project-name-lookup"

async function tmpDbWithProject(worktree: string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pnl-test-"))
  const dbPath = path.join(dir, "aether-test.db")
  const db = new BunSqlite(dbPath)
  db.exec("CREATE TABLE project (id text, worktree text)")
  if (worktree !== null) db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("x", worktree)
  db.close()
  return dbPath
}

describe("readWorktree", () => {
  test("reads the project worktree from a per-project db", async () => {
    const dbPath = await tmpDbWithProject("/home/u/code/test")
    expect(readWorktree(dbPath)).toBe("/home/u/code/test")
  })

  test("returns undefined when the db file does not exist (boundary)", () => {
    expect(readWorktree("/tmp/pnl-does-not-exist-xyz.db")).toBeUndefined()
  })

  test("returns undefined when the project table is empty (boundary)", async () => {
    const dbPath = await tmpDbWithProject(null)
    expect(readWorktree(dbPath)).toBeUndefined()
  })

  test("returns undefined when there is no project table (corrupt/foreign db, boundary)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pnl-test-"))
    const dbPath = path.join(dir, "aether-empty.db")
    const db = new BunSqlite(dbPath)
    db.exec("CREATE TABLE other (x text)")
    db.close()
    expect(readWorktree(dbPath)).toBeUndefined()
  })
})
