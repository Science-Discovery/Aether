export function known(dir: string, dirs: string[]) {
  const key = (value: string) => {
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      return `win:${value.replace(/\\/g, "/").replace(/\/+$/, "")}`
    }
    return `path:${value.replace(/\/+$/, "") || value}`
  }
  return new Set(dirs.map(key)).has(key(dir))
}
