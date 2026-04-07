import { Database as Sqlite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"

const target_file = "aether-prod.db"
const pref_file = "legacy-db.json"
const archive_file = "legacy-db-archive.json"

function dbPath(name: string) {
  return path.join(Global.Path.data, name)
}

function prefPath() {
  return path.join(Global.Path.state, pref_file)
}

function archivePath() {
  return path.join(Global.Path.state, archive_file)
}

function isdb(name: string) {
  return /^(opencode|aether).*\.db$/i.test(name)
}

function channel(name: string) {
  const file = path.basename(name)
  if (file.toLowerCase() === target_file) return "prod"
  if (!isdb(file)) return "unknown"
  if (file.toLowerCase() === "opencode.db") return "latest"
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
    dismissed: z.boolean(),
    legacy_count: z.number(),
    files: File.array(),
    naming: z.record(z.string(), z.number()),
    versions: z.record(z.string(), z.number()),
  })

  export const Preference = z.object({
    dismissed: z.boolean(),
  })

  export const Archive = z.object({
    history: z.string(),
    moved: z.array(z.string()),
    skipped: z.array(z.string()),
    remaining: z.array(z.string()),
    clean: z.boolean(),
  })

  export type Status = z.infer<typeof Status>
  export type Preference = z.infer<typeof Preference>
  export type Archive = z.infer<typeof Archive>

  export const ArchiveState = z.object({
    state: z.enum(["idle", "running", "done", "error"]),
    updated: z.number(),
    result: Archive.optional(),
    error: z.string().optional(),
  })
  export type ArchiveState = z.infer<typeof ArchiveState>

  async function scan() {
    const dir = Global.Path.data
    const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    return Promise.all(
      rows
        .filter((row) => row.isFile() && isdb(row.name))
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
  }

  export async function preference(): Promise<Preference> {
    const raw = await fs.readFile(prefPath(), "utf-8").catch(() => "")
    if (!raw) return { dismissed: false }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return { dismissed: false }
    }
    const next = Preference.safeParse(json)
    if (!next.success) return { dismissed: false }
    return next.data
  }

  export async function setPreference(input: Preference) {
    const pref = Preference.parse(input)
    await fs.writeFile(prefPath(), JSON.stringify(pref, null, 2), "utf-8")
    return pref
  }

  export function targetPath() {
    return dbPath(target_file)
  }

  export async function ensureTarget() {
    const target = targetPath()
    const stat = await fs.stat(target).catch(() => undefined)
    if (stat) return target
    const list = (await scan()).filter((item) => item.name.toLowerCase() !== target_file)
    if (list.length === 0) {
      const db = new Sqlite(target)
      db.close()
      return target
    }
    const pick = [...list].sort((a, b) => a.mtime - b.mtime || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).at(-1)
    if (pick) await fs.copyFile(pick.path, target)
    return target
  }

  export async function archiveState(): Promise<ArchiveState> {
    const raw = await fs.readFile(archivePath(), "utf-8").catch(() => "")
    if (!raw) {
      return {
        state: "idle",
        updated: Date.now(),
      }
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return {
        state: "idle",
        updated: Date.now(),
      }
    }
    const next = ArchiveState.safeParse(json)
    if (!next.success) {
      return {
        state: "idle",
        updated: Date.now(),
      }
    }
    return next.data
  }

  export async function setArchiveState(input: ArchiveState) {
    const state = ArchiveState.parse(input)
    await fs.writeFile(archivePath(), JSON.stringify(state, null, 2), "utf-8")
    return state
  }

  export async function status(): Promise<Status> {
    const dir = Global.Path.data
    const files = await scan()
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

    const pref = await preference()

    return {
      directory: dir,
      target: targetPath(),
      has_legacy: old.length > 0,
      message: old.length > 0 ? "发现旧库" : "未发现旧库",
      dismissed: pref.dismissed,
      legacy_count: old.length,
      files: old.sort((a, b) => a.name.localeCompare(b.name)),
      naming,
      versions: dist,
    }
  }

  export async function archive(): Promise<Archive> {
    const status = await LegacyDB.status()
    const history = path.join(status.directory, "history_database")
    await fs.mkdir(history, { recursive: true })
    const moved: string[] = []
    const skipped: string[] = []

    const unique = async (file: string) => {
      const ext = path.extname(file)
      const name = path.basename(file, ext)
      let next = path.join(history, file)
      let i = 0
      while (await fs.stat(next).then(() => true).catch(() => false)) {
        i += 1
        next = path.join(history, `${name}-${Date.now()}-${i}${ext}`)
      }
      return next
    }

    for (const file of status.files) {
      const src = path.join(status.directory, file.name)
      const dst = await unique(file.name)
      try {
        await fs.rename(src, dst)
        moved.push(dst)
      } catch {
        skipped.push(src)
      }
    }

    const rest = (await scan()).filter((item) => item.name.toLowerCase() !== target_file).map((item) => item.path)
    return {
      history,
      moved,
      skipped,
      remaining: rest,
      clean: rest.length === 0,
    }
  }
}
