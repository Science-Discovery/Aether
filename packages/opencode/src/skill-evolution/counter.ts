const _counters = new Map<string, number>()

export namespace Counter {
  /** Increment the per-session tool-call counter by 1. */
  export function increment(sessionID: string): void {
    _counters.set(sessionID, (_counters.get(sessionID) ?? 0) + 1)
  }

  /** Return the current counter value without modifying it. */
  export function get(sessionID: string): number {
    return _counters.get(sessionID) ?? 0
  }

  /** Return the current value and reset the counter to 0. */
  export function getAndReset(sessionID: string): number {
    const val = _counters.get(sessionID) ?? 0
    _counters.delete(sessionID)
    return val
  }

  /** Reset the counter to 0 without returning the value. */
  export function reset(sessionID: string): void {
    _counters.delete(sessionID)
  }
}
