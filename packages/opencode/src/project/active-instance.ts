const subs = new Set<(directory: string) => void>()
const deactivations = new Set<(directory: string) => void>()
const counts = new Map<string, number>()
const owners = new Map<string, string>()

function inc(directory: string) {
  const n = (counts.get(directory) ?? 0) + 1
  counts.set(directory, n)
  if (n === 1) {
    for (const sub of subs) sub(directory)
  }
}

function dec(directory: string) {
  const n = counts.get(directory) ?? 0
  if (n === 0) return
  const next = n - 1
  if (next === 0) {
    counts.delete(directory)
    for (const fn of deactivations) fn(directory)
    return
  }
  counts.set(directory, next)
}

export const ActiveInstance = {
  is(directory: string) {
    return (counts.get(directory) ?? 0) > 0
  },
  activate(directory: string) {
    inc(directory)
  },
  deactivate(directory: string) {
    dec(directory)
  },
  activateOwner(owner: string, directory: string) {
    const prev = owners.get(owner)
    if (prev === directory) return
    if (prev) dec(prev)
    owners.set(owner, directory)
    inc(directory)
  },
  deactivateOwner(owner: string) {
    const prev = owners.get(owner)
    if (!prev) return
    owners.delete(owner)
    dec(prev)
  },
  forceDeactivate(directory: string) {
    const active = counts.has(directory)
    for (const [owner, dir] of owners.entries()) {
      if (dir === directory) owners.delete(owner)
    }
    if (!active) return
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
