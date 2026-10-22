import { MigrateError } from "../error"
import type { Event, ParsedSession, Role } from "../model"
import { loadJSONL } from "../read"
import { obj, str, validRFC3339 } from "../util"

const version = 3

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records.map((record) => record.value)
  validate(records)
  const header = records[0]!
  const sessionID = str(header.id)
  const cwd = str(header.cwd)
  const startedAt = str(header.timestamp)
  if (!sessionID || !cwd || !startedAt) throw new MigrateError("Pi session header is missing required metadata")

  const entries = records.slice(1)
  const indexed = new Map<string, Record<string, unknown>>()
  const indexes = new Map<string, number>()
  for (const [offset, entry] of entries.entries()) {
    const id = str(entry.id)
    if (!id) throw new MigrateError("Pi session entry is missing an id")
    if (indexed.has(id)) throw new MigrateError("Pi session contains a duplicate entry id")
    indexed.set(id, entry)
    indexes.set(id, offset + 1)
  }
  const active = activePath(entries, indexed)
  const selected = new Set(active.map((entry) => str(entry.id)))
  const events: Event[] = []
  let model: string | undefined
  let provider: string | undefined

  for (const entry of active) {
    const id = str(entry.id) ?? ""
    events.push(...entryEvents(entry, indexes.get(id) ?? 0))
    if (entry.type === "model_change") {
      model = str(entry.modelId) ?? model
      provider = str(entry.provider) ?? provider
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
      payload: { reason: "inactive_pi_branch_entry" },
      provenance: { recordIndex: indexes.get(str(entry.id) ?? "") ?? 0, recordType: str(entry.type) },
    })
  }

  const title = [...entries]
    .reverse()
    .map((entry) => (entry.type === "session_info" ? str(entry.name) : undefined))
    .find(Boolean)

  if (str(header.parentSession)) {
    events.unshift({
      kind: "opaque",
      timestamp: startedAt,
      payload: { reason: "pi_parent_session" },
      provenance: { recordIndex: 0, recordType: "session" },
    })
  }

  return {
    source: "pi",
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

function validate(records: Record<string, unknown>[]) {
  if (!records.length) throw new MigrateError("Pi session is empty")
  const header = records[0]!
  if (header.type !== "session" || header.version !== version) {
    throw new MigrateError("Pi session does not have a supported v3 header")
  }
  if (!str(header.id) || !str(header.cwd) || !validRFC3339(header.timestamp)) {
    throw new MigrateError("Pi session header is missing required metadata")
  }
  if (header.parentSession !== undefined && !str(header.parentSession)) {
    throw new MigrateError("Pi session header has invalid parent metadata")
  }

  const known = new Set<string>()
  const entries = records.slice(1)
  let resumable = false
  for (const entry of entries) {
    const id = str(entry.id)
    if (!id) throw new MigrateError("Pi session entry is missing an id")
    if (known.has(id)) throw new MigrateError("Pi session contains a duplicate entry id")
    const parent = entry.parentId
    if (parent !== undefined && parent !== null && (typeof parent !== "string" || !known.has(parent))) {
      throw new MigrateError("Pi session tree references a missing parent")
    }
    if (!validRFC3339(entry.timestamp)) throw new MigrateError("Pi session entry has an invalid timestamp")
    known.add(id)

    if (entry.type === "message") {
      validateMessage(entry.message)
      resumable = true
    } else if (entry.type === "compaction") {
      if (!str(entry.summary) || !str(entry.firstKeptEntryId)) {
        throw new MigrateError("Pi compaction entry is missing required metadata")
      }
      const tokens = entry.tokensBefore
      if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0) {
        throw new MigrateError("Pi compaction entry has invalid token metadata")
      }
      resumable = true
    } else if (entry.type === "session_info") {
      if (entry.name !== undefined && typeof entry.name !== "string") {
        throw new MigrateError("Pi session name is not a string")
      }
    }
  }
  if (entries.length) activePath(entries, new Map(entries.map((entry) => [str(entry.id)!, entry])))
  if (!resumable) throw new MigrateError("Pi session has no resumable conversation context")
}

function validateMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrateError("Pi message entry is missing its message")
  }
  const message = obj(value)
  const role = str(message.role)
  if (role !== "user" && role !== "assistant" && role !== "toolResult") {
    throw new MigrateError("Pi message entry has an unsupported role")
  }
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    throw new MigrateError("Pi message entry has invalid content")
  }
  if (role === "toolResult" && !str(message.toolCallId)) {
    throw new MigrateError("Pi tool result is missing its call ID")
  }
}

export function activePath(entries: Record<string, unknown>[], indexed: Map<string, Record<string, unknown>>) {
  if (!entries.length) return []
  const path: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let current: Record<string, unknown> | undefined = entries[entries.length - 1]
  while (current) {
    const id = str(current.id) ?? ""
    if (seen.has(id)) throw new MigrateError("Pi session tree contains a cycle")
    seen.add(id)
    path.push(current)
    const parent = current.parentId
    if (parent === undefined || parent === null) break
    if (typeof parent !== "string" || !indexed.has(parent)) {
      throw new MigrateError("Pi session tree references a missing parent")
    }
    current = indexed.get(parent)
  }
  return path.reverse()
}

export function entryEvents(entry: Record<string, unknown>, recordIndex: number, prefix = "pi"): Event[] {
  const type = str(entry.type)
  const timestamp = str(entry.timestamp)
  const provenance = { recordIndex, recordType: type }
  if (type === "compaction") {
    const summary = str(entry.summary)
    if (!summary) return []
    return [
      {
        kind: "compaction",
        role: "system",
        text: summary,
        timestamp,
        payload: { has_boundary_metadata: (entry.details !== undefined && entry.details !== null) || entry.fromHook === true },
        provenance,
      },
    ]
  }
  if (type === "branch_summary") return [opaquePi(entry, recordIndex, `${prefix}_branch_summary`)]
  if (type === "custom_message") return [opaquePi(entry, recordIndex, `${prefix}_custom_message`)]
  if (type === "model_change" || type === "thinking_level_change" || type === "label" || type === "custom") {
    return [opaquePi(entry, recordIndex, `${prefix}_${type}`)]
  }
  if (type === "session_info") return []
  if (type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) {
    return [opaquePi(entry, recordIndex, `unknown_${prefix}_entry`)]
  }
  const message = obj(entry.message)
  const role = str(message.role)
  if (role === "user") return contentEvents(message.content, "user", timestamp, provenance, prefix)
  if (role === "assistant") {
    const result = contentEvents(message.content, "assistant", timestamp, provenance, prefix)
    const stop = str(message.stopReason)
    if (stop !== undefined && stop !== "stop" && stop !== "toolUse") {
      result.push(opaquePi(entry, recordIndex, `${prefix}_assistant_stop_reason_${stop}`))
    }
    return result
  }
  if (role === "toolResult") {
    const blocks = portableResultBlocks(message.content)
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("\n")
    const result: Event[] = [
      {
        kind: "tool_result",
        role: "tool",
        text: text || undefined,
        toolName: str(message.toolName),
        toolCallID: str(message.toolCallId),
        timestamp,
        payload: { is_error: message.isError === true, content_blocks: blocks },
        provenance,
      },
    ]
    if (message.details !== undefined) result.push(opaquePi(entry, recordIndex, `${prefix}_tool_result_details`))
    return result
  }
  return [
    opaquePi(
      entry,
      recordIndex,
      role === "bashExecution" ? `${prefix}_bash_execution_message` : role === "custom" ? `${prefix}_custom_message` : `unknown_${prefix}_message_role`,
    ),
  ]
}

export function contentEvents(
  content: unknown,
  role: Role,
  timestamp: string | undefined,
  provenance: Event["provenance"],
  prefix = "pi",
): Event[] {
  if (typeof content === "string") {
    return content ? [{ kind: "message", role, text: content, timestamp, provenance, payload: {} }] : []
  }
  if (!Array.isArray(content)) return []
  return content.flatMap((value, index): Event[] => {
    const block = obj(value)
    const source = { ...provenance, blockIndex: index }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [{ kind: "opaque", provenance: source, payload: {} }]
    }
    const type = str(block.type)
    if (type === "text" && str(block.text)) {
      return [{ kind: "message", role, text: str(block.text), timestamp, provenance: source, payload: {} }]
    }
    if (type === "image") {
      const data = str(block.data)
      const mime = str(block.mimeType)
      return [
        {
          kind: "context",
          role,
          timestamp,
          payload: { block_type: "image", image_url: data && mime ? `data:${mime};base64,${data}` : undefined },
          provenance: source,
        },
      ]
    }
    if (type === "toolCall") {
      return [
        {
          kind: "tool_call",
          role: "assistant",
          timestamp,
          toolName: str(block.name),
          toolCallID: str(block.id),
          payload: { input: block.arguments ?? {} },
          provenance: source,
        },
      ]
    }
    if (type === "thinking") {
      return [
        {
          kind: "thinking",
          role: "assistant",
          text: str(block.thinking),
          timestamp,
          provenance: source,
          payload: {},
        },
      ]
    }
    return [
      {
        kind: "opaque",
        role,
        timestamp,
        payload: {
          reason: `${prefix}_content_block_${type ?? "missing"}`,
          source_block_type: type ?? "<missing>",
        },
        provenance: source,
      },
    ]
  })
}

function portableResultBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? [{ type: "text", text: content }] : [{ type: "opaque", source_type: "<non-list>" }]
  }
  return content.map((value) => {
    const block = obj(value)
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { type: "opaque", source_type: "<non-object>" }
    }
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text }
    if (block.type === "image") {
      const data = str(block.data)
      const mime = str(block.mimeType)
      if (data && mime) return { type: "image", image_url: `data:${mime};base64,${data}` }
      return { type: "opaque", source_type: "image" }
    }
    return { type: "opaque", source_type: str(block.type) ?? "<missing>" }
  })
}

function opaquePi(entry: Record<string, unknown>, recordIndex: number, reason: string): Event {
  return {
    kind: "opaque",
    timestamp: str(entry.timestamp),
    payload: { reason, source_entry_type: str(entry.type) },
    provenance: { recordIndex, recordType: str(entry.type) },
  }
}
