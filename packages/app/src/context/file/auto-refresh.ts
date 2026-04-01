/**
 * Periodic auto-refresh for the file tree.
 *
 * In long-running sessions WebSocket events can be missed or the connection
 * may drop silently. This utility periodically calls `refreshDir("")` (root)
 * to keep the tree in sync with the actual filesystem.
 */

export type AutoRefreshOptions = {
  /** Interval between refreshes in milliseconds. */
  intervalMs: number
  /** Called on every tick – typically `tree.refreshDir("")`. */
  refreshDir: (dir: string) => void
  /** Injectable clock for testing. Defaults to `Date.now`. */
  getNow?: () => number
}

export function createAutoRefresh(options: AutoRefreshOptions) {
  const { intervalMs, refreshDir } = options
  let timer: ReturnType<typeof setInterval> | undefined

  const tick = () => {
    try {
      refreshDir("")
    } catch {
      // Swallow errors so the interval keeps running.
    }
  }

  const start = () => {
    if (timer !== undefined) return
    timer = setInterval(tick, intervalMs)
  }

  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  return { start, stop }
}
