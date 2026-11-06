import fs from "fs/promises"
import path from "path"
import { Instance } from "../project/instance"

const types: Record<string, string> = {
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".jfif": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/vnd.microsoft.icon",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".apng": "image/apng",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
}

function contains(root: string, file: string) {
  const rel = path.relative(root, file)
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)
}

export namespace Preview {
  export class Error extends globalThis.Error {
    constructor(
      readonly status: 400 | 403 | 415,
      message: string,
    ) {
      super(message)
    }
  }

  export async function resource(input: string) {
    if (!Instance.containsPath(Instance.directory)) {
      throw new Error(403, "Access denied: unvalidated preview workspace")
    }
    if (
      !input ||
      input.includes("\0") ||
      path.isAbsolute(input) ||
      path.win32.isAbsolute(input) ||
      /^[a-z][a-z\d+.-]*:/i.test(input)
    ) {
      throw new Error(400, "Preview resource path must be relative to the workspace")
    }
    const type = types[path.extname(input).toLowerCase()]
    if (!type) throw new Error(415, "Preview resources must be CSS, images, or fonts")
    const file = path.resolve(Instance.directory, input)
    if (!contains(Instance.directory, file)) throw new Error(403, "Access denied: preview resource escapes workspace")
    const [root, real] = await Promise.all([fs.realpath(Instance.directory), fs.realpath(file)])
    if (!contains(root, real)) throw new Error(403, "Access denied: preview resource escapes workspace")
    if (types[path.extname(real).toLowerCase()] !== type) {
      throw new Error(415, "Preview resource target has an unsupported type")
    }
    const stat = await fs.stat(real)
    if (!stat.isFile()) throw new Error(400, "Preview resource must point to a file")
    return { file: Bun.file(real), type, stat }
  }
}
