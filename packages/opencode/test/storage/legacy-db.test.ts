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
      .filter((row) => row.isFile() && /^(opencode|aether).*\.db$/i.test(row.name))
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

  test("archives legacy db files after merge", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [{ id: "x", title: "dev", version: "0.1.0", time: 1 }])
    create(path.join(Global.Path.data, "opencode-local.db"), [{ id: "y", title: "local", version: "0.2.0", time: 2 }])

    await LegacyDB.ensureTarget()
    const arc = await LegacyDB.archive()
    expect(arc.clean).toBeTrue()
    expect(arc.moved.length).toBe(2)

    const left = await fs.readdir(Global.Path.data)
    const dbs = left.filter((item) => item.endsWith(".db"))
    expect(dbs.includes("aether-prod.db")).toBeTrue()
    expect(dbs.length).toBe(1)
  })
})
