import { Database as Sqlite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { Flag } from "@/flag/flag"

const pref_file = "legacy-db.json"
const merge_file = "legacy-db-merge.json"
const boot_file = "legacy-db-boot.json"

function targetFile() {
  const file = Flag.OPENCODE_DB
  if (!file || file === ":memory:") return "aether-prod.db"
  return path.basename(file)
}

function dbPath(name: string) {
  return path.join(Global.Path.data, name)
}

function prefPath() {
  return path.join(Global.Path.state, pref_file)
}

function mergePath() {
  return path.join(Global.Path.state, merge_file)
}

function bootPath() {
  return path.join(Global.Path.state, boot_file)
}


function isdb(name: string) {
  return /^(opencode|aether).*\.db$/i.test(name)
}

function sourceDb(name: string) {
  return /^opencode.*\.db$/i.test(name)
}

function channel(name: string) {
  const file = path.basename(name)
  if (file.toLowerCase() === targetFile().toLowerCase()) return "prod"
  if (!isdb(file)) return "unknown"
  if (file.toLowerCase() === "opencode.db") return "latest"
  const match = /^opencode-(.+)\.db$/i.exec(file)
  if (!match) return "unknown"
  return match[1]
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
    should_merge: z.boolean(),
    source_count: z.number(),
    legacy_count: z.number(),
    files: File.array(),
    naming: z.record(z.string(), z.number()),
    versions: z.record(z.string(), z.number()),
  })

  export const Preference = z.object({
    dismissed: z.boolean(),
  })

  export const MergeState = z.object({
    state: z.enum(["idle", "running", "done", "error"]),
    updated: z.number(),
    error: z.string().optional(),
    details: z.array(z.string()).optional(),
  })

  export type Status = z.infer<typeof Status>
  export type Preference = z.infer<typeof Preference>
  export type MergeState = z.infer<typeof MergeState>

  export const BootState = z.object({
    should_merge: z.boolean(),
    source_count: z.number(),
    updated: z.number(),
  })
  export type BootState = z.infer<typeof BootState>

  async function scan() {
    const dir = Global.Path.data
    const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    return Promise.all(
      rows
        .filter((row) => row.isFile() && isdb(row.name))
        .map(async (row) => ({
          name: row.name,
          path: path.join(dir, row.name),
          channel: channel(row.name),
          mtime: await mod(path.join(dir, row.name)),
        })),
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
    return dbPath(targetFile())
  }

  export async function copySource() {
    const files = (await scan()).filter((item) => sourceDb(item.name))
    if (files.length !== 1) return
    await fs.copyFile(files[0].path, targetPath())
    return files[0].path
  }

  export async function ensureTarget() {
    const target = targetPath()
    const stat = await fs.stat(target).catch(() => undefined)
    if (stat) return target
    const files = (await scan()).filter((item) => sourceDb(item.name))
    if (files.length === 0) {
      const db = new Sqlite(target)
      db.close()
      return target
    }
    await fs.copyFile(files[0].path, target)
    return target
  }

  export async function mergeState(): Promise<MergeState> {
    const raw = await fs.readFile(mergePath(), "utf-8").catch(() => "")
    if (!raw) return { state: "idle", updated: Date.now() }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return { state: "idle", updated: Date.now() }
    }
    const next = MergeState.safeParse(json)
    if (!next.success) return { state: "idle", updated: Date.now() }
    return next.data
  }

  export async function setMergeState(input: MergeState) {
    const state = MergeState.parse(input)
    await fs.writeFile(mergePath(), JSON.stringify(state, null, 2), "utf-8")
    return state
  }

  export async function clearMergeState() {
    return setMergeState({
      state: "idle",
      updated: Date.now(),
    })
  }

  export async function bootState(): Promise<BootState | undefined> {
    const raw = await fs.readFile(bootPath(), "utf-8").catch(() => "")
    if (!raw) return
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
    const next = BootState.safeParse(json)
    if (!next.success) return
    return next.data
  }

  export async function setBootState(input: BootState) {
    const state = BootState.parse(input)
    await fs.writeFile(bootPath(), JSON.stringify(state, null, 2), "utf-8")
    return state
  }

  export async function status(): Promise<Status> {
    const dir = Global.Path.data
    const files = await scan()
    const target = targetFile().toLowerCase()
    const old = files.filter((file) => file.name.toLowerCase() !== target)
    const src = files.filter((file) => sourceDb(file.name))
    const hasTarget = files.some((file) => file.name.toLowerCase() === target)

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

    const boot = await bootState()
    return {
      directory: dir,
      target: targetPath(),
      has_legacy: old.length > 0,
      message: old.length > 0 ? "发现旧库" : "未发现旧库",
      dismissed: false,
      should_merge: src.length > 0 && (boot?.should_merge || !hasTarget),
      source_count: src.length,
      legacy_count: old.length,
      files: old.sort((a, b) => a.name.localeCompare(b.name)),
      naming,
      versions: dist,
    }
  }

}
