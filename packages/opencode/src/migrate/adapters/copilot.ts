import { MigrateError } from "../error"
import type { Event, ParsedSession } from "../model"
import { checkBounds, loadJSONL } from "../read"
import { obj, portableDataImage, str, validRFC3339 } from "../util"

const eventVersion = 1
const known = new Set([
  "abort",
  "assistant.intent",
  "assistant.message",
  "assistant.message_delta",
  "assistant.message_start",
  "assistant.reasoning",
  "assistant.reasoning_delta",
  "assistant.streaming_delta",
  "assistant.turn_end",
  "assistant.turn_start",
  "assistant.usage",
  "auto_mode_switch.completed",
  "auto_mode_switch.requested",
  "capabilities.changed",
  "command.completed",
  "command.execute",
  "command.queued",
  "commands.changed",
  "elicitation.completed",
  "elicitation.requested",
  "exit_plan_mode.completed",
  "exit_plan_mode.requested",
  "external_tool.completed",
  "external_tool.requested",
  "hook.end",
  "hook.progress",
  "hook.start",
  "mcp.oauth_completed",
  "mcp.oauth_required",
  "mcp_app.tool_call_complete",
  "model.call_failure",
  "pending_messages.modified",
  "permission.completed",
  "permission.requested",
  "sampling.completed",
  "sampling.requested",
  "session.autopilot_objective_changed",
  "session.background_tasks_changed",
  "session.binary_asset",
  "session.canvas.closed",
  "session.canvas.opened",
  "session.canvas.registry_changed",
  "session.compaction_complete",
  "session.compaction_start",
  "session.context_changed",
  "session.custom_agents_updated",
  "session.custom_notification",
  "session.error",
  "session.extensions.attachments_pushed",
  "session.extensions_loaded",
  "session.handoff",
  "session.idle",
  "session.info",
  "session.mcp_server_status_changed",
  "session.mcp_servers_loaded",
  "session.mode_changed",
  "session.model_change",
  "session.permissions_changed",
  "session.plan_changed",
  "session.remote_steerable_changed",
  "session.resume",
  "session.schedule_cancelled",
  "session.schedule_created",
  "session.shutdown",
  "session.skills_loaded",
  "session.snapshot_rewind",
  "session.start",
  "session.task_complete",
  "session.title_changed",
  "session.todos_changed",
  "session.tools_updated",
  "session.truncation",
  "session.usage_info",
  "session.warning",
  "session.workspace_file_changed",
  "skill.invoked",
  "subagent.completed",
  "subagent.deselected",
  "subagent.failed",
  "subagent.selected",
  "subagent.started",
  "system.message",
  "system.notification",
  "tool.execution_complete",
  "tool.execution_partial_result",
  "tool.execution_progress",
  "tool.execution_start",
  "tool.user_requested",
  "user.message",
  "user_input.completed",
  "user_input.requested",
])

type Asset = [mime: string, data: string, bytes: number]

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records.map((record) => record.value)
  validateSource(records, path)
  const first = obj(records[0]!.data)
  const assets = inventory(records)
  const referenced = new Set<string>()
  const calls = new Map<string, number>()
  const names = new Map<string, string>()
  const events: Event[] = []
  let model = str(first.selectedModel)
  let title: string | undefined

  const addOpaque = (index: number, type: string, reason: string, timestamp: string | undefined, payload: Record<string, unknown> = {}) => {
    events.push({
      kind: "opaque",
      timestamp,
      payload: { reason, source_event_type: type, ...payload },
      provenance: { recordIndex: index, recordType: type, sourceID: str(records[index]?.id) },
    })
  }

  for (const [index, record] of records.entries()) {
    const type = String(record.type)
    const data = obj(record.data)
    const timestamp = str(record.timestamp)
    const provenance = { recordIndex: index, recordType: type, sourceID: str(record.id) }
    if (str(record.agentId)) {
      addOpaque(index, type, "copilot_subagent_scoped_event", timestamp)
      continue
    }
    if (type === "user.message") {
      const content = str(data.content)
      if (content) {
        events.push({ kind: "message", role: "user", text: content, timestamp, provenance, payload: {} })
      }
      const transformed = str(data.transformedContent)
      if (transformed && transformed !== content) addOpaque(index, type, "copilot_user_transformed_content", timestamp)
      for (const [blockIndex, value] of (Array.isArray(data.attachments) ? data.attachments : []).entries()) {
        const attachment = obj(value)
        const url = attachmentImage(attachment, assets)
        const assetID = str(attachment.assetId)
        if (url) {
          if (assetID) referenced.add(assetID)
          events.push({
            kind: "context",
            role: "user",
            timestamp,
            payload: { block_type: "image", image_url: url },
            provenance: { ...provenance, blockIndex },
          })
        } else {
          const attachmentType = str(attachment.type) ?? "unknown"
          events.push({
            kind: "opaque",
            role: "user",
            timestamp,
            payload: { reason: `copilot_attachment_${attachmentType}`, source_block_type: attachmentType },
            provenance: { ...provenance, blockIndex },
          })
        }
      }
      continue
    }
    if (type === "assistant.message") {
      const reasoning = str(data.reasoningText)
      if (reasoning) {
        events.push({ kind: "thinking", role: "assistant", text: reasoning, timestamp, provenance, payload: {} })
      }
      if (str(data.reasoningOpaque)) addOpaque(index, type, "copilot_reasoning_opaque", timestamp)
      if (str(data.encryptedContent)) addOpaque(index, type, "copilot_encrypted_content", timestamp)
      if (str(data.content)) {
        events.push({ kind: "message", role: "assistant", text: str(data.content), timestamp, provenance, payload: {} })
      }
      for (const [blockIndex, value] of (Array.isArray(data.toolRequests) ? data.toolRequests : []).entries()) {
        const request = obj(value)
        const callID = String(request.toolCallId)
        const name = String(request.name)
        calls.set(callID, (calls.get(callID) ?? 0) + 1)
        names.set(callID, name)
        const payload: Record<string, unknown> = { input: request.arguments ?? {} }
        if (str(request.mcpServerName)) payload.namespace = request.mcpServerName
        events.push({
          kind: "tool_call",
          role: "assistant",
          toolName: name,
          toolCallID: callID,
          timestamp,
          payload,
          provenance: { ...provenance, blockIndex },
        })
      }
      if (data.citations !== undefined) addOpaque(index, type, "copilot_assistant_citations", timestamp)
      if (data.serverTools !== undefined) addOpaque(index, type, "copilot_assistant_server_tools", timestamp)
      continue
    }
    if (type === "tool.execution_start") {
      const callID = String(data.toolCallId)
      names.set(callID, String(data.toolName))
      const count = calls.get(callID) ?? 0
      if (count > 0) {
        calls.set(callID, count - 1)
      } else {
        const payload: Record<string, unknown> = { input: data.arguments ?? {} }
        if (str(data.mcpServerName)) payload.namespace = data.mcpServerName
        events.push({
          kind: "tool_call",
          role: "assistant",
          toolName: String(data.toolName),
          toolCallID: callID,
          timestamp,
          payload,
          provenance,
        })
      }
      continue
    }
    if (type === "tool.execution_complete") {
      const callID = String(data.toolCallId)
      if (data.isUserRequested === true) {
        addOpaque(index, type, "copilot_user_requested_tool_result", timestamp)
        continue
      }
      const result = obj(data.result)
      const portable = portableSourceResult(result, assets)
      for (const id of portable.used) referenced.add(id)
      let content = str(result.content)
      const error = obj(data.error)
      if (data.success === false) content = str(error.message) ?? content
      events.push({
        kind: "tool_result",
        role: "tool",
        text: content,
        toolName: names.get(callID),
        toolCallID: callID,
        timestamp,
        payload: {
          is_error: data.success === false,
          content_blocks: portable.blocks,
        },
        provenance,
      })
      for (const reason of portable.omissions) addOpaque(index, type, reason, timestamp)
      continue
    }
    if (type === "session.compaction_complete") {
      const summary = str(data.summaryContent)
      if (data.success === true && summary) {
        events.push({ kind: "compaction", role: "system", text: summary, timestamp, provenance, payload: {} })
      } else {
        addOpaque(index, type, "copilot_compaction_without_summary", timestamp)
      }
      continue
    }
    if (type === "session.model_change") {
      model = str(data.newModel) ?? model
      addOpaque(index, type, "copilot_model_change_metadata", timestamp)
      continue
    }
    if (type === "session.title_changed") {
      title = str(data.title) ?? title
      continue
    }
    if (type === "system.message") {
      addOpaque(index, type, "copilot_privileged_system_message", timestamp)
      continue
    }
    if (type === "session.binary_asset") continue
    if (type !== "session.start") addOpaque(index, type, "copilot_native_lifecycle_or_ui_event", timestamp)
  }

  for (const [index, record] of records.entries()) {
    if (record.type !== "session.binary_asset") continue
    const assetID = String(obj(record.data).assetId)
    if (!referenced.has(assetID)) addOpaque(index, "session.binary_asset", "copilot_unreferenced_binary_asset", str(record.timestamp))
  }

  title ??= await workspaceTitle(path)
  const context = obj(first.context)
  const cwd = str(context.cwd)
  return {
    source: "copilot",
    path,
    sha256: loaded.sha256,
    sessionID: String(first.sessionId),
    cwd,
    startedAt: String(first.startTime),
    cliVersion: String(first.copilotVersion),
    model,
    provider: "github-copilot",
    title,
    events,
    rawRecordCount: records.length,
  }
}

function validateSource(records: Record<string, unknown>[], path: string) {
  if (!records.length || records[0]?.type !== "session.start") {
    throw new MigrateError("Copilot session must begin with session.start")
  }
  const first = obj(records[0].data)
  const sessionID = str(first.sessionId)
  if (!sessionID || !isUUID(sessionID)) throw new MigrateError("Copilot session ID is not a UUID")
  const parent = path.split(/[\\/]/).at(-2)
  if (parent && isUUID(parent) && parent !== sessionID) {
    throw new MigrateError("Copilot session directory does not match session.start")
  }
  if (first.version !== eventVersion) throw new MigrateError("Copilot session event version is unsupported")
  if (!str(first.producer) || !str(first.copilotVersion)) {
    throw new MigrateError("Copilot session.start is missing required metadata")
  }
  if (!validRFC3339(first.startTime)) throw new MigrateError("Copilot session start time is invalid")
  if (first.context !== undefined) {
    if (!first.context || typeof first.context !== "object" || Array.isArray(first.context)) {
      throw new MigrateError("Copilot working directory context is invalid")
    }
    const cwd = str(obj(first.context).cwd)
    if (!cwd || cwd.includes("\0")) throw new MigrateError("Copilot working directory context is invalid")
  }

  let prior: string | undefined
  let last = 0
  let starts = 0
  const ids = new Set<string>()
  for (const [index, record] of records.entries()) {
    checkBounds(record)
    const type = str(record.type)
    if (!type || !known.has(type)) throw new MigrateError(`unsupported Copilot source event: ${type}`)
    if (type === "session.start") {
      starts++
      if (index !== 0) throw new MigrateError("Copilot session contains multiple session.start events")
    }
    if (record.ephemeral === true) throw new MigrateError("Copilot persisted session contains an ephemeral event")
    if (record.agentId !== undefined && !str(record.agentId)) throw new MigrateError("Copilot event agentId is invalid")
    const id = str(record.id)
    if (!id || !isUUID4(id) || ids.has(id)) throw new MigrateError("Copilot event IDs must be unique UUIDv4 values")
    ids.add(id)
    if ((record.parentId ?? undefined) !== prior) throw new MigrateError("Copilot event parent chain is not linear")
    prior = id
    const timestamp = validRFC3339(record.timestamp)
    if (!timestamp) throw new MigrateError("Copilot event timestamp is invalid")
    const parsed = Date.parse(timestamp)
    if (parsed < last) throw new MigrateError("Copilot event timestamps are not ordered")
    last = parsed
    if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
      throw new MigrateError("Copilot event data must be an object")
    }
    validatePayload(type, obj(record.data))
  }
  if (starts !== 1) throw new MigrateError("Copilot session must contain one session.start event")
  validateReferences(records)
}

function validatePayload(type: string, data: Record<string, unknown>) {
  if (type === "user.message") {
    if (typeof data.content !== "string") throw new MigrateError("Copilot user message content is invalid")
    if (data.transformedContent !== undefined && typeof data.transformedContent !== "string") {
      throw new MigrateError("Copilot transformed user content is invalid")
    }
    const attachments = data.attachments ?? []
    if (!Array.isArray(attachments) || attachments.length > 10_000) {
      throw new MigrateError("Copilot attachments must be a bounded array")
    }
    for (const value of attachments) {
      const item = obj(value)
      if (!str(item.type)) throw new MigrateError("Copilot attachment is invalid")
      if (item.type === "blob") {
        if (str(item.data)) validateInline(item, "attachment")
        else if (!str(item.assetId) && !str(item.omittedReason)) {
          throw new MigrateError("Copilot blob attachment has no binary data")
        }
      }
    }
  } else if (type === "assistant.message") {
    if (typeof data.content !== "string" || !str(data.messageId)) {
      throw new MigrateError("Copilot assistant message is invalid")
    }
    for (const key of ["reasoningText", "reasoningOpaque", "encryptedContent"]) {
      if (data[key] !== undefined && typeof data[key] !== "string") {
        throw new MigrateError(`Copilot assistant ${key} is invalid`)
      }
    }
    const requests = data.toolRequests ?? []
    if (!Array.isArray(requests) || requests.length > 10_000) {
      throw new MigrateError("Copilot toolRequests must be a bounded array")
    }
    for (const value of requests) {
      const request = obj(value)
      if (!str(request.toolCallId) || !str(request.name)) {
        throw new MigrateError("Copilot tool request is missing linkage")
      }
      if (request.arguments !== undefined && (typeof request.arguments !== "object" || Array.isArray(request.arguments))) {
        throw new MigrateError("Copilot tool request arguments must be an object")
      }
    }
  } else if (type === "tool.execution_start") {
    if (!str(data.toolCallId) || !str(data.toolName)) throw new MigrateError("Copilot tool start is missing linkage")
    if (data.arguments !== undefined && (typeof data.arguments !== "object" || Array.isArray(data.arguments))) {
      throw new MigrateError("Copilot tool start arguments must be an object")
    }
  } else if (type === "tool.execution_complete") {
    if (!str(data.toolCallId) || typeof data.success !== "boolean") {
      throw new MigrateError("Copilot tool result is missing linkage")
    }
    if (data.success) {
      const result = obj(data.result)
      if (typeof result.content !== "string") throw new MigrateError("successful Copilot tool result has no content")
      const contents = result.contents ?? []
      if (!Array.isArray(contents) || contents.length > 10_000) {
        throw new MigrateError("Copilot tool contents must be a bounded array")
      }
      for (const value of contents) {
        const item = obj(value)
        if (!str(item.type)) throw new MigrateError("Copilot tool content is invalid")
        if (item.type === "image" || item.type === "audio") validateInline(item, "tool content")
      }
    } else {
      const error = obj(data.error)
      if (typeof error.message !== "string") throw new MigrateError("failed Copilot tool result has no error message")
    }
  } else if (type === "session.binary_asset") {
    validateAsset(data, true)
  } else if (type === "session.compaction_complete") {
    if (typeof data.success !== "boolean") throw new MigrateError("Copilot compaction status is invalid")
    if (data.summaryContent !== undefined && typeof data.summaryContent !== "string") {
      throw new MigrateError("Copilot compaction summary is invalid")
    }
  } else if (type === "session.model_change") {
    if (!str(data.newModel)) throw new MigrateError("Copilot model change is invalid")
  } else if (type === "session.title_changed") {
    if (!str(data.title)) throw new MigrateError("Copilot title change is invalid")
  } else if (type === "system.message") {
    if (typeof data.content !== "string" || (data.role !== "system" && data.role !== "developer")) {
      throw new MigrateError("Copilot system message is invalid")
    }
  }
}

function validateReferences(records: Record<string, unknown>[]) {
  const assets = new Map<string, Asset>()
  for (const record of records) {
    if (record.type !== "session.binary_asset") continue
    const data = obj(record.data)
    const id = validateAsset(data, true)
    if (assets.has(id)) throw new MigrateError("Copilot binary asset ID is duplicated")
    assets.set(id, [String(data.mimeType), String(data.data), Number(data.byteLength)])
  }
  for (const record of records) {
    const data = obj(record.data)
    const references: Record<string, unknown>[] = []
    if (record.type === "user.message") {
      references.push(...(Array.isArray(data.attachments) ? data.attachments.map(obj) : []))
    } else if (record.type === "tool.execution_complete") {
      const result = obj(data.result)
      const binary = result.binaryResultsForLlm ?? []
      if (!Array.isArray(binary) || binary.length > 10_000) {
        throw new MigrateError("Copilot binary results must be a bounded array")
      }
      for (const value of binary) {
        const item = obj(value)
        if (str(item.data)) validateInline(item, "tool binary result")
        else if (!str(item.assetId) && !str(item.omittedReason)) {
          throw new MigrateError("Copilot binary result has no data")
        }
      }
      references.push(...binary.map(obj))
    }
    for (const reference of references) {
      const id = str(reference.assetId)
      if (!id) continue
      const stored = assets.get(id)
      if (!stored) throw new MigrateError("Copilot binary reference has no matching asset")
      if (reference.mimeType !== undefined && reference.mimeType !== stored[0]) {
        throw new MigrateError("Copilot binary reference metadata does not match asset")
      }
      if (reference.byteLength !== undefined && reference.byteLength !== stored[2]) {
        throw new MigrateError("Copilot binary reference metadata does not match asset")
      }
    }
  }
}

function validateAsset(data: Record<string, unknown>, requireID: boolean): string {
  const id = str(data.assetId)
  const mime = str(data.mimeType)
  const encoded = str(data.data)
  const length = data.byteLength
  if ((requireID && !id) || !mime || !encoded || typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    throw new MigrateError("Copilot binary asset is invalid")
  }
  if (!validBase64(encoded)) throw new MigrateError("Copilot binary asset is not base64")
  const decoded = Buffer.from(encoded, "base64")
  const expected = `sha256:${new Bun.CryptoHasher("sha256").update(decoded).digest("hex")}`
  if (id !== expected || decoded.length !== length) {
    throw new MigrateError("Copilot binary asset integrity check failed")
  }
  return id!
}

function validateInline(value: Record<string, unknown>, description: string) {
  const encoded = str(value.data)
  const mime = str(value.mimeType)
  if (!encoded || !mime) throw new MigrateError(`Copilot ${description} is missing binary metadata`)
  if (!validBase64(encoded)) throw new MigrateError(`Copilot ${description} is not base64`)
  const decoded = Buffer.from(encoded, "base64")
  const length = value.byteLength
  if (length !== undefined && (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length !== decoded.length)) {
    throw new MigrateError(`Copilot ${description} byte length is invalid`)
  }
}

function validBase64(value: string) {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function inventory(records: Record<string, unknown>[]) {
  const assets = new Map<string, Asset>()
  for (const record of records) {
    if (record.type !== "session.binary_asset") continue
    const data = obj(record.data)
    const id = str(data.assetId)
    const mime = str(data.mimeType)
    const encoded = str(data.data)
    const length = data.byteLength
    if (id && mime && encoded && typeof length === "number") assets.set(id, [mime, encoded, length])
  }
  return assets
}

function attachmentImage(value: Record<string, unknown>, assets: Map<string, Asset>) {
  let data = str(value.data)
  let mime = str(value.mimeType)
  const id = str(value.assetId)
  if (id && assets.has(id)) {
    const stored = assets.get(id)!
    if (mime && mime !== stored[0]) return undefined
    mime = stored[0]
    data = stored[1]
  }
  if (!data || !mime) return undefined
  const url = `data:${mime};base64,${data}`
  return portableDataImage(url) ? url : undefined
}

function binaryImage(value: Record<string, unknown>, assets: Map<string, Asset>): [string | undefined, string | undefined] {
  if (value.type !== "image") return [undefined, undefined]
  const id = str(value.assetId)
  const url = attachmentImage(value, assets)
  return [url, url && id ? id : undefined]
}

function portableSourceResult(result: Record<string, unknown>, assets: Map<string, Asset>) {
  const blocks: Record<string, unknown>[] = []
  const used = new Set<string>()
  const omissions: string[] = []
  const seen = new Set<string>()
  const content = str(result.content)
  if (content) blocks.push({ type: "text", text: content })

  if (Array.isArray(result.binaryResultsForLlm)) {
    for (const value of result.binaryResultsForLlm) {
      const item = obj(value)
      const [url, id] = binaryImage(item, assets)
      if (url) {
        if (!seen.has(url)) {
          blocks.push({ type: "image", image_url: url })
          seen.add(url)
        }
        if (id) used.add(id)
      } else {
        omissions.push(str(item.omittedReason) ? "copilot_tool_binary_omitted" : "copilot_tool_binary_unsupported")
      }
    }
  }

  if (Array.isArray(result.contents)) {
    for (const value of result.contents) {
      const item = obj(value)
      const type = str(item.type)
      if (!content && (type === "text" || type === "terminal")) {
        const text = str(item.text)
        if (text) blocks.push({ type: "text", text })
        else omissions.push("copilot_tool_content_malformed")
      } else if (type === "image") {
        const [url] = binaryImage(item, assets)
        if (url && !seen.has(url)) {
          blocks.push({ type: "image", image_url: url })
          seen.add(url)
        } else if (!url) omissions.push("copilot_tool_image_malformed")
      } else if (type !== "text" && type !== "terminal") {
        omissions.push(`copilot_tool_content_${type ?? "unknown"}`)
      }
    }
  }
  for (const [key, reason] of [
    ["citableSources", "copilot_tool_citable_sources"],
    ["structuredContent", "copilot_tool_structured_content"],
    ["uiResource", "copilot_tool_ui_resource"],
  ] as const) {
    if (result[key] !== undefined) omissions.push(reason)
  }
  const detailed = str(result.detailedContent)
  if (detailed && detailed !== content) omissions.push("copilot_tool_detailed_content")
  return { blocks, used, omissions }
}

async function workspaceTitle(path: string) {
  const workspace = `${path.replace(/[\\/][^\\/]+$/, "")}/workspace.yaml`
  const file = Bun.file(workspace)
  if (!(await file.exists())) return undefined
  if (file.size > 64 * 1024) throw new MigrateError("Copilot workspace metadata exceeds the safety limit")
  const text = await file.text()
  for (const line of text.split("\n")) {
    const index = line.indexOf(":")
    if (index < 0) continue
    if (line.slice(0, index).trim() !== "name") continue
    let value = line.slice(index + 1).trim()
    if (value.startsWith('"')) {
      try {
        const parsed = JSON.parse(value)
        value = typeof parsed === "string" ? parsed : ""
      } catch {
        throw new MigrateError("Copilot workspace title is invalid")
      }
    }
    if (!value || value.length > 4096 || value.includes("\0")) {
      throw new MigrateError("Copilot workspace title is invalid")
    }
    return value
  }
  return undefined
}

function isUUID(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isUUID4(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
