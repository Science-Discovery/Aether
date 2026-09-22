export type ClientType = "desktop" | "web"

export type PresenceData = {
  pid?: number
  channel?: string
  clients?: { desktop?: number; web?: number }
  others?: { pid: number; channel: string; clients: { desktop: number; web: number } }[]
}

export type Conflict = { channel: string }

export function conflictOf(data: PresenceData): Conflict | null {
  const desktop = data.clients?.desktop ?? 0
  if (desktop === 0 && (data.others?.length ?? 0) === 0) return null
  return { channel: data.channel ?? "" }
}

export async function presenceConflict(
  url: string,
  opts: { fetch?: typeof fetch; timeout?: number } = {},
): Promise<Conflict | null> {
  const fetchImpl = opts.fetch ?? fetch
  try {
    const target = new URL("/global/presence", `${url.replace(/\/+$/, "")}/`)
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(opts.timeout ?? 5_000) })
    if (!res.ok) return null
    const data = (await res.json()) as PresenceData | null
    if (!data || typeof data !== "object") return null
    return conflictOf(data)
  } catch {
    return null
  }
}
