import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { channelSlug } from "../persist/naming"

const BASE_PORT = 19527
const PORT_SPAN = 5

export type ClientType = "desktop" | "web"
export type Clients = { desktop: number; web: number }
export type Info = { pid: number; channel: string; clients: Clients }

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let seq = 0
const live = new Map<number, ClientType>()

export function parse(value: unknown): Info | null {
  if (!value || typeof value !== "object") return null
  const data = value as Record<string, unknown>
  const raw = data.clients as Record<string, unknown> | undefined
  if (typeof data.pid !== "number") return null
  if (typeof data.channel !== "string") return null
  if (!raw || typeof raw.desktop !== "number" || typeof raw.web !== "number") return null
  return { pid: data.pid, channel: data.channel, clients: { desktop: raw.desktop, web: raw.web } }
}

export function marker(type: string | undefined): ClientType {
  return type === "desktop" ? "desktop" : "web"
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
  export function join(type: ClientType): number {
    const key = ++seq
    live.set(key, type)
    return key
  }

  export function leave(key: number) {
    live.delete(key)
  }

  export function clients(): Clients {
    let desktop = 0
    let web = 0
    for (const type of live.values()) {
      if (type === "desktop") desktop++
      else web++
    }
    return { desktop, web }
  }

  export function info(): Info {
    return { pid: process.pid, channel: channelSlug(), clients: clients() }
  }

  export async function others(fetchImpl: FetchLike = fetch): Promise<Info[]> {
    if (process.env.AETHER_PRESENCE_SCAN === "0") return []
    if (inflight) return inflight
    inflight = scan(fetchImpl).finally(() => {
      inflight = null
    })
    return inflight
  }

  async function scan(fetchImpl: FetchLike): Promise<Info[]> {
    const found = new Map<number, Info>()
    const ports = await candidatePorts()
    await Promise.all(
      ports.map(async (port) => {
        const info = await probe(port, fetchImpl)
        if (info && info.pid !== process.pid && info.channel === channelSlug()) found.set(info.pid, info)
      }),
    )
    return [...found.values()]
  }
}
