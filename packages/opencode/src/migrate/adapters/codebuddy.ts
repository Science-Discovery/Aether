import { basename } from "node:path"
import { MigrateError } from "../error"
import type { Event, ParsedSession } from "../model"
import { loadJSONL } from "../read"
import { obj, str, validRFC3339 } from "../util"

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records.map((record) => record.value)
  const events: Event[] = []
  let sessionID = basename(path, ".jsonl")
  let cwd: string | undefined
  let title: string | undefined
  let model: string | undefined
  let startedAt: string | undefined

  for (const [index, record] of records.entries()) {
    const type = str(record.type)
    const timestamp = stamp(record.timestamp)
    startedAt ??= timestamp
    sessionID = str(record.sessionId) ?? sessionID
    cwd ??= str(record.cwd)
    const provider = obj(record.providerData)
    model ??= str(provider.requestModelName) ?? str(provider.requestModelId) ?? str(provider.model)

    if (type === "message") {
      const role = str(record.role)
      if (role !== "user" && role !== "assistant") {
        events.push(opaque(index, type, timestamp, `codebuddy_${role ?? "unknown"}_message`))
        continue
      }
      const content = record.content
      const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []
      if (!blocks.length) {
        events.push(opaque(index, type, timestamp, "codebuddy_empty_message"))
        continue
      }
      for (const [blockIndex, value] of blocks.entries()) {
        const block = obj(value)
        const text = str(block.text)
        if (!text) continue
        events.push({
          kind: "message",
          role,
          text,
          timestamp,
          payload: {},
          provenance: { recordIndex: index, recordType: type, sourceID: str(record.id), blockIndex },
        })
      }
      continue
    }
    if (type === "reasoning") {
      const text =
        textBlocks(record.content).join("\n") ||
        textBlocks(record.rawContent).join("\n")
      if (text) {
        events.push({
          kind: "thinking",
          role: "assistant",
          text,
          timestamp,
          payload: { reason: "codebuddy_reasoning" },
          provenance: { recordIndex: index, recordType: type, sourceID: str(record.id) },
        })
      } else {
        events.push(opaque(index, type, timestamp, "codebuddy_empty_reasoning"))
      }
      continue
    }
    if (type === "function_call") {
      const callID = str(record.callId)
      const name = str(record.name)
      if (!callID || !name) {
        events.push(opaque(index, type, timestamp, "codebuddy_malformed_tool_call"))
        continue
      }
      const input = argumentsValue(record.arguments)
      events.push({
        kind: "tool_call",
        role: "assistant",
        toolName: name,
        toolCallID: callID,
        timestamp,
        payload: { input },
        provenance: { recordIndex: index, recordType: type, sourceID: str(record.id) },
      })
      continue
    }
    if (type === "function_call_result") {
      const callID = str(record.callId)
      const name = str(record.name)
      if (!callID) {
        events.push(opaque(index, type, timestamp, "codebuddy_malformed_tool_result"))
        continue
      }
      const output = obj(record.output)
      const text = str(output.text) ?? ""
      events.push({
        kind: "tool_result",
        role: "tool",
        text,
        toolName: name,
        toolCallID: callID,
        timestamp,
        payload: {
          is_error: str(record.status) !== "completed",
          content_blocks: text ? [{ type: "text", text }] : [],
        },
        provenance: { recordIndex: index, recordType: type, sourceID: str(record.id) },
      })
      continue
    }
    if (type === "summary") {
      const summary = str(record.summary)
      const source = str(provider.source)
      if (summary && source === "pre-compact") {
        events.push({
          kind: "compaction",
          role: "system",
          text: summary,
          timestamp,
          payload: { source_subtype: "codebuddy_pre_compact" },
          provenance: { recordIndex: index, recordType: type, sourceID: str(record.id) },
        })
      } else {
        events.push(opaque(index, type, timestamp, `codebuddy_summary:${source ?? "unknown"}`))
      }
      continue
    }
    if (type === "ai-title") {
      title = str(record.aiTitle) ?? title
      continue
    }
    if (type === "file-history-snapshot" || type === "turn-metrics") {
      events.push(opaque(index, type, timestamp, `codebuddy_${type}`))
      continue
    }
    events.push(opaque(index, type, timestamp, `codebuddy_${type ?? "unknown"}`))
  }

  if (!records.length) throw new MigrateError("CodeBuddy session is empty")
  return {
    source: "codebuddy",
    path,
    sha256: loaded.sha256,
    sessionID,
    cwd,
    startedAt,
    model,
    title,
    events,
    rawRecordCount: records.length,
  }
}

function argumentsValue(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return { input: value }
    }
  }
  return value ?? {}
}

function textBlocks(value: unknown) {
  if (!Array.isArray(value)) return typeof value === "string" && value ? [value] : []
  return value.flatMap((item) => {
    const text = str(obj(item).text)
    return text ? [text] : []
  })
}

function stamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString()
  return validRFC3339(value)
}

function opaque(index: number, recordType: string | undefined, timestamp: string | undefined, reason: string): Event {
  return {
    kind: "opaque",
    timestamp,
    payload: { reason },
    provenance: { recordIndex: index, recordType },
  }
}
