import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { aetherDataDir } from "./paths"

const BASE_PORT = 19527
const PORT_SPAN = 5
const SUPPRESS_HEADER = "x-aether-presence-scan"

export type Clients = { desktop: number; web: number }

export type Info = {
  pid: number
  channel: string
  clients: Clients
}

export function ports(root = aetherDataDir()) {
  const found = new Set<number>()
  for (let i = 0; i < PORT_SPAN; i++) found.add(BASE_PORT + i)
  const dirs = [root]
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(root, entry.name))
    }
  } catch {}
  for (const dir of dirs) {
    try {
      const port = Number.parseInt(readFileSync(join(dir, "serve-port"), "utf8").trim(), 10)
      if (Number.isInteger(port) && port > 0 && port < 65536) found.add(port)
    } catch {}
  }
  return [...found]
}

export function parse(value: unknown): Info | null {
  if (!value || typeof value !== "object") return null
  const data = value as Record<string, unknown>
  const raw = data.clients as Record<string, unknown> | undefined
  if (typeof data.pid !== "number") return null
  if (typeof data.channel !== "string") return null
  if (!raw || typeof raw.desktop !== "number" || typeof raw.web !== "number") return null
  return { pid: data.pid, channel: data.channel, clients: { desktop: raw.desktop, web: raw.web } }
}

async function defaultProbe(port: number): Promise<Info | null> {
  const url = `http://127.0.0.1:${port}/global/presence`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(2_500),
    headers: { [SUPPRESS_HEADER]: "0" },
  }).catch(() => null)
  if (!res || !res.ok) return null
  return parse(await res.json().catch(() => null))
}

export async function conflict(
  opts: { root?: string; channel: string; probe?: (port: number) => Promise<Info | null> } = { channel: "" },
): Promise<Info[]> {
  const probe = opts.probe ?? defaultProbe
  const found = new Map<number, Info>()
  await Promise.all(
    ports(opts.root).map(async (port) => {
      const info = await probe(port)
      if (info && info.channel === opts.channel) found.set(info.pid, info)
    }),
  )
  return [...found.values()]
}

export function channelSlug(channel: string) {
  return channel === "beta" || channel === "latest" ? "latest" : channel
}

export function detail(infos: Info[], channel: string) {
  const web = infos.some((info) => info.clients.web > 0)
  const desktop = infos.some((info) => info.clients.desktop > 0)
  const parts = []
  if (web) parts.push("the web version (browser)")
  if (desktop) parts.push("another desktop app")
  const who = parts.length > 0 ? `${parts.join(" and ")} is` : "another Aether server is"
  return `${who} already using the "${channel}" channel. Only one app can use a channel at a time.`
}
