import { closeSync, fstatSync, openSync, readFileSync } from "node:fs"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { MigrateError } from "../error"
import type { Event, ParsedSession } from "../model"
import { loadJSONL } from "../read"
import { obj, str, validRFC3339 } from "../util"
import { activePath, entryEvents } from "./pi"

const version = 3
const blobPrefix = "blob:sha256:"
const maxBlobBytes = 64 * 1024 * 1024

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records.map((record) => record.value)
  const titleSlot = records[0]?.type === "title" ? records.shift() : undefined
  validate(records, titleSlot)
  const header = records[0]!
  const sessionID = str(header.id)
  const cwd = str(header.cwd)
  const startedAt = str(header.timestamp)
  if (!sessionID || !cwd || !startedAt) throw new MigrateError("OMP session header is missing required metadata")

  const entries = records.slice(1)
  const indexed = new Map<string, Record<string, unknown>>()
  const indexes = new Map<string, number>()
  const offset = titleSlot ? 2 : 1
  for (const [index, entry] of entries.entries()) {
    const id = str(entry.id)
    if (!id) throw new MigrateError("OMP session entry is missing an id")
    indexed.set(id, entry)
    indexes.set(id, index + offset)
  }
  const active = activePath(entries, indexed)
  const selected = new Set(active.map((entry) => str(entry.id)))
  const reset = active.reduce((last, entry, index) => (entry.type === "reset_boundary" ? index : last), -1)
  const events: Event[] = []
  let model: string | undefined
  let provider: string | undefined

  for (const [pathIndex, entry] of active.entries()) {
    const id = str(entry.id) ?? ""
    const index = indexes.get(id) ?? 0
    const parsed =
      pathIndex < reset
        ? [
            {
              kind: "opaque" as const,
              timestamp: str(entry.timestamp),
              payload: { reason: "omp_pre_reset_entry" },
              provenance: { recordIndex: index, recordType: str(entry.type) },
            },
          ]
        : eventsFor(entry, index)
    for (const event of parsed) events.push(await resolveBlob(event, path))
    if (entry.type === "model_change") {
      const selector = str(entry.model)
      if (selector && selector.includes("/")) [provider, model] = selector.split("/", 2)
    }
    if (entry.type === "message") {
      const message = obj(entry.message)
      if (message.role === "assistant") {
        model = str(message.model) ?? model
        provider = str(message.provider) ?? provider
      }
    }
  }

  for (const entry of entries) {
    if (selected.has(str(entry.id))) continue
    events.push({
      kind: "opaque",
      timestamp: str(entry.timestamp),
      payload: { reason: "inactive_omp_branch_entry" },
      provenance: { recordIndex: indexes.get(str(entry.id) ?? "") ?? 0, recordType: str(entry.type) },
    })
  }

  if (str(header.parentSession)) {
    events.unshift({
      kind: "opaque",
      timestamp: startedAt,
      payload: { reason: "omp_parent_session" },
      provenance: { recordIndex: 0, recordType: "session" },
    })
  }

  const title =
    (titleSlot && str(titleSlot.title)) ||
    [...entries].reverse().map((entry) => (entry.type === "title_change" ? str(entry.title) : undefined)).find(Boolean) ||
    str(header.title)

  return {
    source: "omp",
    path,
    sha256: loaded.sha256,
    sessionID,
    cwd,
    startedAt,
    model,
    provider,
    title,
    events,
    rawRecordCount: loaded.rawRecordCount,
  }
}

function eventsFor(entry: Record<string, unknown>, index: number): Event[] {
  const type = str(entry.type)
  if (type === "title_change") return []
  if (
    type === "credential_pin" ||
    type === "mode_change" ||
    type === "reset_boundary" ||
    type === "service_tier_change" ||
    type === "session_init" ||
    type === "ttsr_injection"
  ) {
    return [
      {
        kind: "opaque",
        timestamp: str(entry.timestamp),
        payload: { reason: `omp_${type}` },
        provenance: { recordIndex: index, recordType: type },
      },
    ]
  }
  return entryEvents(entry, index, "omp")
}

function validate(records: Record<string, unknown>[], titleSlot?: Record<string, unknown>) {
  if (!records.length) throw new MigrateError("OMP session is empty")
  if (
    titleSlot &&
    (titleSlot.v !== 1 ||
      typeof titleSlot.title !== "string" ||
      typeof titleSlot.updatedAt !== "string" ||
      typeof titleSlot.pad !== "string" ||
      (titleSlot.source !== undefined && titleSlot.source !== null && titleSlot.source !== "auto" && titleSlot.source !== "user"))
  ) {
    throw new MigrateError("OMP session has an invalid title slot")
  }
  const header = records[0]!
  if (header.type !== "session" || header.version !== version) {
    throw new MigrateError("OMP session does not have a supported v3 header")
  }
  if (!str(header.id) || !str(header.cwd) || !validRFC3339(header.timestamp)) {
    throw new MigrateError("OMP session header is missing required metadata")
  }
  const known = new Set<string>()
  const entries = records.slice(1)
  let resumable = false
  for (const entry of entries) {
    const id = str(entry.id)
    if (!id) throw new MigrateError("OMP session entry is missing an id")
    if (known.has(id)) throw new MigrateError("OMP session contains a duplicate entry id")
    const parent = entry.parentId
    if (parent !== undefined && parent !== null && (typeof parent !== "string" || !known.has(parent))) {
      throw new MigrateError("OMP session tree references a missing parent")
    }
    if (!validRFC3339(entry.timestamp)) throw new MigrateError("OMP session entry has an invalid timestamp")
    known.add(id)
    if (entry.type === "message") {
      validateMessage(entry.message)
      resumable = true
    } else if (entry.type === "compaction") {
      if (!str(entry.summary) || !str(entry.firstKeptEntryId)) {
        throw new MigrateError("OMP compaction entry is missing required metadata")
      }
      const tokens = entry.tokensBefore
      if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0) {
        throw new MigrateError("OMP compaction entry has invalid token metadata")
      }
      resumable = true
    } else if (entry.type === "title_change") {
      if (!str(entry.title) || (entry.source !== "auto" && entry.source !== "user")) {
        throw new MigrateError("OMP title change entry is invalid")
      }
    }
  }
  if (entries.length) activePath(entries, new Map(entries.map((entry) => [str(entry.id)!, entry])))
  if (!resumable) throw new MigrateError("OMP session has no resumable conversation context")
}

function validateMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrateError("OMP message entry is missing its message")
  }
  const message = obj(value)
  const role = str(message.role)
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "developer" &&
    role !== "toolResult" &&
    role !== "custom" &&
    role !== "bashExecution"
  ) {
    throw new MigrateError("OMP message entry has an unsupported role")
  }
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    throw new MigrateError("OMP message entry has invalid content")
  }
  if (role === "toolResult" && !str(message.toolCallId)) {
    throw new MigrateError("OMP tool result is missing its call ID")
  }
}

async function resolveBlob(event: Event, path: string): Promise<Event> {
  if (event.kind !== "context") return event
  const url = str(event.payload.image_url)
  if (!url || !url.startsWith("data:") || !url.includes(blobPrefix)) return event
  const comma = url.indexOf(",")
  if (comma < 0) return event
  const prefix = url.slice(0, comma)
  const ref = url.slice(comma + 1)
  if (!ref.startsWith(blobPrefix)) return event
  const digest = ref.slice(blobPrefix.length)
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new MigrateError("OMP image contains an invalid blob reference")
  const sessions = ancestors(path).find((value) => value.endsWith("/sessions") || value.endsWith("\\sessions"))
  if (!sessions) return event
  const blob = join(dirname(sessions), "blobs", digest)
  const data = readBlob(blob, digest)
  return { ...event, payload: { ...event.payload, image_url: `${prefix},${data.toString("base64")}` } }
}

function readBlob(path: string, digest: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maxBlobBytes) throw new MigrateError("OMP image blob is not a bounded regular file")
    const data = readFileSync(fd)
    const actual = new Bun.CryptoHasher("sha256").update(data).digest("hex")
    if (actual !== digest) throw new MigrateError("OMP image blob hash does not match its reference")
    return data
  } finally {
    closeSync(fd)
  }
}

function ancestors(path: string) {
  const result: string[] = []
  let current = dirname(path)
  while (true) {
    result.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
}

