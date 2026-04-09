import { Database as Sqlite } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { LegacyDB } from "../../src/storage/legacy-db"

async function clean() {
  const rows = await fs.readdir(Global.Path.data, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    rows
      .filter((row) => row.isFile() && /^.*\.db(?:-shm|-wal)?$/i.test(row.name))
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

async function touch(file: string, time: number) {
  await fs.utimes(file, time / 1000, time / 1000)
}

describe("LegacyDB", () => {
  beforeEach(async () => {
    await clean()
  })

  test("reports copy status when target is missing", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [{ id: "a", title: "dev", version: "0.1.0", time: 1 }])
    const info = await LegacyDB.status()
    expect(info.should_merge).toBeTrue()
    expect(info.source_count).toBe(1)
    expect(info.target.endsWith("aether-prod.db")).toBeTrue()
  })

  test("copies latest source and sidecars into target", async () => {
    const old = path.join(Global.Path.data, "opencode-dev.db")
    const next = path.join(Global.Path.data, "opencode-beta.db")
    create(old, [{ id: "a", title: "dev", version: "0.1.0", time: 1 }])
    create(next, [{ id: "b", title: "beta", version: "0.1.0", time: 2 }])
    await fs.writeFile(`${next}-wal`, "wal")
    await fs.writeFile(`${next}-shm`, "shm")
    await touch(old, 1000)
    await touch(next, 2000)

    await LegacyDB.copySource()

    const db = new Sqlite(LegacyDB.targetPath(), { readonly: true })
    const row = db.query("select id, title from session where id='b'").get() as { id: string; title: string }
    db.close()

    expect(row.title).toBe("beta")
    const left = await fs.readdir(Global.Path.data)
    expect(left.includes("aether-prod.db")).toBeTrue()
    expect(left.includes("aether-prod.db-wal")).toBeTrue()
    expect(left.includes("aether-prod.db-shm")).toBeTrue()
    expect(left.includes("opencode-dev.db")).toBeTrue()
    expect(left.includes("opencode-beta.db")).toBeTrue()
  })

  test("does not re-trigger copy once target exists", async () => {
    create(path.join(Global.Path.data, "opencode-dev.db"), [{ id: "a", title: "dev", version: "0.1.0", time: 1 }])
    await LegacyDB.copySource()
    const info = await LegacyDB.status()
    expect(info.should_merge).toBeFalse()
  })
})
