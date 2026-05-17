import z from "zod"
import path from "path"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { Database as BunSqlite } from "bun:sqlite"
import { Global } from "../global"
import { Log } from "../util/log"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { iife } from "@/util/iife"

export type CorruptionType = "header" | "mid-page" | "empty" | "truncated" | "unknown"

export type RecoveryEntry = {
  id: string
  kind: "main" | "project" | "cron"
  projectId?: string
  originalPath: string
  quarantinePath: string
  corruptionType: CorruptionType
  recoveryStatus: "pending" | "attempting" | "partial" | "failed" | "completed"
  recoveredTables: string[]
  failedTables: string[]
  recoveredRows: number
  timestamp: number
}

type RecoveryResult = {
  recoveredTables: string[]
  failedTables: string[]
  recoveredRows: number
}

const CORRUPT_DIR = "corrupt"
const MANIFEST_FILE = "recovery-manifest.json"

const log = Log.create({ service: "db.recovery" })

async function publish<D extends BusEvent.Definition>(def: D, properties: z.output<D["properties"]>) {
  try {
    const { Bus } = await import("@/bus")
    await Bus.publish(def, properties)
  } catch {
    GlobalBus.emit("event", { payload: { type: def.type, properties } })
  }
}

export const DbEvent = {
  RecoveryStarted: BusEvent.define(
    "db.recovery.started",
    z.object({
      entries: z.number(),
    }),
  ),
  RecoveryProgress: BusEvent.define(
    "db.recovery.progress",
    z.object({
      id: z.string(),
      phase: z.enum(["path-b", "path-a", "path-a-plus"]),
      table: z.string(),
      recoveredRows: z.number(),
    }),
  ),
  RecoveryCompleted: BusEvent.define(
    "db.recovery.completed",
    z.object({
      id: z.string(),
      kind: z.enum(["main", "project", "cron"]),
      projectId: z.string().optional(),
      status: z.enum(["completed", "partial", "failed"]),
      recoveredTables: z.array(z.string()),
      failedTables: z.array(z.string()),
      recoveredRows: z.number(),
      quarantinePath: z.string(),
    }),
  ),
  RecoveryAskInstall: BusEvent.define(
    "db.recovery.ask_install",
    z.object({
      message: z.string(),
    }),
  ),
}

function corruptDir() {
  return path.join(Global.Path.data, CORRUPT_DIR)
}

function manifestPath() {
  return path.join(corruptDir(), MANIFEST_FILE)
}

export function readManifest(): RecoveryEntry[] {
  const p = manifestPath()
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, "utf-8"))
  } catch {
    return []
  }
}

function writeManifest(entries: RecoveryEntry[]) {
  mkdirSync(corruptDir(), { recursive: true })
  writeFileSync(manifestPath(), JSON.stringify(entries, null, 2))
}

function appendManifest(entry: RecoveryEntry) {
  const entries = readManifest()
  entries.push(entry)
  writeManifest(entries)
}

function updateManifest(id: string, patch: Partial<RecoveryEntry>) {
  const entries = readManifest()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return
  entries[idx] = { ...entries[idx], ...patch }
  writeManifest(entries)
}

export function detectCorruption(p: string): CorruptionType | null {
  if (p === ":memory:") return null
  const s = statSync(p, { throwIfNoEntry: false })
  if (!s) return null
  if (s.size === 0) return "empty"
  if (s.size < 512) return "truncated"

  let db: BunSqlite | undefined
  try {
    db = new BunSqlite(p, { readonly: true })
    const result = db.prepare("pragma integrity_check").get() as any
    if (result?.integrity_check === "ok") {
      const tables = db.prepare("select name from sqlite_master where type='table'").all() as any[]
      if (tables.length === 0) return "empty"
      return null
    }
    const msg = String(result?.integrity_check ?? "")
    if (msg.includes("not a database")) return "header"
    if (msg.includes("malformed")) return "mid-page"
    return "unknown"
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("not a database")) return "header"
    if (msg.includes("malformed")) return "mid-page"
    return "unknown"
  } finally {
    db?.close()
  }
}

const QUARANTINE_COOLDOWN_MS = 3_600_000

export function quarantine(dbPath: string, kind: "main" | "project" | "cron", projectId?: string): RecoveryEntry {
  if (dbPath === ":memory:") throw new Error("cannot quarantine :memory:")

  const recent = readManifest().find(
    (e) => e.originalPath === dbPath && Date.now() - e.timestamp < QUARANTINE_COOLDOWN_MS,
  )
  if (recent) return recent

  mkdirSync(corruptDir(), { recursive: true })

  const ts = Date.now()
  const id = `${ts}-${kind}-${projectId ?? "global"}`
  const base = path.basename(dbPath)
  const qPath = path.join(corruptDir(), `${ts}-${base}`)

  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbPath + suffix
    if (!existsSync(src)) continue
    try {
      renameSync(src, qPath + suffix)
    } catch {
      try {
        unlinkSync(src)
      } catch {}
    }
  }

  const corruptionType = iife(() => {
    if (existsSync(qPath)) return detectCorruption(qPath) ?? "unknown"
    return "unknown"
  })

  const entry: RecoveryEntry = {
    id,
    kind,
    projectId,
    originalPath: dbPath,
    quarantinePath: qPath,
    corruptionType,
    recoveryStatus: "pending",
    recoveredTables: [],
    failedTables: [],
    recoveredRows: 0,
    timestamp: ts,
  }

  appendManifest(entry)
  log.info("quarantined corrupted db", { kind, projectId, corruptionType, qPath })
  return entry
}

async function findSqlite3Binary(): Promise<string | null> {
  const candidates = ["sqlite3"]
  if (process.platform === "win32") {
    candidates.push(path.join(Global.Path.bin, "sqlite3.exe"))
  }
  for (const c of candidates) {
    try {
      const proc = Bun.spawnSync([c, "--version"], { stderr: "pipe" })
      if (proc.exitCode === 0) return c
    } catch {}
  }
  return null
}

async function pathB(entry: RecoveryEntry, targetDbPath: string): Promise<RecoveryResult | null> {
  if (!existsSync(entry.quarantinePath)) return null

  const sqlite3 = await findSqlite3Binary()
  if (!sqlite3) return null

  log.info("path B: sqlite3 .recover", { id: entry.id, quarantinePath: entry.quarantinePath })

  const recoverySqlPath = entry.quarantinePath + ".recovery.sql"
  const recoveryDbPath = entry.quarantinePath + ".recovery.db"

  try {
    const recoverProc = Bun.spawnSync([sqlite3, entry.quarantinePath, ".recover"], {
      stderr: "pipe",
    })

    if (recoverProc.exitCode !== 0) {
      log.warn("path B: sqlite3 .recover failed", { exitCode: recoverProc.exitCode })
      return null
    }

    const recoverySql = recoverProc.stdout.toString("utf-8")
    writeFileSync(recoverySqlPath, recoverySql)

    const importProc = Bun.spawnSync([sqlite3, recoveryDbPath, `.read ${recoverySqlPath}`], {
      stderr: "pipe",
    })

    if (importProc.exitCode !== 0) {
      log.warn("path B: importing recovery SQL failed")
      return null
    }

    // Now read from recovery DB and insert into target DB
    const targetResult = await readAndInsert(recoveryDbPath, targetDbPath)
    return targetResult
  } catch (err) {
    log.error("path B: exception", { error: String(err) })
    return null
  } finally {
    try {
      unlinkSync(recoverySqlPath)
    } catch {}
    try {
      unlinkSync(recoveryDbPath)
    } catch {}
    try {
      unlinkSync(recoveryDbPath + "-wal")
    } catch {}
    try {
      unlinkSync(recoveryDbPath + "-shm")
    } catch {}
  }
}

async function pathA(quarantinePath: string, targetDbPath: string): Promise<RecoveryResult | null> {
  if (!existsSync(quarantinePath)) return null

  log.info("path A: table-by-table read", { quarantinePath })

  let qDb: BunSqlite | undefined
  try {
    qDb = new BunSqlite(quarantinePath, { readonly: true })
  } catch {
    log.warn("path A: cannot open quarantined file")
    return null
  }

  try {
    const tables = qDb
      .prepare("select name from sqlite_master where type='table' and name not like '__drizzle%'")
      .all() as any[]
    if (tables.length === 0) {
      qDb.close()
      return { recoveredTables: [], failedTables: [], recoveredRows: 0 }
    }

    return readAndInsertFromOpenedDb(
      qDb,
      targetDbPath,
      tables.map((t: any) => t.name),
    )
  } catch (err) {
    log.warn("path A: failed to read sqlite_master", { error: String(err) })
    qDb.close()
    return null
  }
}

async function pathAPlus(quarantinePath: string, targetDbPath: string): Promise<RecoveryResult | null> {
  log.info("path A+: header reconstruction", { quarantinePath })

  const raw = readFileSync(quarantinePath)
  const template = getHealthyHeaderTemplate()

  const fixed = Buffer.from(raw)
  template.copy(fixed, 0, 0, 100)

  const pageSize = (raw[16] << 8) | raw[17]
  if ([1024, 2048, 4096, 8192, 16384, 32768].includes(pageSize)) {
    fixed[16] = raw[16]
    fixed[17] = raw[17]
  } else {
    fixed[16] = 0x10
    fixed[17] = 0x00
  }

  const totalPages = Math.floor(
    raw.length / (pageSize && [1024, 2048, 4096, 8192].includes(pageSize) ? pageSize : 4096),
  )
  fixed[28] = (totalPages >> 24) & 0xff
  fixed[29] = (totalPages >> 16) & 0xff
  fixed[30] = (totalPages >> 8) & 0xff
  fixed[31] = totalPages & 0xff

  const fixedPath = quarantinePath + ".header-fixed"
  writeFileSync(fixedPath, fixed)

  try {
    const result = await pathA(fixedPath, targetDbPath)
    try {
      unlinkSync(fixedPath)
    } catch {}
    return result
  } catch {
    try {
      unlinkSync(fixedPath)
    } catch {}
    return null
  }
}

function getHealthyHeaderTemplate(): Buffer {
  const tmpPath = path.join(corruptDir(), "header-template.db")
  mkdirSync(corruptDir(), { recursive: true })
  const tmp = new BunSqlite(tmpPath)
  tmp.exec("create table _t(x integer); insert into _t values(1);")
  tmp.close()
  const header = readFileSync(tmpPath).subarray(0, 100)
  try {
    unlinkSync(tmpPath)
  } catch {}
  return Buffer.from(header)
}

function readAndInsertFromOpenedDb(qDb: BunSqlite, targetDbPath: string, tableNames: string[]): RecoveryResult {
  const recoveredTables: string[] = []
  const failedTables: string[] = []
  let recoveredRows = 0

  const tDb = new BunSqlite(targetDbPath)

  for (const name of tableNames) {
    try {
      qDb.prepare(`select * from ${name} limit 1`).get()
      const rows = qDb.prepare(`select * from ${name}`).all() as any[]

      if (rows.length > 0) {
        const cols = Object.keys(rows[0])
        const insertSql = `INSERT OR IGNORE INTO ${name} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
        const stmt = tDb.prepare(insertSql)

        for (const row of rows) {
          try {
            stmt.run(...cols.map((c) => row[c]))
            recoveredRows++
          } catch {}
        }
      }

      recoveredTables.push(name)
      publish(DbEvent.RecoveryProgress, { id: "", phase: "path-a", table: name, recoveredRows })
    } catch (err) {
      log.warn("path A: table unreadable", { table: name, error: String(err) })
      failedTables.push(name)
    }
  }

  qDb.close()
  tDb.close()
  return { recoveredTables, failedTables, recoveredRows }
}

async function readAndInsert(recoveryDbPath: string, targetDbPath: string): Promise<RecoveryResult | null> {
  if (!existsSync(recoveryDbPath)) return null

  let rDb: BunSqlite | undefined
  try {
    rDb = new BunSqlite(recoveryDbPath, { readonly: true })
    const tables = rDb
      .prepare("select name from sqlite_master where type='table' and name not like '__drizzle%'")
      .all() as any[]
    if (tables.length === 0) {
      rDb.close()
      return { recoveredTables: [], failedTables: [], recoveredRows: 0 }
    }

    return readAndInsertFromOpenedDb(
      rDb,
      targetDbPath,
      tables.map((t: any) => t.name),
    )
  } catch (err) {
    log.warn("path B: recovery DB unreadable", { error: String(err) })
    rDb?.close()
    return null
  }
}

function getTargetDbPath(entry: RecoveryEntry): string {
  switch (entry.kind) {
    case "main":
      return Database.Path
    case "project":
      return Database.projectPath(entry.projectId!)
    case "cron":
      return Database.cronPath()
  }
}

function mergeResults(a: RecoveryResult | null, b: RecoveryResult | null): RecoveryResult {
  const recoveredTables = new Set([...(a?.recoveredTables ?? []), ...(b?.recoveredTables ?? [])])
  const failedTables = [...(a?.failedTables ?? []), ...(b?.failedTables ?? [])].filter((t) => !recoveredTables.has(t))
  const recoveredRows = (a?.recoveredRows ?? 0) + (b?.recoveredRows ?? 0)
  return { recoveredTables: [...recoveredTables], failedTables, recoveredRows }
}

import { Database } from "./db"

export namespace DbRecovery {
  export async function runAfterStartup() {
    const manifest = readManifest()
    const pending = manifest.filter((e) => e.recoveryStatus === "pending")
    if (pending.length === 0) return

    publish(DbEvent.RecoveryStarted, { entries: pending.length })
    log.info("starting recovery for pending entries", { count: pending.length })

    for (const entry of pending) {
      await recoverOne(entry)
    }

    // After recovery, refresh main DB project mappings
    try {
      Database.registerUntrackedProjects(Database.Client())
      log.info("refreshed main db project mappings after recovery")
    } catch (err) {
      log.warn("failed to refresh project mappings after recovery", { error: String(err) })
    }
  }

  async function recoverOne(entry: RecoveryEntry) {
    updateManifest(entry.id, { recoveryStatus: "attempting" })

    const targetPath = getTargetDbPath(entry)
    if (!existsSync(targetPath)) {
      log.warn("target db does not exist, skipping recovery", { targetPath })
      updateManifest(entry.id, { recoveryStatus: "failed" })
      return
    }

    let result: RecoveryResult | null = null

    // BAB strategy: B first, then A, then A+
    const sqlite3 = await findSqlite3Binary()
    if (sqlite3) {
      log.info("BAB: sqlite3 available, trying path B first", { sqlite3 })
      result = await pathB(entry, targetPath)
    }

    if (!result || result.failedTables.length > 0) {
      log.info("BAB: trying path A")
      const aResult = await pathA(entry.quarantinePath, targetPath)
      if (aResult) {
        result = mergeResults(result, aResult)
      }
    }

    if (!result && entry.corruptionType === "header") {
      log.info("BAB: trying path A+ (header reconstruction)")
      const aPlusResult = await pathAPlus(entry.quarantinePath, targetPath)
      if (aPlusResult) {
        result = mergeResults(result, aPlusResult)
      }
    }

    // If path B wasn't tried because sqlite3 wasn't available, ask user to install
    if (!sqlite3 && (!result || result.failedTables.length > 0)) {
      log.info("BAB: sqlite3 not available, asking user to install")
      publish(DbEvent.RecoveryAskInstall, {
        message: "sqlite3 is not installed. Installing it can improve database recovery. Would you like to install it?",
      })
      // User confirmation would be handled via SSE/UI; for now we just log and keep status
    }

    const status: RecoveryEntry["recoveryStatus"] = iife(() => {
      if (!result) return "failed"
      if (result.recoveredTables.length === 0) return "failed"
      if (result.failedTables.length > 0) return "partial"
      return "completed"
    })

    updateManifest(entry.id, {
      recoveryStatus: status,
      recoveredTables: result?.recoveredTables ?? [],
      failedTables: result?.failedTables ?? [],
      recoveredRows: result?.recoveredRows ?? 0,
    })

    publish(DbEvent.RecoveryCompleted, {
      id: entry.id,
      kind: entry.kind,
      projectId: entry.projectId,
      status,
      recoveredTables: result?.recoveredTables ?? [],
      failedTables: result?.failedTables ?? [],
      recoveredRows: result?.recoveredRows ?? 0,
      quarantinePath: entry.quarantinePath,
    })
  }

  export function hasPendingRecovery(): boolean {
    return readManifest().some((e) => e.recoveryStatus === "pending")
  }

  export function pendingEntries(): RecoveryEntry[] {
    return readManifest().filter((e) => e.recoveryStatus === "pending")
  }
}
