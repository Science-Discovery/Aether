let forced: "win32" | undefined

const isWin = () => forced === "win32" || (typeof process !== "undefined" && process.platform === "win32")

export function setPathPlatform(platform: "win32" | undefined) {
  forced = platform
}

export function norm(input: string): string {
  if (!input) return input
  const next = input.replace(/\\/g, "/")
  const result = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
  if (isWin() && /^[A-Za-z]:/.test(result)) {
    const out = result.replace(/\//g, "\\")
    if (/^[A-Za-z]:$/.test(out)) return out + "\\"
    return out
  }
  return result
}

export function displayPath(directory: string, home: string) {
  const normDir = norm(directory)
  const normHome = norm(home)
  return normDir.startsWith(normHome) ? "~" + normDir.slice(normHome.length) : normDir
}

export function getFilename(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[\/\\]+$/, "")
  const parts = trimmed.split(/[\/\\]/)
  return parts[parts.length - 1] ?? ""
}

export function getDirectory(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[\/\\]+$/, "")
  const parts = trimmed.split(/[\/\\]/)
  return parts.slice(0, parts.length - 1).join("/") + "/"
}

export function getFileExtension(path: string | undefined) {
  if (!path) return ""
  const parts = path.split(".")
  return parts[parts.length - 1]
}

export function getFilenameTruncated(path: string | undefined, maxLength: number = 20) {
  const filename = getFilename(path)
  if (filename.length <= maxLength) return filename
  const lastDot = filename.lastIndexOf(".")
  const ext = lastDot <= 0 ? "" : filename.slice(lastDot)
  const available = maxLength - ext.length - 1 // -1 for ellipsis
  if (available <= 0) return filename.slice(0, maxLength - 1) + "…"
  return filename.slice(0, available) + "…" + ext
}

export function truncateMiddle(text: string, maxLength: number = 20) {
  if (text.length <= maxLength) return text
  const available = maxLength - 1 // -1 for ellipsis
  const start = Math.ceil(available / 2)
  const end = Math.floor(available / 2)
  return text.slice(0, start) + "…" + text.slice(-end)
}
