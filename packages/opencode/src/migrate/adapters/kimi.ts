import { statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { MigrateError } from "../error"
import type { Event, ParsedSession, Role } from "../model"
import { loadJSON, loadJSONL } from "../read"
import { obj, requireUUID, str } from "../util"

const protocol = "1.5"

export async function parse(path: string): Promise<ParsedSession> {
  const { sessionDir, wirePath, statePath } = sourcePaths(path)
  const state = await loadJSON(statePath)
  if (!state.value || typeof state.value !== "object" || Array.isArray(state.value)) {
    throw new MigrateError("Kimi state.json is not an object")
  }
  const meta = state.value as Record<string, unknown>
  validateState(meta, sessionDir)
  const wire = await loadJSONL(wirePath)
  const records = wire.records.map((record) => record.value)
  validateWire(records)

  const events: Event[] = []
  let model: string | undefined
  for (const [index, record] of records.slice(1).entries()) {
    const offset = index + 1
    const type = str(record.type)
    if (type === "context.append_message") events.push(...contextMessageEvents(record, offset))
    else if (type === "context.append_loop_event") events.push(...loopEvents(record, offset))
    else if (type === "context.apply_compaction") {
      const summary = str(record.summary) ?? str(record.contextSummary)
      events.push(
        summary
          ? {
              kind: "compaction",
              role: "system",
              text: summary,
              timestamp: msTimestamp(record.time),
              payload: {},
              provenance: { recordIndex: offset, recordType: type },
            }
          : {
              kind: "opaque",
              timestamp: msTimestamp(record.time),
              payload: { reason: "kimi_compaction_without_summary" },
              provenance: { recordIndex: offset, recordType: type },
            },
      )
    } else if (type === "llm.request") {
      model = str(record.model) ?? model
      events.push(opaque(offset, record, "kimi_runtime_record"))
    } else {
      events.push(opaque(offset, record, "kimi_runtime_record"))
    }
  }

  const sha256 = new Bun.CryptoHasher("sha256").update(state.text).update("\0").update(wire.text).digest("hex")
  return {
    source: "kimi",
    path: wirePath,
    sha256,
    sessionID: nativeSessionID(meta.id),
    cwd: str(meta.cwd),
    startedAt: msTimestamp(meta.createdAt),
    cliVersion: "0.38.0",
    model,
    title: str(meta.title),
    events,
    rawRecordCount: records.length,
  }
}

function sourcePaths(path: string) {
  const info = statSync(path)
  let sessionDir: string
  if (info.isDirectory()) sessionDir = path
  else if (basename(path) === "wire.jsonl" && basename(dirname(path)) === "main" && basename(dirname(dirname(path))) === "agents") {
    sessionDir = dirname(dirname(dirname(path)))
  } else if (basename(path) === "state.json") {
    sessionDir = dirname(path)
  } else {
    throw new MigrateError("Kimi source must be a session directory, state.json, or agents/main/wire.jsonl")
  }
  return {
    sessionDir,
    wirePath: join(sessionDir, "agents/main/wire.jsonl"),
    statePath: join(sessionDir, "state.json"),
  }
}

function validateState(state: Record<string, unknown>, sessionDir: string) {
  nativeSessionID(state.id)
  if (state.version !== 2 || !str(state.cwd)) {
    throw new MigrateError("Kimi state metadata has an unsupported version or cwd")
  }
  for (const key of ["createdAt", "updatedAt"]) {
    const value = state[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new MigrateError("Kimi state metadata has an invalid timestamp")
    }
  }
  if (typeof state.archived !== "boolean") throw new MigrateError("Kimi state metadata has an invalid archive flag")
  const agents = obj(state.agents)
  const main = obj(agents.main)
  if (main.type !== "main" || !str(main.homedir)) {
    throw new MigrateError("Kimi state metadata is missing the main agent")
  }
  const homedir = String(main.homedir)
  if (isAbsolute(homedir) && resolve(homedir) !== resolve(join(sessionDir, "agents/main"))) {
    throw new MigrateError("Kimi main-agent path does not match the session directory")
  }
}

function validateWire(records: Record<string, unknown>[]) {
  if (!records.length) throw new MigrateError("Kimi wire journal is empty")
  const header = records[0]!
  if (header.type !== "metadata" || header.protocol_version !== protocol || typeof header.created_at !== "number") {
    throw new MigrateError("Kimi wire journal has an unsupported metadata header")
  }
  let history = false
  for (const record of records.slice(1)) {
    if (!str(record.type) || typeof record.time !== "number") throw new MigrateError("Kimi wire record is missing type or time")
    if (record.type === "context.append_message") {
      validateMessage(record.message)
      history = true
    } else if (record.type === "context.append_loop_event") {
      const event = obj(record.event)
      if (!str(event.type)) throw new MigrateError("Kimi loop event is malformed")
      history = true
    } else if (record.type === "context.apply_compaction") {
      if (!str(record.summary) && !str(record.contextSummary)) {
        throw new MigrateError("Kimi compaction record has no summary")
      }
      history = true
    }
  }
  if (!history) throw new MigrateError("Kimi wire journal has no resumable conversation history")
}

function validateMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrateError("Kimi context message has an invalid role")
  }
  const message = obj(value)
  if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") {
    throw new MigrateError("Kimi context message has an invalid role")
  }
  if (!Array.isArray(message.content) || !Array.isArray(message.toolCalls)) {
    throw new MigrateError("Kimi context message is missing content or tool calls")
  }
  for (const value of message.content) {
    const part = obj(value)
    if (part.type !== "text" && part.type !== "think" && part.type !== "image_url" && part.type !== "audio_url" && part.type !== "video_url") {
      throw new MigrateError("Kimi context message contains an invalid content part")
    }
  }
  for (const value of message.toolCalls) {
    const call = obj(value)
    if (call.type !== "function" || !str(call.id) || !str(call.name) || (call.arguments !== null && call.arguments !== undefined && typeof call.arguments !== "string")) {
      throw new MigrateError("Kimi context message contains an invalid tool call")
    }
  }
}

function contextMessageEvents(record: Record<string, unknown>, index: number): Event[] {
  const message = obj(record.message)
  const roleName = str(message.role)
  const origin = message.origin
  const originKind = typeof origin === "object" && origin !== null && !Array.isArray(origin) ? str(obj(origin).kind) : str(origin)
  const timestamp = msTimestamp(record.time)
  if (roleName === "system" || (roleName === "user" && originKind !== undefined && originKind !== null && originKind !== "user")) {
    return [opaque(index, record, `kimi_${originKind ?? roleName}_message`)]
  }
  if (roleName === "tool") {
    const blocks: Record<string, unknown>[] = []
    const texts: string[] = []
    for (const value of Array.isArray(message.content) ? message.content : []) {
      const part = obj(value)
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text)
        blocks.push({ type: "text", text: part.text })
      } else if (part.type === "image_url") {
        const image = obj(part.imageUrl)
        const url = str(image.url)
        blocks.push(url ? { type: "image", image_url: url } : { type: "opaque" })
      } else {
        blocks.push({ type: "opaque" })
      }
    }
    const text = texts.join("\n")
    return [
      {
        kind: "tool_result",
        role: "tool",
        text: text || undefined,
        toolName: str(message.name),
        toolCallID: str(message.toolCallId),
        timestamp,
        payload: { content: text, content_blocks: blocks, is_error: message.isError === true },
        provenance: { recordIndex: index, recordType: str(record.type) },
      },
    ]
  }
  const role: Role = roleName === "assistant" ? "assistant" : "user"
  const events: Event[] = []
  for (const [blockIndex, value] of (Array.isArray(message.content) ? message.content : []).entries()) {
    const part = obj(value)
    const provenance = { recordIndex: index, recordType: str(record.type), blockIndex }
    if (part.type === "text" && typeof part.text === "string") {
      events.push({ kind: "message", role, text: part.text, timestamp, payload: {}, provenance })
    } else if (part.type === "think") {
      events.push({
        kind: "thinking",
        role: "assistant",
        text: str(part.think),
        timestamp,
        payload: { encrypted_content: str(part.encrypted), reason: "kimi_private_thinking" },
        provenance,
      })
    } else if (part.type === "image_url") {
      const image = obj(part.imageUrl)
      events.push({
        kind: "context",
        role,
        timestamp,
        payload: { block_type: "image", image_url: str(image.url) },
        provenance,
      })
    } else {
      events.push({ kind: "opaque", role, timestamp, payload: { reason: `kimi_${part.type}_content` }, provenance })
    }
  }
  for (const value of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
    const call = obj(value)
    let input: unknown = {}
    if (typeof call.arguments === "string") {
      try {
        input = JSON.parse(call.arguments)
      } catch {
        input = call.arguments
      }
    }
    events.push({
      kind: "tool_call",
      role: "assistant",
      toolName: str(call.name),
      toolCallID: str(call.id),
      timestamp,
      payload: { input },
      provenance: { recordIndex: index, recordType: str(record.type) },
    })
  }
  return events
}

function loopEvents(record: Record<string, unknown>, index: number): Event[] {
  const event = obj(record.event)
  const type = str(event.type)
  const timestamp = msTimestamp(record.time)
  const provenance = { recordIndex: index, recordType: `context.append_loop_event:${type}` }
  if (type === "content.part") {
    const part = obj(event.part)
    if (part.type === "text" && typeof part.text === "string") {
      return [{ kind: "message", role: "assistant", text: part.text, timestamp, payload: {}, provenance }]
    }
    if (part.type === "think") {
      return [
        {
          kind: "thinking",
          role: "assistant",
          text: str(part.think),
          timestamp,
          payload: { reason: "kimi_private_thinking" },
          provenance,
        },
      ]
    }
  }
  if (type === "tool.call") {
    return [
      {
        kind: "tool_call",
        role: "assistant",
        toolName: str(event.name),
        toolCallID: str(event.toolCallId),
        timestamp,
        payload: { input: event.args ?? {} },
        provenance,
      },
    ]
  }
  if (type === "tool.result") {
    const result = event.result
    const output = typeof result === "object" && result !== null && !Array.isArray(result) ? obj(result).output : result
    const text = typeof output === "string" ? output : JSON.stringify(output)
    return [
      {
        kind: "tool_result",
        role: "tool",
        text,
        toolCallID: str(event.toolCallId),
        timestamp,
        payload: { content: text, content_blocks: text ? [{ type: "text", text }] : [] },
        provenance,
      },
    ]
  }
  if (type === "step.begin" || type === "step.end") return []
  return [opaque(index, record, "kimi_unknown_loop_event")]
}

function opaque(index: number, record: Record<string, unknown>, reason: string): Event {
  return {
    kind: "opaque",
    timestamp: msTimestamp(record.time),
    payload: { reason },
    provenance: { recordIndex: index, recordType: str(record.type) },
  }
}

function nativeSessionID(value: unknown) {
  const raw = typeof value === "string" ? value.replace(/^session_/, "") : value
  return `session_${requireUUID(raw, "Kimi session ID")}`
}

function msTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined
  return new Date(value).toISOString()
}

