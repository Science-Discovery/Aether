/**
 * Session-scoped file selection map.
 *
 Keeps file tree selections isolated per session so that
 * two sessions open in the same project never share state.
 */
export interface SessionSelectionMap {
  get(sessionId: string): Set<string>
  set(sessionId: string, value: Set<string>): void
}

export function createSessionSelectionMap(): SessionSelectionMap {
  const store = new Map<string, Set<string>>()

  return {
    get(sessionId: string): Set<string> {
      return store.get(sessionId) ?? new Set()
    },
    set(sessionId: string, value: Set<string>): void {
      if (value.size === 0) {
        store.delete(sessionId)
      } else {
        store.set(sessionId, value)
      }
    },
  }
}
