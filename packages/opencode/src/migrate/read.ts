import { statSync } from "node:fs"
import { MigrateError } from "./error"
import type { JsonRecord } from "./read-types"

const MAX_RECORD_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_RECORDS = 100_000

type Options = {
  maxRecordBytes?: number
  maxTotalBytes?: number
  maxRecords?: number
}

type Snapshot = {
  device: number
  inode: number
  size: number
  modified: number
}

function snapshot(path: string): Snapshot {
  const value = statSync(path)
  if (!value.isFile()) throw new MigrateError(`session source is not a regular file: ${path}`)
  return { device: value.dev, inode: value.ino, size: value.size, modified: value.mtimeMs }
}

function same(a: Snapshot, b: Snapshot) {
  return a.device === b.device && a.inode === b.inode && a.size === b.size && a.modified === b.modified
}

function hash(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}

export async function loadJSONL(path: string, options: Options = {}) {
  const maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES
  const maxRecords = options.maxRecords ?? MAX_RECORDS
  const before = snapshot(path)
  if (before.size > maxTotalBytes) throw new MigrateError(`session file exceeds the ${maxTotalBytes}-byte limit`)
  const file = Bun.file(path)
  const text = await file.text()
  if (Buffer.byteLength(text) > maxTotalBytes) throw new MigrateError(`session file exceeds the ${maxTotalBytes}-byte limit`)
  const records: JsonRecord[] = []
  let total = 0
  for (const [offset, line] of text.split("\n").entries()) {
    if (!line.trim()) continue
    const bytes = Buffer.byteLength(line)
    total += bytes
    if (bytes > maxRecordBytes) throw new MigrateError(`session record at line ${offset + 1} exceeds the limit`)
    if (total > maxTotalBytes) throw new MigrateError(`session file exceeds the ${maxTotalBytes}-byte limit`)
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new MigrateError(`invalid JSON session record at line ${offset + 1}`)
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new MigrateError(`session record at line ${offset + 1} is not a JSON object`)
    }
    if (records.length >= maxRecords) throw new MigrateError(`session file exceeds the ${maxRecords}-record limit`)
    records.push({ index: records.length, line: offset + 1, value: value as Record<string, unknown> })
  }
  if (!same(before, snapshot(path))) throw new MigrateError("source session changed while it was being read; retry")
  return { path, text, sha256: hash(text), records, rawRecordCount: records.length }
}

export async function loadJSON(path: string, options: Options = {}) {
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES
  const before = snapshot(path)
  if (before.size > maxTotalBytes) throw new MigrateError(`session file exceeds the ${maxTotalBytes}-byte limit`)
  const text = await Bun.file(path).text()
  if (Buffer.byteLength(text) > maxTotalBytes) throw new MigrateError(`session file exceeds the ${maxTotalBytes}-byte limit`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new MigrateError("session file is not valid JSON")
  }
  if (!same(before, snapshot(path))) throw new MigrateError("source session changed while it was being read; retry")
  return { path, text, sha256: hash(text), value }
}

export function checkBounds(value: unknown, maxNodes = 100_000, maxDepth = 64) {
  const stack: Array<[unknown, number]> = [[value, 0]]
  let nodes = 0
  while (stack.length) {
    const [current, depth] = stack.pop()!
    nodes++
    if (nodes > maxNodes || depth > maxDepth) throw new MigrateError("session record exceeds structural safety limits")
    if (current && typeof current === "object") {
      if (Array.isArray(current)) for (const item of current) stack.push([item, depth + 1])
      else for (const item of Object.values(current)) stack.push([item, depth + 1])
    }
  }
}
