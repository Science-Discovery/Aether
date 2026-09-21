import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { aetherDataDir } from "./paths"

const BASE_PORT = 19527
const PORT_SPAN = 5

export type Clients = { desktop: number; web: number }

export type Info = {
  pid: number
  channel: string
  kind: "desktop" | "web"
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
  if (data.kind !== "desktop" && data.kind !== "web") return null
  if (!raw || typeof raw.desktop !== "number" || typeof raw.web !== "number") return null
  return {
    pid: data.pid,
    channel: data.channel,
    kind: data.kind,
    clients: { desktop: raw.desktop, web: raw.web },
  }
}

async function defaultProbe(port: number): Promise<Info | null> {
  const url = `http://127.0.0.1:${port}/global/presence`
  const res = await fetch(url, { signal: AbortSignal.timeout(2_500) }).catch(() => null)
  if (!res || !res.ok) return null
  return parse(await res.json().catch(() => null))
}

export async function conflict(
  opts: { root?: string; probe?: (port: number) => Promise<Info | null> } = {},
): Promise<Info[]> {
  const probe = opts.probe ?? defaultProbe
  const found = new Map<number, Info>()
  await Promise.all(
    ports(opts.root).map(async (port) => {
      const info = await probe(port)
      if (info) found.set(info.pid, info)
    }),
  )
  return [...found.values()]
}

export function detail(infos: Info[]) {
  const web = infos.reduce((sum, info) => sum + info.clients.web, 0)
  const desktop = infos.reduce((sum, info) => sum + info.clients.desktop, 0)
  const parts = []
  if (web > 0) parts.push("the web version (browser)")
  if (desktop > 0) parts.push("another desktop app")
  return `${parts.join(" and ")} currently connected. Only one app can be connected at a time.`
}
