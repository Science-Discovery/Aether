import path from "node:path"
import fs from "node:fs/promises"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"

const limit = 512 * 1024 * 1024
const inflate = promisify(gunzip)

function safe(value: string) {
  const normalized = value.replaceAll("\\", "/")
  if (!normalized || /[\u0000-\u001f:]/.test(normalized) || normalized.startsWith("/"))
    throw new Error("The rtex archive contains an unsafe path.")
  const parts = normalized.split("/").filter(Boolean)
  if (!parts.length || parts.some((part) => part === "." || part === ".."))
    throw new Error("The rtex archive contains an unsafe path.")
  return parts.join("/")
}

async function target(root: string, value: string) {
  const file = path.resolve(root, safe(value))
  const rel = path.relative(root, file)
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`))
    throw new Error("The rtex archive contains an unsafe path.")
  return file
}

export async function extract(bytes: Uint8Array, format: "zip" | "tar.gz", root: string, signal: AbortSignal) {
  signal.throwIfAborted()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  if (format === "zip") {
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), { useWebWorkers: false, signal })
    try {
      let count = 0
      for await (const entry of reader.getEntriesGenerator()) {
        signal.throwIfAborted()
        if (++count > 5000) throw new Error("The rtex archive contains too many entries.")
        const file = await target(root, entry.filename)
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000
        if (entry.encrypted || (mode && mode !== (entry.directory ? 0x4000 : 0x8000)))
          throw new Error("The rtex archive contains a link or unsupported entry.")
        if (entry.uncompressedSize > limit) throw new Error("The rtex archive exceeds its extraction limit.")
        if (entry.directory) {
          await fs.mkdir(file, { recursive: true, mode: 0o700 })
          continue
        }
        if (!entry.getData) throw new Error("The rtex archive contains an unreadable entry.")
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        const data = await entry.getData(new Uint8ArrayWriter(), {
          signal,
          checkSignature: true,
          useWebWorkers: false,
        })
        await fs.writeFile(file, data, { mode: 0o700 })
      }
    } finally {
      await reader.close()
    }
    return
  }

  const tar = await inflate(bytes, { maxOutputLength: limit })
  const state = { offset: 0, entries: 0, ended: false }
  const field = (header: Buffer, start: number, end: number) =>
    header.subarray(start, end).toString("utf8").split("\0")[0]
  const octal = (value: string) => {
    if (!/^[ 0-7]*$/.test(value)) throw new Error("The rtex archive has invalid numeric metadata.")
    return Number.parseInt(value.trim() || "0", 8)
  }
  while (state.offset + 512 <= tar.length) {
    signal.throwIfAborted()
    const header = tar.subarray(state.offset, state.offset + 512)
    if (header.every((value) => value === 0)) {
      if (tar.subarray(state.offset).some((value) => value !== 0))
        throw new Error("The rtex archive has invalid trailing data.")
      state.ended = true
      break
    }
    if (++state.entries > 5000) throw new Error("The rtex archive contains too many entries.")
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)
    if (checksum !== octal(field(header, 148, 156))) throw new Error("The rtex archive header is corrupt.")
    const prefix = field(header, 345, 500)
    const name = `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`
    const kind = header[156]
    if (![0, 48, 53].includes(kind)) throw new Error("The rtex archive contains a link or unsupported entry.")
    const size = octal(field(header, 124, 136))
    const start = state.offset + 512
    if (!Number.isSafeInteger(size) || start + Math.ceil(size / 512) * 512 > tar.length || (kind === 53 && size !== 0))
      throw new Error("The rtex archive is truncated or exceeds its size limit.")
    const file = await target(root, name)
    if (kind === 53) {
      await fs.mkdir(file, { recursive: true, mode: 0o700 })
    } else {
      if (size > limit) throw new Error("The rtex archive exceeds its extraction limit.")
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.writeFile(file, tar.subarray(start, start + size), { mode: 0o700 })
    }
    state.offset = start + Math.ceil(size / 512) * 512
  }
  if (!state.ended) throw new Error("The rtex archive is incomplete.")
}
