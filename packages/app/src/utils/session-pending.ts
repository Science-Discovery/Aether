const pending = new Map<string, Promise<unknown>>()

export function claimSession<T>(id: string, task: () => Promise<T>) {
  const tracked = task().finally(() => pending.delete(id))
  tracked.catch(() => undefined)
  pending.set(id, tracked)
  return tracked
}

export async function waitSession(id: string) {
  const claim = pending.get(id)
  if (!claim) return true
  try {
    await claim
    return true
  } catch {
    return false
  }
}
