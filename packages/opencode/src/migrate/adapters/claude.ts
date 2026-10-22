import { MigrateError } from "../error"
import type { Event, ParsedSession, Role } from "../model"
import { loadJSONL } from "../read"
import type { JsonRecord } from "../read-types"
import { contentText, imageURLFromClaudeSource, obj, str } from "../util"

const titles: Record<string, string> = { "custom-title": "customTitle", "ai-title": "aiTitle" }

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records
  const selected = activeConversation(records)
  const selectedIndexes = new Set(selected.map((record) => record.index))
  const sessionIDs = new Set(selected.map((record) => str(record.value.sessionId)).filter(Boolean))
  if (sessionIDs.size > 1) throw new MigrateError("Claude active graph contains mixed sessionId values")
  const summaries = new Set(
    selected.filter((record) => record.value.isCompactSummary === true).map((record) => str(record.value.parentUuid)),
  )
  const boundaries = new Map(
    selected
      .filter((record) => {
        return record.value.type === "system" && record.value.subtype === "compact_boundary" && str(record.value.uuid)
      })
      .map((record) => [str(record.value.uuid)!, record.value]),
  )

  const events: Event[] = []
  let sessionID: string | undefined
  let cwd: string | undefined
  let startedAt: string | undefined
  let cliVersion: string | undefined
  let model: string | undefined
  let customTitle: string | undefined
  let aiTitle: string | undefined

  for (const record of records) {
    const value = record.value
    const type = str(value.type)
    sessionID ??= str(value.sessionId)
    cwd ??= str(value.cwd)
    startedAt ??= str(value.timestamp)
    cliVersion ??= str(value.version)
    const field = titles[type ?? ""]
    if (!field) continue
    const title = str(value[field])
    if (!title) continue
    if (type === "custom-title") customTitle = title
    else aiTitle = title
  }

  for (const record of selected) {
    const value = record.value
    const type = str(value.type)
    if (type === "system" && value.subtype === "compact_boundary") {
      if (str(value.uuid) && summaries.has(str(value.uuid))) continue
      events.push({
        kind: "compaction",
        provenance: provenance(record),
        timestamp: str(value.timestamp),
        payload: { source_subtype: "compact_boundary" },
      })
      continue
    }
    if (type !== "user" && type !== "assistant") {
      if (type !== "last-prompt" && type !== "queue-operation") events.push(opaque(record, "active_graph_metadata_record"))
      continue
    }
    const message = obj(value.message)
    if (value.isCompactSummary === true) {
      const boundary = str(value.parentUuid) ? boundaries.get(str(value.parentUuid)!) : undefined
      events.push({
        kind: "compaction",
        role: "system",
        text: contentText(message.content),
        timestamp: str(value.timestamp),
        payload: {
          source_subtype: "compact_summary",
          has_boundary_metadata: !!boundary && typeof boundary.compactMetadata === "object" && boundary.compactMetadata !== null,
        },
        provenance: provenance(record),
      })
      continue
    }
    if (value.isMeta === true) {
      events.push(opaque(record, "active_graph_metadata_record"))
      continue
    }
    const role = messageRole(str(message.role) ?? type)
    if (!role) {
      events.push(opaque(record, "privileged_or_unknown_message_role"))
      continue
    }
    if (role === "assistant") model ??= str(message.model)
    events.push(...contentEvents(record, role, message.content))
    if (value.toolUseResult !== undefined || value.sourceToolAssistantUUID !== undefined) {
      events.push(opaque(record, "top_level_tool_result_metadata"))
    }
  }

  for (const record of records) {
    if (selectedIndexes.has(record.index)) continue
    const value = record.value
    const type = str(value.type)
    if ((type === "user" || type === "assistant") && value.message && typeof value.message === "object") {
      events.push(opaque(record, "inactive_or_metadata_conversation_record"))
    } else if (type && type in titles) {
      continue
    } else if (type !== "last-prompt" && type !== "queue-operation") {
      events.push(opaque(record, "non_conversation_record"))
    }
  }

  return {
    source: "claude",
    path,
    sha256: loaded.sha256,
    sessionID,
    cwd,
    startedAt,
    cliVersion,
    model,
    provider: "anthropic",
    title: customTitle ?? aiTitle,
    events,
    rawRecordCount: records.length,
  }
}

function activeConversation(records: JsonRecord[]) {
  const candidates = records.filter((record) => {
    return (
      (record.value.type === "user" || record.value.type === "assistant") &&
      record.value.message &&
      typeof record.value.message === "object" &&
      record.value.isMeta !== true &&
      record.value.isSidechain !== true
    )
  })
  if (!candidates.length) {
    if (
      records.some(
        (record) =>
          (record.value.type === "user" || record.value.type === "assistant") &&
          record.value.message &&
          typeof record.value.message === "object" &&
          record.value.isSidechain === true,
      )
    ) {
      throw new MigrateError("Claude sidechain/subagent transcripts cannot be converted directly; transfer the parent session")
    }
    return []
  }
  const byUUID = new Map<string, JsonRecord>()
  for (const record of records) {
    const uuid = str(record.value.uuid)
    if (!uuid) continue
    if (byUUID.has(uuid)) throw new MigrateError("Claude transcript contains a duplicate record UUID")
    byUUID.set(uuid, record)
  }
  const recorded = [...records]
    .reverse()
    .find((record) => record.value.type === "last-prompt" && str(record.value.leafUuid))
  const recordedLeaf = recorded ? str(recorded.value.leafUuid) : undefined
  if (recordedLeaf && !byUUID.has(recordedLeaf)) throw new MigrateError("Claude last-prompt references a missing leaf UUID")
  const leaf = recordedLeaf ?? str(candidates[candidates.length - 1]?.value.uuid)
  if (!leaf || !byUUID.has(leaf)) return candidates

  const path: JsonRecord[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = leaf
  while (cursor) {
    if (seen.has(cursor)) throw new MigrateError("Claude active graph contains an ancestry cycle")
    seen.add(cursor)
    const record = byUUID.get(cursor)
    if (!record) throw new MigrateError("Claude active graph references a missing parent UUID")
    path.push(record)
    const parent = str(record.value.parentUuid)
    if (parent) {
      cursor = parent
      continue
    }
    const logical =
      record.value.type === "system" && record.value.subtype === "compact_boundary"
        ? str(record.value.logicalParentUuid)
        : undefined
    if (logical && seen.has(logical)) {
      if (validBackEdge(record, logical, seen, byUUID)) break
      throw new MigrateError("Claude active graph contains an ancestry cycle")
    }
    cursor = logical
  }
  return path.reverse()
}

function validBackEdge(
  boundary: JsonRecord,
  logicalParent: string,
  seen: Set<string>,
  byUUID: Map<string, JsonRecord>,
) {
  const metadata = obj(boundary.value.compactMetadata)
  const segment = obj(metadata.preservedSegment)
  const messages = obj(metadata.preservedMessages)
  const anchor = str(segment.anchorUuid)
  const head = str(segment.headUuid)
  const tail = str(segment.tailUuid)
  const boundaryUUID = str(boundary.value.uuid)
  if (!anchor || !head || !tail || !boundaryUUID || logicalParent !== tail) return false
  const anchorRecord = byUUID.get(anchor)
  if (
    !anchorRecord ||
    anchorRecord.value.isCompactSummary !== true ||
    str(anchorRecord.value.parentUuid) !== boundaryUUID
  ) {
    return false
  }
  const declared = messages.allUuids ?? messages.uuids
  if (!Array.isArray(declared) || !declared.length) return false
  const ids = new Set(declared.filter((value): value is string => typeof value === "string"))
  if (!ids.has(head) || !ids.has(tail)) return false
  for (const id of ids) if (!seen.has(id)) return false

  const preserved = new Set<string>()
  let cursor: string | undefined = tail
  while (cursor && cursor !== anchor) {
    if (preserved.has(cursor) || !seen.has(cursor)) return false
    preserved.add(cursor)
    const record = byUUID.get(cursor)
    if (!record) return false
    cursor = str(record.value.parentUuid)
  }
  return cursor === anchor && preserved.has(head)
}

function contentEvents(record: JsonRecord, role: Role, content: unknown): Event[] {
  const timestamp = str(record.value.timestamp)
  if (typeof content === "string") {
    return content ? [{ kind: "message", role, text: content, timestamp, provenance: provenance(record), payload: {} }] : []
  }
  if (!Array.isArray(content)) return [opaque(record, "unsupported_message_content")]
  return content.flatMap((value, index): Event[] => {
    const block = obj(value)
    const provenanceValue = provenance(record, index)
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [{ kind: "opaque", provenance: provenanceValue, payload: {} }]
    }
    const type = str(block.type)
    if (type === "text") {
      const text = str(block.text)
      return text
        ? [{ kind: "message", role, text, timestamp, provenance: provenanceValue, payload: {} }]
        : []
    }
    if (type === "tool_use") {
      return [
        {
          kind: "tool_call",
          role: "assistant",
          timestamp,
          toolName: str(block.name),
          toolCallID: str(block.id),
          payload: { input: block.input ?? {} },
          provenance: provenanceValue,
        },
      ]
    }
    if (type === "tool_result") {
      return [
        {
          kind: "tool_result",
          role: "tool",
          timestamp,
          text: contentText(block.content),
          toolCallID: str(block.tool_use_id),
          payload: {
            is_error: block.is_error === true,
            content_blocks: portableToolResult(block.content),
          },
          provenance: provenanceValue,
        },
      ]
    }
    if (type === "thinking" || type === "redacted_thinking") {
      return [
        {
          kind: "thinking",
          role: "assistant",
          timestamp,
          payload: { source_block_type: type },
          provenance: provenanceValue,
        },
      ]
    }
    if (type === "image" || type === "document") {
      const payload: Record<string, unknown> = { block_type: type }
      if (type === "image") {
        const url = imageURLFromClaudeSource(block.source)
        if (url) payload.image_url = url
      }
      return [{ kind: "context", role, timestamp, payload, provenance: provenanceValue }]
    }
    return [
      {
        kind: "opaque",
        role,
        timestamp,
        payload: { source_block_type: type ?? "<missing>" },
        provenance: provenanceValue,
      },
    ]
  })
}

function portableToolResult(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) return [{ type: "opaque" }]
  return value.map((item) => {
    if (typeof item === "string") return { type: "text", text: item }
    const block = obj(item)
    if (block.type === "text") {
      const text = str(block.text)
      return text ? { type: "text", text } : { type: "opaque" }
    }
    if (block.type === "image") {
      const url = imageURLFromClaudeSource(block.source)
      return url ? { type: "image", image_url: url } : { type: "opaque" }
    }
    if (block.type === "tool_reference") {
      const name = str(block.tool_name)
      return name ? { type: "tool_reference", tool_name: name } : { type: "opaque" }
    }
    return { type: "opaque" }
  })
}

function messageRole(value: string): Role | undefined {
  if (value === "assistant") return "assistant"
  if (value === "user") return "user"
  return undefined
}

function opaque(record: JsonRecord, reason: string): Event {
  return {
    kind: "opaque",
    timestamp: str(record.value.timestamp),
    payload: { reason },
    provenance: provenance(record),
  }
}

function provenance(record: JsonRecord, blockIndex?: number) {
  return {
    recordIndex: record.index,
    recordType: str(record.value.type),
    sourceID: str(record.value.uuid),
    blockIndex,
  }
}
