/**
 * Keyed in-flight tracking for fetch-style loads. Non-force callers join the
 * pending promise; force callers supersede it with a new claim. Callers must
 * drop results whose claim is no longer `fresh`, so a slow stale response
 * never overwrites a newer one.
 */
export function createInflight() {
  const pending = new Map<string, Promise<void>>()
  const seq = new Map<string, number>()
  return {
    held: (key: string, force?: boolean) => {
      if (force) return
      return pending.get(key)
    },
    claim: (key: string) => {
      const next = (seq.get(key) ?? 0) + 1
      seq.set(key, next)
      return next
    },
    fresh: (key: string, id: number) => seq.get(key) === id,
    attach: (key: string, promise: Promise<void>) => pending.set(key, promise),
    detach: (key: string, promise: Promise<void>) => {
      if (pending.get(key) === promise) pending.delete(key)
    },
    reset: () => {
      pending.clear()
      seq.clear()
    },
  }
}
