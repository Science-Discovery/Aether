export type ClientType = "desktop" | "web"

export type Program = { type: ClientType; id: string }

export type PresenceData = {
  pid?: number
  channel?: string
  programs?: Program[]
  others?: { pid: number; channel: string; programs: Program[] }[]
}

export type Conflict = { channel: string }

const ID_KEY = "aether-client-id"

export function clientId(): string {
  try {
    const existing = localStorage.getItem(ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    localStorage.setItem(ID_KEY, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

export function conflictOf(data: PresenceData, id: string): Conflict | null {
  const programs = data.programs ?? []
  const foreign = programs.some((p) => p.type === "desktop" || (p.type === "web" && p.id !== id))
  if (!foreign && (data.others?.length ?? 0) === 0) return null
  return { channel: data.channel ?? "" }
}

export async function presenceConflict(
  url: string,
  opts: { fetch?: typeof fetch; timeout?: number; id: string },
): Promise<Conflict | null> {
  const fetchImpl = opts.fetch ?? fetch
  try {
    const target = new URL("/global/presence", `${url.replace(/\/+$/, "")}/`)
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(opts.timeout ?? 5_000) })
    if (!res.ok) return null
    const data = (await res.json()) as PresenceData | null
    if (!data || typeof data !== "object") return null
    return conflictOf(data, opts.id)
  } catch {
    return null
  }
}
