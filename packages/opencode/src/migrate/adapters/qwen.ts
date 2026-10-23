import { MigrateError } from "../error"
import type { Event, ParsedSession } from "../model"
import { loadJSONL } from "../read"
import { contentText, obj, portableDataImage, requireUUID, str, validRFC3339 } from "../util"

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records.map((record) => record.value)
  validate(records)
  const active = activePath(records)
  const ids = new Set(active.map((record) => String(record.uuid)))
  const events: Event[] = []
  let model: string | undefined

  for (const [index, record] of records.entries()) {
    if (!ids.has(String(record.uuid))) {
      events.push(opaque(index, record, "inactive_qwen_branch_record"))
    }
  }
  for (const record of active) {
    const index = records.indexOf(record)
    const type = record.type
    if (type === "user" || type === "assistant" || type === "tool_result") {
      events.push(...messageEvents(record, index))
      if (type === "assistant") model = str(record.model) ?? model
    } else if (record.subtype !== "custom_title") {
      events.push(opaque(index, record, "qwen_runtime_or_metadata_record"))
    }
  }
  const first = records[0]!
  const title = [...records]
    .reverse()
    .map((record) => {
      if (record.subtype !== "custom_title") return undefined
      return str(obj(record.systemPayload).customTitle)
    })
    .find(Boolean)

  return {
    source: "qwen",
    path,
    sha256: loaded.sha256,
    sessionID: String(first.sessionId),
    cwd: String(first.cwd),
    startedAt: String(first.timestamp),
    cliVersion: str(first.version),
    model,
    title,
    events,
    rawRecordCount: records.length,
  }
}

function validate(records: Record<string, unknown>[]) {
  if (!records.length) throw new MigrateError("Qwen session is empty")
  const ids = new Set<string>()
  let sessionID: string | undefined
  let history = false
  for (const record of records) {
    const id = requireUUID(record.uuid, "Qwen record uuid")
    if (ids.has(id)) throw new MigrateError("Qwen session contains a duplicate record uuid")
    const parent = record.parentUuid
    if (parent !== undefined && parent !== null && (typeof parent !== "string" || !ids.has(parent))) {
      throw new MigrateError("Qwen session record references a missing parent")
    }
    ids.add(id)
    const current = requireUUID(record.sessionId, "Qwen sessionId")
    sessionID ??= current
    if (current !== sessionID) throw new MigrateError("Qwen session contains mixed session IDs")
    if (!validRFC3339(record.timestamp)) throw new MigrateError("Qwen record has an invalid timestamp")
    if (!str(record.cwd) || !str(record.version)) throw new MigrateError("Qwen record is missing cwd or version metadata")
    const type = record.type
    if (type !== "user" && type !== "assistant" && type !== "tool_result" && type !== "system") {
      throw new MigrateError("Qwen record has an unsupported type")
    }
    if (type === "user" || type === "assistant" || type === "tool_result") {
      validateMessage(type, record.message)
      history = true
    }
  }
  activePath(records)
  if (!history) throw new MigrateError("Qwen session has no resumable conversation history")
}

function validateMessage(type: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MigrateError("Qwen message record is malformed")
  const message = obj(value)
  if (!Array.isArray(message.parts)) throw new MigrateError("Qwen message record is malformed")
  const expected = type === "assistant" ? "model" : "user"
  if (message.role !== expected) throw new MigrateError("Qwen message role does not match its record type")
  for (const part of message.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new MigrateError("Qwen message part is not an object")
  }
}

function activePath(records: Record<string, unknown>[]) {
  const byID = new Map(records.map((record) => [String(record.uuid), record]))
  const backward: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let current: Record<string, unknown> | undefined = records[records.length - 1]
  while (current) {
    const id = String(current.uuid)
    if (seen.has(id)) throw new MigrateError("Qwen session graph contains a cycle")
    seen.add(id)
    backward.push(current)
    const parent = current.parentUuid
    if (parent === undefined || parent === null) break
    current = byID.get(String(parent))
    if (!current) throw new MigrateError("Qwen session graph references a missing ancestor")
  }
  return backward.reverse()
}

function messageEvents(record: Record<string, unknown>, index: number): Event[] {
  const message = obj(record.message)
  const type = String(record.type)
  const timestamp = str(record.timestamp)
  const provenance = { recordIndex: index, recordType: type, sourceID: str(record.uuid) }
  const events: Event[] = []
  for (const [blockIndex, value] of (Array.isArray(message.parts) ? message.parts : []).entries()) {
    const part = obj(value)
    const source = { ...provenance, blockIndex }
    const text = str(part.text)
    if (text) {
      events.push({
        kind: part.thought === true ? "thinking" : "message",
        role: type === "assistant" ? "assistant" : "user",
        text,
        timestamp,
        payload: part.thought === true ? { reason: "qwen_private_thinking" } : {},
        provenance: source,
      })
      continue
    }
    const call = obj(part.functionCall)
    if (part.functionCall && typeof part.functionCall === "object") {
      events.push({
        kind: "tool_call",
        role: "assistant",
        toolName: str(call.name),
        toolCallID: str(call.id),
        timestamp,
        payload: { input: call.args ?? {} },
        provenance: source,
      })
      continue
    }
    const response = obj(part.functionResponse)
    if (part.functionResponse && typeof part.functionResponse === "object") {
      const portable = portableToolOutput(response.response ?? {})
      const toolResult = obj(record.toolCallResult)
      events.push({
        kind: "tool_result",
        role: "tool",
        text: portable.text || undefined,
        toolName: str(response.name),
        toolCallID: str(response.id),
        timestamp,
        payload: {
          content: portable.text,
          content_blocks: portable.blocks,
          is_error: toolResult.status === "error",
        },
        provenance: source,
      })
      continue
    }
    const inline = obj(part.inlineData)
    if (part.inlineData && typeof part.inlineData === "object") {
      const mime = str(inline.mimeType)
      const data = str(inline.data)
      events.push({
        kind: "context",
        role: type === "assistant" ? "assistant" : "user",
        timestamp,
        payload: { block_type: "image", image_url: mime && data ? `data:${mime};base64,${data}` : undefined },
        provenance: source,
      })
      continue
    }
    events.push({
      kind: "opaque",
      timestamp,
      payload: { reason: "qwen_unknown_message_part" },
      provenance: source,
    })
  }
  if (!Array.isArray(message.parts) || !message.parts.length) {
    events.push({
      kind: "opaque",
      timestamp,
      payload: { reason: "qwen_empty_message" },
      provenance,
    })
  }
  return events
}

function portableToolOutput(value: unknown): { text: string; blocks: Record<string, unknown>[] } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const payload = obj(value)
    const output = payload.output
    const text = typeof output === "string" ? output : contentText(output)
    const source = payload.sessionMigrateContent
    if (Array.isArray(source)) {
      const blocks = source.map((item) => {
        const block = obj(item)
        if (block.type === "text" && str(block.text)) return { type: "text", text: str(block.text) }
        if (block.type === "image" && portableDataImage(block.image_url)) return { type: "image", image_url: block.image_url }
        return { type: "opaque" }
      })
      return { text, blocks }
    }
    if (text) return { text, blocks: [{ type: "text", text }] }
  }
  let text = contentText(value)
  if (!text && value !== undefined && value !== null && !(typeof value === "object" && Object.keys(obj(value)).length === 0)) {
    text = JSON.stringify(value)
  }
  return { text, blocks: text ? [{ type: "text", text }] : [] }
}

function opaque(index: number, record: Record<string, unknown>, reason: string): Event {
  return {
    kind: "opaque",
    timestamp: validRFC3339(record.timestamp),
    payload: { reason },
    provenance: { recordIndex: index, recordType: str(record.type), sourceID: str(record.uuid) },
  }
}
