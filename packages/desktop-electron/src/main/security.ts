import { stat } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

export function external(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null
  } catch {
    return null
  }
}

export function blob(url: string): boolean {
  try {
    return new URL(url).protocol === "blob:"
  } catch {
    return false
  }
}

export function appCheck(devUrl: string | undefined, rendererDir: string): (url: string) => boolean {
  const origin = devUrl ? parseOrigin(devUrl) : null
  if (origin)
    return (url) => {
      try {
        return new URL(url).origin === origin
      } catch {
        return false
      }
    }

  return (url) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== "file:") return false
      const rel = relative(rendererDir, fileURLToPath(parsed))
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
    } catch {
      return false
    }
  }
}

function parseOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export async function assertDir(path: unknown): Promise<void> {
  if (typeof path !== "string" || path.length === 0) throw new Error("open-path requires a directory path")
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error("open-path only accepts directories")
}
