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

  test("reports auto-merge status when target is missing", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [{ id: "a", title: "dev", version: "0.1.0", time: 1 }])
    const info = await LegacyDB.status()
    expect(info.should_merge).toBeTrue()
    expect(info.source_count).toBe(1)
    expect(info.target.endsWith("aether-prod.db")).toBeTrue()
  })

  test("copies single source into target and keeps source db intact", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [{ id: "a", title: "dev", version: "0.1.0", time: 1 }])
    await LegacyDB.copySource()
    const db = new Sqlite(LegacyDB.targetPath(), { readonly: true })
    const row = db.query("select id, title from session where id='a'").get() as { id: string; title: string }
    db.close()
    expect(row.title).toBe("dev")
    const left = await fs.readdir(Global.Path.data)
    const dbs = left.filter((item) => item.endsWith(".db"))
    expect(dbs.includes("aether-prod.db")).toBeTrue()
    expect(dbs.includes("opencode-dev.db")).toBeTrue()
    expect(dbs.length).toBe(2)
  })

  test("does not re-trigger merge once target exists and boot flag is cleared", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [{ id: "a", title: "dev", version: "0.1.0", time: 1 }])
    await LegacyDB.setBootState({ should_merge: true, source_count: 1, updated: Date.now() })
    await LegacyDB.copySource()
    await LegacyDB.setBootState({ should_merge: false, source_count: 1, updated: Date.now() })
    const info = await LegacyDB.status()
    expect(info.should_merge).toBeFalse()
  })
})
