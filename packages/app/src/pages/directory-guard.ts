export function known(dir: string, dirs: string[]) {
  const key = (value: string) => {
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      return `win:${value.replace(/\\/g, "/").replace(/\/+$/, "")}`
    }
    const unc = value.startsWith("\\\\") ? value.replace(/\\/g, "/") : value
    if (/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(unc) && !unc.includes("\\") && !/^\/\/[?.]\//.test(unc)) {
      return `unc:${unc.replace(/\/+$/, "")}`
    }
    return `path:${value.replace(/\/+$/, "") || value}`
  }
  return new Set(dirs.map(key)).has(key(dir))
}

// Directory lists rarely change between navigation bursts, and the request can
// queue for seconds behind a busy server, so a fresh list validates instantly.
const ttl = 30_000
const seen = new Map<string, { dirs: string[]; at: number }>()

export function fresh(key: string, dir: string) {
  const entry = seen.get(key)
  return !!entry && Date.now() - entry.at < ttl && known(dir, entry.dirs)
}

export function remember(key: string, dirs: string[]) {
  seen.set(key, { dirs, at: Date.now() })
}

export function forget() {
  seen.clear()
}
