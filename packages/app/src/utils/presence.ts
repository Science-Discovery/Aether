export type Conflict = { desktop: number }

export async function presenceConflict(
  url: string,
  opts: { fetch?: typeof fetch; timeout?: number } = {},
): Promise<Conflict | null> {
  const fetchImpl = opts.fetch ?? fetch
  try {
    const target = new URL("/global/presence", `${url.replace(/\/+$/, "")}/`)
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(opts.timeout ?? 5_000) })
    if (!res.ok) return null
    const data = (await res.json()) as { others?: unknown }
    if (!data || !Array.isArray(data.others)) return null
    let desktop = 0
    for (const item of data.others) {
      const clients = (item as { clients?: { desktop?: unknown } } | null)?.clients
      const count = clients?.desktop
      if (typeof count === "number" && count > 0) desktop += count
    }
    return desktop > 0 ? { desktop } : null
  } catch {
    return null
  }
}
