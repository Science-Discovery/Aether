import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { aetherDataDir } from "./paths"

const BASE_PORT = 19527
const PORT_SPAN = 5
const SUPPRESS_HEADER = "x-aether-presence-scan"

export type Program = { type: "desktop" | "web"; id: string }

export type Info = {
  pid: number
  channel: string
  programs: Program[]
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
  const raw = data.programs as unknown
  if (typeof data.pid !== "number") return null
  if (typeof data.channel !== "string") return null
  if (!Array.isArray(raw)) return null
  const programs: Program[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") return null
    const p = item as Record<string, unknown>
    if ((p.type !== "desktop" && p.type !== "web") || typeof p.id !== "string") return null
    programs.push({ type: p.type, id: p.id })
  }
  return { pid: data.pid, channel: data.channel, programs }
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
  const web = infos.some((info) => info.programs.some((p) => p.type === "web"))
  const desktop = infos.some((info) => info.programs.some((p) => p.type === "desktop"))
  const parts = []
  if (web) parts.push("the web version (browser)")
  if (desktop) parts.push("another desktop app")
  const who = parts.length > 0 ? `${parts.join(" and ")} is` : "another Aether server is"
  return `${who} already using the "${channel}" channel. Only one app can use a channel at a time.`
}
