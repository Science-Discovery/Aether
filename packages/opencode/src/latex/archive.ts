import path from "node:path"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"
import { Uint8ArrayReader, ZipReader, type Entry } from "@zip.js/zip.js"

const maximum = 256 * 1024 * 1024
const inflate = promisify(gunzip)

function name(value: string) {
  const normalized = value.replaceAll("\\", "/")
  if (
    !normalized ||
    /[\u0000-\u001f:]/.test(normalized) ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..")
  )
    throw new Error("The Tectonic archive contains an unsafe path.")
  return path.posix.basename(normalized)
}

/** Inspect all entries, but return only one regular executable; never extract paths from an archive. */
export async function unpack(bytes: Uint8Array, format: "zip" | "tar.gz", filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  if (format === "zip") {
    // zip.js uses Uint8Array.slice semantics internally; Buffer.slice shares a
    // pooled backing store instead, which can corrupt its header DataViews.
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), { useWebWorkers: false, signal })
    try {
      const entries: Entry[] = []
      for await (const entry of reader.getEntriesGenerator()) {
        signal.throwIfAborted()
        if (entries.length >= 1000) throw new Error("The Tectonic archive contains too many entries.")
        entries.push(entry)
      }
      const matches = entries.filter((entry) => {
        const base = name(entry.filename)
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000
        if (
          entry.encrypted ||
          (mode && mode !== (entry.directory ? 0x4000 : 0x8000)) ||
          entry.externalFileAttributes & 0x400
        )
          throw new Error("The Tectonic archive contains a link or unsupported entry.")
        if (entry.uncompressedSize > maximum) throw new Error("The Tectonic archive exceeds its extraction limit.")
        return !entry.directory && base === filename
      })
      if (matches.length !== 1 || !matches[0].getData)
        throw new Error("The Tectonic archive must contain exactly one executable.")
      const chunks: Uint8Array[] = []
      const state = { bytes: 0 }
      await matches[0].getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            signal.throwIfAborted()
            state.bytes += chunk.byteLength
            if (state.bytes > maximum) throw new Error("The Tectonic executable exceeds its size limit.")
            chunks.push(chunk)
          },
        }),
        { signal, checkSignature: true, useWebWorkers: false },
      )
      return Buffer.concat(chunks)
    } finally {
      await reader.close()
    }
  }

  // The official release uses a small ustar archive. Reject extensions and links
  // rather than handing their path interpretation to a platform extractor.
  const tar = await inflate(bytes, { maxOutputLength: maximum })
  signal.throwIfAborted()
  const state = { offset: 0, entries: 0, ended: false, found: undefined as Buffer | undefined }
  const field = (header: Buffer, start: number, end: number) =>
    header.subarray(start, end).toString("utf8").split("\0")[0]
  const octal = (value: string) => {
    if (!/^[ 0-7]*$/.test(value)) throw new Error("The Tectonic archive has invalid numeric metadata.")
    return Number.parseInt(value.trim() || "0", 8)
  }
  while (state.offset + 512 <= tar.length) {
    signal.throwIfAborted()
    const header = tar.subarray(state.offset, state.offset + 512)
    if (header.every((value) => value === 0)) {
      if (tar.subarray(state.offset).some((value) => value !== 0))
        throw new Error("The Tectonic archive has invalid trailing data.")
      state.ended = true
      break
    }
    if (++state.entries > 1000) throw new Error("The Tectonic archive contains too many entries.")
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)
    if (checksum !== octal(field(header, 148, 156))) throw new Error("The Tectonic archive header is corrupt.")
    const prefix = field(header, 345, 500)
    const base = name(`${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`)
    const kind = header[156]
    if (![0, 48, 53].includes(kind)) throw new Error("The Tectonic archive contains a link or unsupported entry.")
    const size = octal(field(header, 124, 136))
    const start = state.offset + 512
    if (
      !Number.isSafeInteger(size) ||
      size > maximum ||
      start + Math.ceil(size / 512) * 512 > tar.length ||
      (kind === 53 && size !== 0)
    )
      throw new Error("The Tectonic archive is truncated or exceeds its size limit.")
    if (kind !== 53 && base === filename) {
      if (state.found) throw new Error("The Tectonic archive contains more than one executable.")
      state.found = tar.subarray(start, start + size)
    }
    state.offset = start + Math.ceil(size / 512) * 512
  }
  if (!state.ended || !state.found?.length)
    throw new Error("The Tectonic archive is incomplete or does not contain an executable.")
  return state.found
}
