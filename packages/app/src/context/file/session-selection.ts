/**
 * Session-scoped file selection store.
 *
 * Keeps per-session file path selections isolated so that two sessions
 * open in the same project don't leak selection state into each other.
 */
export function createSessionSelection<T = Set<string>>() {
  const store = new Map<string, T>()
  const empty = new Set<string>() as unknown as T

  function get(sessionId: string): T {
    return store.get(sessionId) ?? empty
  }

  function set(sessionId: string, valueOrFn: T | ((prev: T) => T)) {
    const prev = store.get(sessionId) ?? empty
    const next = typeof valueOrFn === "function" ? (valueOrFn as (prev: T) => T)(prev) : valueOrFn
    if (next instanceof Set && (next as Set<unknown>).size === 0) {
      store.delete(sessionId)
    } else {
      store.set(sessionId, next)
    }
  }

  function clear(sessionId: string) {
    store.delete(sessionId)
  }

  return { get, set, clear }
}
