import { readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { MigrateError } from "../error"
import type { Event, ParsedSession, Role } from "../model"
import { checkBounds, loadJSON, loadJSONL } from "../read"
import { obj, portableDataImage, str, uuid, validRFC3339 } from "../util"

const known = new Set([
  "role",
  "content",
  "images",
  "injected",
  "reasoning_content",
  "reasoning_payloads",
  "reasoning_message_id",
  "tool_calls",
  "name",
  "tool_call_id",
  "tool_result",
  "message_id",
  "user_display_content",
  "input_text",
  "resources",
  "manual_shell",
  "context_boundary",
])

export async function parse(path: string): Promise<ParsedSession> {
  const { sessionDir, messagesPath, metaPath } = sourcePaths(path)
  const metaFile = await loadJSON(metaPath)
  const messages = await loadJSONL(messagesPath)
  const meta = obj(metaFile.value)
  checkBounds(meta, 1_000_000, 64)
  const sessionID = canonical(meta.session_id, "Vibe metadata session_id")
  const events: Event[] = []
  const system = str(meta.system_prompt)
  if (system) {
    events.push({
      kind: "message",
      role: "system",
      text: system,
      timestamp: validRFC3339(meta.start_time),
      provenance: { recordIndex: -1, recordType: "meta.system_prompt" },
      payload: {},
    })
  }
  for (const [index, record] of messages.records.entries()) {
    events.push(...messageEvents(record.value, index, sessionDir))
  }
  const config = obj(meta.config)
  const selected = modelProvider(config)
  const environment = obj(meta.environment)
  const sha256 = new Bun.CryptoHasher("sha256").update(metaFile.text).update("\0").update(messages.text).digest("hex")

  return {
    source: "vibe",
    path: messagesPath,
    sha256,
    sessionID,
    cwd: str(environment.working_directory),
    startedAt: validRFC3339(meta.start_time),
    cliVersion: str(config.target_cli_version),
    model: selected.model,
    provider: selected.provider,
    title: str(meta.title),
    events,
    rawRecordCount: messages.records.length,
  }
}

function sourcePaths(path: string) {
  const info = statSync(path)
  const sessionDir = info.isDirectory() ? path : dirname(path)
  const messagesPath = info.isDirectory() ? join(sessionDir, "messages.jsonl") : path
  const metaPath = join(sessionDir, "meta.json")
  if (basename(messagesPath) !== "messages.jsonl") {
    throw new MigrateError("Vibe source must be a session directory containing meta.json and messages.jsonl")
  }
  return { sessionDir, messagesPath, metaPath }
}

function messageEvents(value: unknown, index: number, sessionDir: string): Event[] {
  validateMessage(value, index)
  const message = obj(value)
  const roleName = String(message.role)
  const role: Role = roleName === "user" ? "user" : roleName === "assistant" ? "assistant" : roleName === "tool" ? "tool" : "system"
  const provenance = { recordIndex: index, recordType: `vibe.${roleName}`, sourceID: str(message.message_id) }
  if (message.context_boundary === "compaction") {
    return [
      {
        kind: "compaction",
        role,
        text: str(message.content),
        payload: { source_boundary: "vibe" },
        provenance,
      },
    ]
  }
  if (message.injected === true) {
    return [{ kind: "opaque", role, payload: { reason: "vibe_injected_runtime_message" }, provenance }]
  }
  const events: Event[] = []
  const reasoning = str(message.reasoning_content)
  if (reasoning) {
    events.push({
      kind: "thinking",
      role: "assistant",
      text: reasoning,
      payload: { source_readable_reasoning: true },
      provenance,
    })
  }
  if (Array.isArray(message.reasoning_payloads) && message.reasoning_payloads.length) {
    events.push({ kind: "opaque", role: "assistant", payload: { reason: "vibe_reasoning_payloads" }, provenance })
  }
  const content = str(message.content)
  if (role === "tool") {
    const result = obj(message.tool_result)
    const output = result.output
    const payload: Record<string, unknown> =
      typeof output === "object" && output !== null && !Array.isArray(output) ? { ...obj(output) } : { content: output }
    const portable = payload.session_migrate_text
    delete payload.session_migrate_text
    const text = typeof portable === "string" ? portable : content
    const isError = payload.session_migrate_is_error === true
    delete payload.session_migrate_is_error
    events.push({
      kind: "tool_result",
      role: "tool",
      text,
      toolName: str(message.name),
      toolCallID: str(message.tool_call_id),
      payload: { ...payload, is_error: isError },
      provenance,
    })
    if (result.duration !== undefined || result.cancelled === true || result.presentation !== undefined) {
      events.push({ kind: "opaque", role: "tool", payload: { reason: "vibe_tool_result_runtime_metadata" }, provenance })
    }
    events.push(...runtimeMetadata(message, index, role))
    return events
  }
  if (content) {
    events.push({ kind: "message", role, text: content, provenance, payload: {} })
  }
  if (Array.isArray(message.images)) {
    for (const [blockIndex, image] of message.images.entries()) {
      const url = imageURL(image, sessionDir)
      const source = { ...provenance, blockIndex }
      if (url) {
        events.push({ kind: "context", role, payload: { block_type: "image", image_url: url }, provenance: source })
      } else {
        events.push({ kind: "opaque", role, payload: { reason: "vibe_image_unreadable" }, provenance: source })
      }
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const [blockIndex, value] of message.tool_calls.entries()) {
      const call = obj(value)
      const fn = obj(call.function)
      let args: unknown = {}
      if (typeof fn.arguments === "string") {
        try {
          args = JSON.parse(fn.arguments)
        } catch {
          args = { input: fn.arguments }
        }
      }
      const source = { recordIndex: index, recordType: "vibe.tool_call", blockIndex }
      events.push({
        kind: "tool_call",
        role: "assistant",
        toolName: str(fn.name),
        toolCallID: str(call.id),
        payload: { input: args },
        provenance: source,
      })
      if (call.presentation !== undefined) {
        events.push({ kind: "opaque", role: "assistant", payload: { reason: "vibe_tool_call_presentation" }, provenance: source })
      }
    }
  }
  events.push(...runtimeMetadata(message, index, role))
  return events
}

function runtimeMetadata(message: Record<string, unknown>, index: number, role: Role) {
  const events: Event[] = []
  const reasons: Record<string, string> = {
    user_display_content: "vibe_user_display_content",
    input_text: "vibe_input_text",
    resources: "vibe_resources",
    manual_shell: "vibe_manual_shell",
  }
  for (const [field, reason] of Object.entries(reasons)) {
    if (message[field] !== undefined) {
      events.push({
        kind: "opaque",
        role,
        payload: { reason },
        provenance: { recordIndex: index, recordType: `vibe.${field}` },
      })
    }
  }
  if (message.name !== undefined && role !== "tool") {
    events.push({
      kind: "opaque",
      role,
      payload: { reason: "vibe_message_name" },
      provenance: { recordIndex: index, recordType: "vibe.name" },
    })
  }
  for (const field of Object.keys(message).filter((key) => !known.has(key)).sort()) {
    events.push({
      kind: "opaque",
      role,
      payload: { reason: "vibe_unknown_message_field", source_field: field },
      provenance: { recordIndex: index, recordType: `vibe.unknown.${field}` },
    })
  }
  return events
}

function validateMessage(value: unknown, index: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrateError(`Vibe message ${index} has an invalid role`)
  }
  const message = obj(value)
  if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") {
    throw new MigrateError(`Vibe message ${index} has an invalid role`)
  }
  if (message.content !== undefined && typeof message.content !== "string") {
    throw new MigrateError(`Vibe message ${index} has invalid content`)
  }
  if (message.role !== "tool" && typeof message.message_id !== "string") {
    throw new MigrateError(`Vibe message ${index} is missing message_id`)
  }
  if (message.role === "tool" && typeof message.tool_call_id !== "string") {
    throw new MigrateError(`Vibe tool result ${index} is missing tool_call_id`)
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new MigrateError(`Vibe message ${index} has invalid tool_calls`)
    for (const value of message.tool_calls) {
      const call = obj(value)
      const fn = obj(call.function)
      if (!str(call.id) || !str(fn.name) || typeof fn.arguments !== "string") {
        throw new MigrateError(`Vibe message ${index} has a malformed tool call`)
      }
    }
  }
  if (message.images !== undefined) {
    if (!Array.isArray(message.images) || message.images.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new MigrateError(`Vibe message ${index} has malformed images`)
    }
  }
  checkBounds(message, 1_000_000, 64)
}

function imageURL(value: unknown, sessionDir: string) {
  const image = obj(value)
  const mime = str(image.mime_type)
  const source = obj(image.source)
  if (!mime) return undefined
  if (source.kind === "inline") {
    const data = str(source.data)
    const candidate = data ? `data:${mime};base64,${data}` : undefined
    return candidate && portableDataImage(candidate) ? candidate : undefined
  }
  if (source.kind !== "file" || typeof source.path !== "string") return undefined
  const path = isAbsolute(source.path) ? source.path : join(sessionDir, source.path)
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > 32 * 1024 * 1024) return undefined
    const data = readFileSync(path)
    const candidate = `data:${mime};base64,${data.toString("base64")}`
    return portableDataImage(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function modelProvider(config: Record<string, unknown>) {
  const generated = str(config.model)
  const alias = str(config.active_model)
  const models = obj(config.models)
  if (!alias || !config.models || typeof config.models !== "object") return { model: generated ?? alias, provider: undefined }
  const active = obj(models[alias])
  if (!config.models || !Object.keys(active).length) return { model: alias, provider: undefined }
  return { model: str(active.name) ?? alias, provider: str(active.provider) }
}

function canonical(value: unknown, label: string): string {
  const id = uuid(value)
  if (!id || typeof value !== "string" || id !== value.toLowerCase()) throw new MigrateError(`${label} is not canonical`)
  return id
}
