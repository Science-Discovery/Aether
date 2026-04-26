import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Flag } from "../flag/flag"

type Entry = {
  id: string
  pid: number
  url: string
  started_at: number
  updated_at: number
  state: "active" | "closing" | "stale"
}

const dir = () => path.join(Global.Path.data, "instances")

function filepath(id: string) {
  return path.join(dir(), `${id}.json`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export namespace Registry {
  export function id(): string {
    const prefix = Date.now().toString(36)
    const suffix = Math.random().toString(36).slice(2, 8)
    return `ins_${prefix}_${suffix}`
  }

  export async function ensureDir() {
    await fs.mkdir(dir(), { recursive: true })
  }

  export async function write(entry: Entry) {
    await ensureDir()
    await fs.writeFile(filepath(entry.id), JSON.stringify(entry, null, 2))
  }

  export async function remove(id: string) {
    await fs.rm(filepath(id), { force: true })
  }

  export async function read(id: string): Promise<Entry | undefined> {
    const raw = await fs.readFile(filepath(id), "utf-8").catch(() => undefined)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as Entry
    } catch {
      return undefined
    }
  }

  export async function list(): Promise<Entry[]> {
    await ensureDir()
    const files = await fs.readdir(dir())
    const entries: Entry[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const raw = await fs.readFile(path.join(dir(), file), "utf-8").catch(() => undefined)
      if (!raw) continue
      try {
        entries.push(JSON.parse(raw) as Entry)
      } catch {
        await fs.rm(path.join(dir(), file), { force: true })
      }
    }
    return entries
  }

  export async function prune(): Promise<{ removed: string[]; kept: Entry[] }> {
    const entries = await list()
    const removed: string[] = []
    const kept: Entry[] = []
    const now = Date.now()
    for (const entry of entries) {
      const alive = isAlive(entry.pid)
      const staleTooLong = entry.state === "stale" && now - entry.updated_at > STALE_TTL_MS
      if (!alive || staleTooLong) {
        removed.push(entry.id)
        await remove(entry.id)
      } else {
        kept.push(entry)
      }
    }
    return { removed, kept }
  }

  export async function healthCheck(url: string): Promise<boolean> {
    try {
      const res = await fetch(new URL("/global/health", url), {
        method: "GET",
        headers: authHeaders(),
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  export async function queryStatus(url: string): Promise<Status | undefined> {
    try {
      const res = await fetch(new URL("/global/status", url), {
        method: "GET",
        headers: authHeaders(),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return undefined
      return (await res.json()) as Status
    } catch {
      return undefined
    }
  }

  export async function accelerate(url: string): Promise<boolean> {
    try {
      const res = await fetch(new URL("/global/accelerate-exit", url), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  export async function pruneWithHealthCheck(): Promise<{ removed: string[]; kept: Entry[] }> {
    const { removed: dead, kept: candidates } = await prune()
    const removed = [...dead]
    const kept: Entry[] = []
    const now = Date.now()
    for (const entry of candidates) {
      const healthy = await healthCheck(entry.url)
      const closingTooLong = entry.state === "closing" && now - entry.updated_at > CLOSING_GRACE_MS
      if (!healthy || closingTooLong) {
        removed.push(entry.id)
        await remove(entry.id)
      } else {
        kept.push(entry)
      }
    }
    return { removed, kept }
  }

  export function create(pid: number, url: string): Entry {
    const now = Date.now()
    return {
      id: id(),
      pid,
      url,
      started_at: now,
      updated_at: now,
      state: "active",
    }
  }
}

const CLOSING_GRACE_MS = 30_000
const STALE_TTL_MS = 300_000

type Status = {
  healthy: boolean
  version: string
  connections: {
    sse: number
    globalSse: number
    leaseActive: number
    leaseClosing: number
  }
  accelerateExit: boolean
}

function authHeaders(): Record<string, string> {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return {}
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}
