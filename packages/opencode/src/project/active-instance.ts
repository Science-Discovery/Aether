const subs = new Set<(directory: string) => void>()
const deactivations = new Set<(directory: string) => void>()
const counts = new Map<string, number>()

export const ActiveInstance = {
  is(directory: string) {
    return (counts.get(directory) ?? 0) > 0
  },
  activate(directory: string) {
    const n = (counts.get(directory) ?? 0) + 1
    counts.set(directory, n)
    if (n === 1) {
      for (const sub of subs) sub(directory)
    }
  },
  deactivate(directory: string) {
    const n = counts.get(directory) ?? 0
    if (n === 0) return
    const next = n - 1
    if (next === 0) {
      counts.delete(directory)
      for (const fn of deactivations) fn(directory)
    } else {
      counts.set(directory, next)
    }
  },
  forceDeactivate(directory: string) {
    if (!counts.has(directory)) return
    counts.delete(directory)
    for (const fn of deactivations) fn(directory)
  },
  subscribe(sub: (directory: string) => void) {
    subs.add(sub)
    return () => {
      subs.delete(sub)
    }
  },
  replay(directory: string) {
    if ((counts.get(directory) ?? 0) === 0) return
    for (const sub of subs) sub(directory)
  },
  onDeactivate(fn: (directory: string) => void) {
    deactivations.add(fn)
    return () => {
      deactivations.delete(fn)
    }
  },
}
