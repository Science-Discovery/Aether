import fs from "fs/promises"
import path from "path"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { channelSlug } from "../persist/naming"

const BASE_PORT = 19527
const PORT_SPAN = 5

export type Clients = { desktop: number; web: number }

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type Info = {
  pid: number
  channel: string
  kind: "desktop" | "web"
  clients: Clients
}

let streams = 0
let selfPort: number | undefined

export function parse(value: unknown): Info | null {
  if (!value || typeof value !== "object") return null
  const data = value as Record<string, unknown>
  const raw = data.clients as Record<string, unknown> | undefined
  if (typeof data.pid !== "number") return null
  if (typeof data.channel !== "string") return null
  if (data.kind !== "desktop" && data.kind !== "web") return null
  if (!raw || typeof raw.desktop !== "number" || typeof raw.web !== "number") return null
  return {
    pid: data.pid,
    channel: data.channel,
    kind: data.kind,
    clients: { desktop: raw.desktop, web: raw.web },
  }
}

const SUPPRESS_HEADER = "x-aether-presence-scan"

export function scanSuppressed(header: string | undefined) {
  return header === "0"
}

async function probe(port: number, fetchImpl: FetchLike): Promise<Info | null> {
  const url = `http://127.0.0.1:${port}/global/presence`
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(1_500),
    headers: { [SUPPRESS_HEADER]: "0" },
  }).catch(() => null)
  if (!res || !res.ok) return null
  return parse(await res.json().catch(() => null))
}

async function candidatePorts(): Promise<number[]> {
  const ports = new Set<number>()
  for (let i = 0; i < PORT_SPAN; i++) ports.add(BASE_PORT + i)
  const dirs = [Global.Path.data]
  const entries = await fs.readdir(Global.Path.data, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(path.join(Global.Path.data, entry.name))
  }
  for (const dir of dirs) {
    const raw = await fs.readFile(path.join(dir, "serve-port"), "utf8").catch(() => null)
    if (raw === null) continue
    const port = Number.parseInt(raw.trim(), 10)
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
  }
  return [...ports]
}

let inflight: Promise<Info[]> | null = null

export namespace Presence {
  export function kind(): "desktop" | "web" {
    return Flag.OPENCODE_CLIENT === "desktop" ? "desktop" : "web"
  }

  export function attach(port: number | undefined) {
    selfPort = port
  }

  export function open() {
    streams++
  }

  export function close() {
    streams = Math.max(0, streams - 1)
  }

  export function clients(): Clients {
    return kind() === "desktop" ? { desktop: streams, web: 0 } : { desktop: 0, web: streams }
  }

  export function info(): Info {
    return { pid: process.pid, channel: channelSlug(), kind: kind(), clients: clients() }
  }

  export async function others(fetchImpl: FetchLike = fetch): Promise<Info[]> {
    if (selfPort === undefined) return []
    if (process.env.AETHER_PRESENCE_SCAN === "0") return []
    if (inflight) return inflight
    inflight = scan().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function scan(): Promise<Info[]> {
    const found = new Map<number, Info>()
    const ports = await candidatePorts()
    await Promise.all(
      ports.map(async (port) => {
        if (port === selfPort) return
        const info = await probe(port, fetch)
        if (info && info.pid !== process.pid) found.set(info.pid, info)
      }),
    )
    return [...found.values()]
  }
}
