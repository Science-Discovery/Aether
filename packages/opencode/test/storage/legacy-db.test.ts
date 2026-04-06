import { beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Database as Sqlite } from "bun:sqlite"
import { Global } from "../../src/global"
import { LegacyDB } from "../../src/storage/legacy-db"

async function clean() {
  const rows = await fs.readdir(Global.Path.data, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    rows
      .filter((row) => row.isFile() && /^opencode.*\.db$/i.test(row.name))
      .map((row) => fs.rm(path.join(Global.Path.data, row.name), { force: true })),
  )
}

function create(file: string, rows: { id: string; title: string; version: string; time: number }[]) {
  const db = new Sqlite(file)
  db.exec(
    "create table if not exists session (id text primary key, version text, title text, time_updated integer not null)",
  )
  const stmt = db.prepare("insert into session (id, version, title, time_updated) values (?, ?, ?, ?)")
  for (const row of rows) stmt.run(row.id, row.version, row.title, row.time)
  db.close()
}

describe("LegacyDB", () => {
  beforeEach(async () => {
    await clean()
  })

  test("reports legacy database stats", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [
      { id: "a", title: "dev", version: "0.1.0", time: 100 },
    ])
    create(path.join(Global.Path.data, "opencode-local.db"), [
      { id: "b", title: "local", version: "0.2.0", time: 120 },
    ])

    const info = await LegacyDB.status()
    expect(info.has_legacy).toBeTrue()
    expect(info.legacy_count).toBe(2)
    expect(info.naming["dev"]).toBe(1)
    expect(info.naming["local"]).toBe(1)
    expect(info.versions["0.1.0"]).toBe(1)
    expect(info.versions["0.2.0"]).toBe(1)
  })

  test("merges into opencode-prod.db with latest_wins", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [
      { id: "s1", title: "old", version: "0.1.0", time: 100 },
      { id: "s2", title: "keep", version: "0.1.0", time: 100 },
    ])
    create(path.join(Global.Path.data, "opencode-local.db"), [
      { id: "s1", title: "new", version: "0.2.0", time: 200 },
    ])

    const report = await LegacyDB.merge()
    expect(report.errors.length).toBe(0)
    expect(report.merged.length).toBe(2)

    const db = new Sqlite(LegacyDB.targetPath(), { readonly: true })
    const row = db.query("select id, title, time_updated from session where id='s1'").get() as {
      id: string
      title: string
      time_updated: number
    }
    const row2 = db.query("select id, title from session where id='s2'").get() as {
      id: string
      title: string
    }
    db.close()

    expect(row.id).toBe("s1")
    expect(row.title).toBe("new")
    expect(row.time_updated).toBe(200)
    expect(row2.title).toBe("keep")

    const oldA = await fs.stat(path.join(Global.Path.data, "opencode-dev.db")).catch(() => undefined)
    const oldB = await fs.stat(path.join(Global.Path.data, "opencode-local.db")).catch(() => undefined)
    expect(!!oldA).toBeTrue()
    expect(!!oldB).toBeTrue()
  })
})
