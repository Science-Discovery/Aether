import { Database as Sqlite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "legacy-db" })

const target_file = "opencode-prod.db"
const time_cols = ["time_updated", "updated_at", "updated", "time_created", "created_at", "created"] as const
const low = "-9223372036854775808"

function q(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}

function lit(text: string) {
  return `'${text.replaceAll("'", "''")}'`
}

function dbPath(name: string) {
  return path.join(Global.Path.data, name)
}

function channel(name: string) {
  const file = path.basename(name)
  if (!file.toLowerCase().startsWith("opencode") || !file.toLowerCase().endsWith(".db")) return "unknown"
  if (file.toLowerCase() === "opencode.db") return "latest"
  if (file.toLowerCase() === target_file) return "prod"
  const match = /^opencode-(.+)\.db$/i.exec(file)
  if (!match) return "unknown"
  return match[1]
}

function rank(name: string) {
  const ch = channel(name)
  if (ch === "local") return 0
  if (ch === "dev") return 1
  if (ch === "beta") return 2
  if (ch === "latest") return 3
  if (ch === "prod") return 4
  return 2
}

async function mod(file: string) {
  const stat = await fs.stat(file).catch(() => undefined)
  return stat?.mtimeMs ?? 0
}

async function versions(file: string) {
  const db = new Sqlite(file, { readonly: true })
  try {
    const rows = db
      .query("select version, count(*) as count from session group by version")
      .all() as { version: string | null; count: number }[]
    return rows.reduce<Record<string, number>>((acc, row) => {
      const key = row.version || "unknown"
      acc[key] = (acc[key] ?? 0) + row.count
      return acc
    }, {})
  } catch {
    return {}
  } finally {
    db.close()
  }
}

function pickTime(cols: string[]) {
  return time_cols.find((col) => cols.includes(col))
}

function common(a: string[], b: string[]) {
  const set = new Set(b)
  return a.filter((item) => set.has(item))
}

function mergeSql(input: { table: string; cols: string[]; pks: string[]; time?: string }) {
  const table = q(input.table)
  const cols = input.cols.map(q)
  const list = cols.join(", ")
  const rows = input.cols.map((col) => `src.${table}.${q(col)}`).join(", ")

  if (input.pks.length === 0) {
    return `insert into main.${table} (${list}) select ${rows} from src.${table}`
  }

  const keys = input.pks.map(q).join(", ")
  const updates = input.cols
    .filter((col) => !input.pks.includes(col))
    .map((col) => `${q(col)}=coalesce(excluded.${q(col)}, ${table}.${q(col)})`)

  if (updates.length === 0) {
    return `insert into main.${table} (${list}) select ${rows} from src.${table} where 1 on conflict (${keys}) do nothing`
  }

  const where = input.time
    ? ` where coalesce(excluded.${q(input.time)}, ${low}) >= coalesce(${table}.${q(input.time)}, ${low})`
    : ""

  return `insert into main.${table} (${list}) select ${rows} from src.${table} where 1 on conflict (${keys}) do update set ${updates.join(", ")}${where}`
}

function tableInfo(db: Sqlite, schema: "main" | "src", table: string) {
  return db.query(`pragma ${schema}.table_info(${lit(table)})`).all() as {
    name: string
    pk: number
  }[]
}

function master(db: Sqlite, schema: "main" | "src") {
  return db
    .query(`select name, sql from ${schema}.sqlite_master where type='table' and name not like 'sqlite_%'`)
    .all() as {
    name: string
    sql: string | null
  }[]
}

function createSql(sql: string) {
  return sql.replace(/^create\s+table\s+/i, "create table if not exists ")
}

export namespace LegacyDB {
  export const target = target_file

  export const File = z.object({
    name: z.string(),
    path: z.string(),
    channel: z.string(),
    mtime: z.number(),
  })

  export const Status = z.object({
    directory: z.string(),
    target: z.string(),
    has_legacy: z.boolean(),
    message: z.string(),
    legacy_count: z.number(),
    files: File.array(),
    naming: z.record(z.string(), z.number()),
    versions: z.record(z.string(), z.number()),
  })

  export const Merge = z.object({
    target: z.string(),
    merged: z.array(z.string()),
    tables: z.number(),
    changes: z.number(),
    skipped: z.array(z.string()),
    errors: z.array(z.string()),
  })

  export type Status = z.infer<typeof Status>
  export type Merge = z.infer<typeof Merge>

  export function targetPath() {
    return dbPath(target_file)
  }

  export async function status(): Promise<Status> {
    const dir = Global.Path.data
    const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const files = await Promise.all(
      rows
        .filter((row) => row.isFile() && /^opencode.*\.db$/i.test(row.name))
        .map(async (row) => {
          const file = path.join(dir, row.name)
          return {
            name: row.name,
            path: file,
            channel: channel(row.name),
            mtime: await mod(file),
          }
        }),
    )
    const old = files.filter((file) => file.name.toLowerCase() !== target_file)

    const naming = old.reduce<Record<string, number>>((acc, file) => {
      acc[file.channel] = (acc[file.channel] ?? 0) + 1
      return acc
    }, {})

    const list = await Promise.all(old.map(async (file) => ({ file, versions: await versions(file.path) })))
    const dist = list.reduce<Record<string, number>>((acc, item) => {
      for (const [key, val] of Object.entries(item.versions)) {
        acc[key] = (acc[key] ?? 0) + val
      }
      return acc
    }, {})

    return {
      directory: dir,
      target: targetPath(),
      has_legacy: old.length > 0,
      message: old.length > 0 ? "发现旧库" : "未发现旧库",
      legacy_count: old.length,
      files: old.sort((a, b) => a.name.localeCompare(b.name)),
      naming,
      versions: dist,
    }
  }

  async function seed(files: Status["files"]) {
    const target = targetPath()
    const stat = await fs.stat(target).catch(() => undefined)
    if (stat) return
    if (files.length === 0) {
      const db = new Sqlite(target)
      db.close()
      return
    }
    const list = [...files].sort((a, b) => a.mtime - b.mtime || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    await fs.copyFile(list.at(-1)!.path, target)
  }

  export async function merge(): Promise<Merge> {
    const info = await status()
    await seed(info.files)
    const target = targetPath()

    const list = [...info.files].sort((a, b) => a.mtime - b.mtime || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    const merged: string[] = []
    const skipped: string[] = []
    const errors: string[] = []

    const db = new Sqlite(target)
    db.exec("pragma busy_timeout = 5000")
    let total = 0
    let tabs = 0

    try {
      for (const file of list) {
        if (path.resolve(file.path) === path.resolve(target)) continue
        db.exec(`attach database ${lit(file.path)} as src`)
        try {
          const src = master(db, "src")
          const main = new Set(master(db, "main").map((item) => item.name))

          for (const tab of src) {
            if (!tab.sql) {
              skipped.push(`${file.name}:${tab.name}:missing-schema`)
              continue
            }
            if (!main.has(tab.name)) {
              db.exec(createSql(tab.sql))
              main.add(tab.name)
            }

            const srcInfo = tableInfo(db, "src", tab.name)
            const mainInfo = tableInfo(db, "main", tab.name)
            const cols = common(
              mainInfo.map((item) => item.name),
              srcInfo.map((item) => item.name),
            )
            if (cols.length === 0) {
              skipped.push(`${file.name}:${tab.name}:no-common-columns`)
              continue
            }

            const srcPk = srcInfo.filter((item) => item.pk > 0).map((item) => item.name)
            const mainPk = mainInfo.filter((item) => item.pk > 0).map((item) => item.name)
            const pks = common(mainPk, srcPk)
            const time = pickTime(cols)
            const sql = mergeSql({ table: tab.name, cols, pks, time })

            db.exec(sql)
            const row = db.query("select changes() as c").get() as { c: number }
            total += row.c
            tabs += 1
          }
          merged.push(file.path)
        } catch (error) {
          errors.push(`${file.name}:${error instanceof Error ? error.message : String(error)}`)
          log.warn("legacy merge source failed", {
            source: file.path,
            error,
          })
        } finally {
          db.exec("detach database src")
        }
      }
    } finally {
      db.close()
    }

    return {
      target,
      merged,
      tables: tabs,
      changes: total,
      skipped,
      errors,
    }
  }
}
