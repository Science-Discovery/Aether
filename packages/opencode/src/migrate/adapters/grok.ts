import { statSync } from "node:fs"
import { dirname, join } from "node:path"
import { MigrateError } from "../error"
import type { Event, ParsedSession, Role } from "../model"
import { checkBounds, loadJSON, loadJSONL } from "../read"
import { obj, portableDataImage, requireUUID, str, validRFC3339 } from "../util"

export async function parse(path: string): Promise<ParsedSession> {
  const directory = sourceDirectory(path)
  const summaryFile = await loadJSON(join(directory, "summary.json"))
  const updatesFile = await loadJSONL(join(directory, "updates.jsonl"))
  const summary = obj(summaryFile.value)
  checkBounds(summary)
  const info = obj(summary.info)
  const sessionID = requireUUID(info.id, "Grok source session ID")
  const cwd = str(info.cwd)
  if (!cwd) throw new MigrateError("Grok summary is missing its working directory")
  const records = updatesFile.records.map((record) => record.value)
  validateUpdates(records, sessionID)
  if (typeof summary.num_messages !== "number" || summary.num_messages !== records.length) {
    throw new MigrateError("Grok summary message count does not match updates.jsonl")
  }
  const events = records.flatMap((record, index) => updateEvents(record, index))
  const sha256 = new Bun.CryptoHasher("sha256").update(summaryFile.text).update("\0").update(updatesFile.text).digest("hex")

  return {
    source: "grok",
    path: directory,
    sha256,
    sessionID,
    cwd,
    startedAt: validRFC3339(summary.created_at),
    cliVersion: "1.0.5",
    model: str(summary.current_model_id),
    provider: "xai",
    title: str(summary.generated_title) ?? str(summary.session_summary),
    events,
    rawRecordCount: records.length + 1,
  }
}

function sourceDirectory(path: string) {
  const info = statSync(path)
  const directory = info.isDirectory() ? path : dirname(path)
  try {
    statSync(join(directory, "summary.json"))
    statSync(join(directory, "updates.jsonl"))
  } catch {
    throw new MigrateError("Grok source must be a session directory containing summary.json and updates.jsonl")
  }
  return directory
}

function validateUpdates(records: Record<string, unknown>[], sessionID: string) {
  if (!records.length) throw new MigrateError("Grok update log is empty")
  for (const [index, value] of records.entries()) {
    checkBounds(value)
    if (value.method !== "session/update" && value.method !== "_x.ai/session/update") {
      throw new MigrateError("Grok update envelope is malformed")
    }
    const params = obj(value.params)
    const update = obj(params.update)
    if (params.sessionId !== sessionID || !str(update.sessionUpdate) || typeof value.timestamp !== "number") {
      throw new MigrateError("Grok update linkage or metadata is invalid")
    }
    validateUpdate(update, index)
  }
}

function validateUpdate(update: Record<string, unknown>, index: number) {
  const kind = String(update.sessionUpdate)
  if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = obj(update.content)
    if (content.type !== "text" && content.type !== "image") throw new MigrateError(`Grok update ${index} is malformed`)
    if (content.type === "text" && typeof content.text !== "string") throw new MigrateError(`Grok update ${index} is malformed`)
    if (content.type === "image" && !portableDataImage(content.uri) && !(str(content.data) && str(content.mimeType))) {
      throw new MigrateError(`Grok update ${index} is malformed`)
    }
  } else if ((kind === "tool_call" || kind === "tool_call_update") && !str(update.toolCallId)) {
    throw new MigrateError(`Grok update ${index} is malformed`)
  }
}

function updateEvents(record: Record<string, unknown>, index: number): Event[] {
  const update = obj(obj(record.params).update)
  const kind = String(update.sessionUpdate)
  const timestamp = new Date(Number(record.timestamp) * 1000).toISOString()
  const provenance = { recordIndex: index, recordType: `grok.${kind}` }
  if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
    const role: Role = kind.startsWith("user") ? "user" : "assistant"
    const content = obj(update.content)
    if (content.type === "text") {
      const text = String(content.text)
      if (role === "user" && text.startsWith("[Imported conversation summary]\n")) {
        return [
          {
            kind: "compaction",
            role: "system",
            text: text.slice("[Imported conversation summary]\n".length),
            timestamp,
            payload: { source_subtype: "grok_imported_summary" },
            provenance,
          },
        ]
      }
      return [{ kind: "message", role, text, timestamp, payload: {}, provenance }]
    }
    if (content.type === "image" && role === "user") {
      const url = str(content.uri) ?? `data:${content.mimeType};base64,${content.data}`
      return [{ kind: "context", role, timestamp, payload: { block_type: "image", image_url: url }, provenance }]
    }
  }
  if (kind === "agent_thought_chunk") {
    return [{ kind: "opaque", role: "assistant", timestamp, payload: { reason: "grok_private_thinking" }, provenance }]
  }
  if (kind === "tool_call") {
    return [
      {
        kind: "tool_call",
        role: "assistant",
        timestamp,
        toolName: str(update.title),
        toolCallID: str(update.toolCallId),
        payload: { input: update.rawInput ?? {} },
        provenance,
      },
    ]
  }
  if (kind === "tool_call_update" && (update.status === "completed" || update.status === "failed")) {
    const raw = obj(update.rawOutput)
    let text = str(raw.session_migrate_text)
    let blocks = updateBlocks(update)
    if (text === undefined) {
      text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("")
      if (!text && !blocks.length) text = toolUpdateText(update)
    }
    if (!blocks.length && text) blocks = [{ type: "text", text }]
    return [
      {
        kind: "tool_result",
        role: "tool",
        timestamp,
        toolName: str(update.title),
        toolCallID: str(update.toolCallId),
        text,
        payload: { is_error: update.status === "failed", content_blocks: blocks },
        provenance,
      },
    ]
  }
  return [{ kind: "opaque", timestamp, payload: { reason: `grok_${kind}` }, provenance }]
}

function updateBlocks(update: Record<string, unknown>) {
  const result: Record<string, unknown>[] = []
  for (const value of Array.isArray(update.content) ? update.content : []) {
    const content = obj(obj(value).content)
    if (content.type === "text") {
      result.push({ type: "text", text: String(content.text ?? "") })
    } else if (content.type === "image") {
      const mime = str(content.mimeType)
      const data = str(content.data)
      const candidate = mime && data ? `data:${mime};base64,${data}` : undefined
      if (!candidate || !portableDataImage(candidate)) throw new MigrateError("Grok tool image content is malformed")
      result.push({ type: "image", image_url: candidate })
    }
  }
  return result
}

function toolUpdateText(update: Record<string, unknown>) {
  const texts = updateBlocks(update)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
  if (texts.length) return texts.join("")
  return update.rawOutput !== undefined ? JSON.stringify(update.rawOutput) : ""
}

