import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { MigrateError } from "../error"
import type { Event, ParsedSession, Role } from "../model"
import { checkBounds, loadJSON } from "../read"
import { contentText, obj, portableDataImage, requireUUID, str, truthy } from "../util"

const eventName = /^event-(\d{5})-([0-9a-f-]{36})\.json$/i
const maxEvents = 100_000

export async function parse(path: string): Promise<ParsedSession> {
  const { conversation, events } = sourcePaths(path)
  const entries = eventFiles(events)
  const base = baseState(conversation)
  const eventsList = entries.map((entry, index) => parseEvent(entry.value, index))
  const first = entries[0]?.value
  const state = base.value
  const metadata = stateMetadata(state, basename(conversation))
  const sha = new Bun.CryptoHasher("sha256")
  for (const entry of entries) {
    sha.update(entry.name).update("\0").update(JSON.stringify(entry.value)).update("\0")
  }
  if (base.text !== undefined) sha.update("base_state.json\0").update(base.text).update("\0")

  return {
    source: "openhands",
    path: conversation,
    sha256: sha.digest("hex"),
    sessionID: requireUUID(basename(conversation), "OpenHands conversation directory"),
    cwd: metadata.cwd,
    startedAt: portableTimestamp(first?.timestamp),
    cliVersion: "1.16.0",
    model: metadata.model,
    provider: metadata.model?.includes("/") ? metadata.model.split("/", 1)[0] : undefined,
    title: pickerTitle(entries.map((entry) => entry.value)),
    events: eventsList.flat(),
    rawRecordCount: entries.length,
  }
}

function sourcePaths(path: string) {
  const info = statSync(path)
  if (info.isFile() && eventName.test(basename(path))) {
    const events = dirname(path)
    return { conversation: dirname(events), events }
  }
  if (info.isDirectory() && basename(path) === "events") {
    return { conversation: dirname(path), events: path }
  }
  if (info.isDirectory() && statSync(join(path, "events")).isDirectory()) {
    return { conversation: path, events: join(path, "events") }
  }
  throw new MigrateError("OpenHands source must be a conversation directory containing an events directory")
}

type Entry = { name: string; value: Record<string, unknown> }

function eventFiles(path: string): Entry[] {
  const names = readdirSync(path).filter((name) => eventName.test(name)).sort()
  if (!names.length || names.length > maxEvents) {
    throw new MigrateError("OpenHands event log is empty or exceeds the record limit")
  }
  const entries: Entry[] = []
  let total = 0
  for (const [expected, name] of names.entries()) {
    const match = eventName.exec(name)
    if (!match || Number(match[1]) !== expected) {
      throw new MigrateError("OpenHands event filenames are invalid or non-contiguous")
    }
    const file = join(path, name)
    const info = statSync(file)
    if (!info.isFile()) throw new MigrateError("OpenHands event is not a regular file")
    total += info.size
    if (total > 256 * 1024 * 1024) throw new MigrateError("OpenHands event log exceeds the input safety limit")
    let value: unknown
    try {
      value = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      throw new MigrateError("OpenHands event is not valid UTF-8 JSON")
    }
    checkBounds(value)
    if (!value || typeof value !== "object" || Array.isArray(value) || obj(value).id !== match[2]) {
      throw new MigrateError("OpenHands event filename and metadata disagree")
    }
    validateEvent(obj(value), expected)
    entries.push({ name, value: obj(value) })
  }
  if (entries[0]?.value.kind !== "SystemPromptEvent") {
    throw new MigrateError("OpenHands event log must start with a system event")
  }
  validateSequence(entries.map((entry) => entry.value))
  return entries
}

function baseState(conversation: string) {
  const path = join(conversation, "base_state.json")
  try {
    const info = statSync(path)
    if (!info.isFile()) throw new MigrateError("OpenHands base state is not a regular file")
    if (info.size > 64 * 1024 * 1024) throw new MigrateError("OpenHands base state exceeds the input safety limit")
    const text = readFileSync(path, "utf8")
    const value = JSON.parse(text)
    checkBounds(value)
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new MigrateError("OpenHands base state is not a JSON object")
    }
    return { value: obj(value), text }
  } catch (error) {
    if (error instanceof MigrateError) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: undefined, text: undefined }
    throw new MigrateError("OpenHands base state is not valid bounded UTF-8 JSON")
  }
}

function stateMetadata(value: Record<string, unknown> | undefined, name: string) {
  if (!value) return { model: undefined, cwd: undefined }
  const id = requireUUID(value.id, "OpenHands base state id")
  if (id !== requireUUID(name, "OpenHands conversation directory")) {
    throw new MigrateError("OpenHands base state and conversation directory disagree")
  }
  const llm = obj(obj(value.agent).llm)
  const workspace = obj(value.workspace)
  const model = str(llm.model)
  const cwd = str(workspace.working_dir) ?? str(workspace.cwd)
  if ((model && model.includes("\0")) || (cwd && cwd.includes("\0"))) {
    throw new MigrateError("OpenHands base state metadata is invalid")
  }
  return { model, cwd }
}

function parseEvent(value: Record<string, unknown>, index: number): Event[] {
  const kind = String(value.kind)
  const timestamp = portableTimestamp(value.timestamp)
  const provenance = { recordIndex: index, recordType: `openhands.${kind}`, sourceID: str(value.id) }
  if (kind === "SystemPromptEvent") {
    return [{ kind: "opaque", role: "system", timestamp, payload: { reason: "openhands_system_prompt" }, provenance }]
  }
  if (kind === "MessageEvent") {
    const message = obj(value.llm_message)
    const role: Role = message.role === "user" ? "user" : "assistant"
    const events = contentEvents(message.content, role, timestamp, provenance)
    if (truthy(message.thinking_blocks)) {
      events.push({ kind: "opaque", role: "assistant", timestamp, payload: { reason: "openhands_private_thinking" }, provenance })
    }
    if (truthy(value.activated_skills) || truthy(value.extended_content)) {
      events.push({ kind: "opaque", role, timestamp, payload: { reason: "openhands_message_runtime_metadata" }, provenance })
    }
    return events
  }
  if (kind === "ActionEvent") {
    const events: Event[] = []
    if (truthy(value.thought) || truthy(value.thinking_blocks)) {
      events.push({ kind: "opaque", role: "assistant", timestamp, payload: { reason: "openhands_private_thinking" }, provenance })
    }
    const call = obj(value.tool_call)
    let input: unknown = value.action ?? {}
    if (typeof call.arguments === "string") {
      try {
        input = JSON.parse(call.arguments)
      } catch {
        input = { input: call.arguments }
      }
    }
    events.push({
      kind: "tool_call",
      role: "assistant",
      toolName: str(value.tool_name),
      toolCallID: str(value.tool_call_id),
      timestamp,
      payload: { input },
      provenance,
    })
    return events
  }
  if (kind === "ObservationEvent") {
    const observation = obj(value.observation)
    return [
      {
        kind: "tool_result",
        role: "tool",
        text: contentText(observation.content),
        toolName: str(value.tool_name),
        toolCallID: str(value.tool_call_id),
        timestamp,
        payload: { content_blocks: resultBlocks(observation.content), is_error: observation.is_error === true },
        provenance,
      },
    ]
  }
  if (kind === "Condensation") {
    return [
      {
        kind: "compaction",
        role: "system",
        text: str(value.summary),
        timestamp,
        payload: { source_subtype: "openhands_condensation" },
        provenance,
      },
    ]
  }
  return [{ kind: "opaque", timestamp, payload: { reason: `openhands_${kind}` }, provenance }]
}

function validateEvent(value: Record<string, unknown>, index: number) {
  requireUUID(value.id, `OpenHands event ${index} id`)
  if (!nativeTimestamp(value.timestamp)) throw new MigrateError(`OpenHands event ${index} has an invalid timestamp`)
  const kind = str(value.kind)
  const source = str(value.source)
  if (!kind || (source !== "agent" && source !== "user" && source !== "environment")) {
    throw new MigrateError(`OpenHands event ${index} has invalid metadata`)
  }
  if (kind === "SystemPromptEvent") {
    if (source !== "agent" || !textContent(value.system_prompt)) throw new MigrateError("OpenHands system event is malformed")
  } else if (kind === "MessageEvent") {
    const message = obj(value.llm_message)
    if (message.role !== "user" && message.role !== "assistant") throw new MigrateError("OpenHands message event is malformed")
    validateContent(message.content)
  } else if (kind === "ActionEvent") {
    if (!str(value.tool_name) || !str(value.tool_call_id)) throw new MigrateError("OpenHands action event is malformed")
    requireUUID(value.llm_response_id, "OpenHands action response id")
    if (!value.action || typeof value.action !== "object" || Array.isArray(value.action) || !value.tool_call || typeof value.tool_call !== "object" || Array.isArray(value.tool_call)) {
      throw new MigrateError("OpenHands action event is malformed")
    }
  } else if (kind === "ObservationEvent") {
    if (!str(value.tool_name) || !str(value.tool_call_id)) throw new MigrateError("OpenHands observation event is malformed")
    const observation = obj(value.observation)
    if (typeof observation.is_error !== "boolean") throw new MigrateError("OpenHands observation event is malformed")
    validateContent(observation.content)
  } else if (kind === "Condensation") {
    if (!str(value.summary) || !Array.isArray(value.forgotten_event_ids)) throw new MigrateError("OpenHands condensation event is malformed")
    requireUUID(value.llm_response_id, "OpenHands condensation response id")
  }
}

function validateSequence(events: Record<string, unknown>[]) {
  const ids = new Set<string>()
  const actions = new Map<string, [string, string]>()
  const observed = new Set<string>()
  for (const [index, event] of events.entries()) {
    const id = String(event.id)
    if (ids.has(id)) throw new MigrateError(`OpenHands event ${index} has a duplicate id`)
    ids.add(id)
    if (event.kind === "ActionEvent") {
      actions.set(id, [String(event.tool_call_id), String(event.tool_name)])
    } else if (event.kind === "ObservationEvent") {
      const actionID = String(event.action_id)
      const action = actions.get(actionID)
      if (!action) throw new MigrateError(`OpenHands observation event ${index} has invalid action linkage`)
      if (observed.has(actionID)) throw new MigrateError(`OpenHands observation event ${index} duplicates an action result`)
      if (action[0] !== String(event.tool_call_id) || action[1] !== String(event.tool_name)) {
        throw new MigrateError(`OpenHands observation event ${index} disagrees with its action`)
      }
      observed.add(actionID)
    }
  }
}

function validateContent(content: unknown) {
  if (!Array.isArray(content) || !content.length) throw new MigrateError("OpenHands content is empty or malformed")
  for (const value of content) {
    const block = obj(value)
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new MigrateError("OpenHands text block is malformed")
    } else if (block.type === "image") {
      if (!Array.isArray(block.image_urls) || !block.image_urls.length || block.image_urls.some((url) => !portableDataImage(url))) {
        throw new MigrateError("OpenHands image block is malformed")
      }
    } else {
      throw new MigrateError("OpenHands content block type is unsupported")
    }
  }
}

function contentEvents(content: unknown, role: Role, timestamp: string | undefined, provenance: Event["provenance"]): Event[] {
  const events: Event[] = []
  for (const [blockIndex, value] of (Array.isArray(content) ? content : []).entries()) {
    const block = obj(value)
    const source = { ...provenance, blockIndex }
    if (block.type === "text" && str(block.text)) {
      events.push({ kind: "message", role, text: String(block.text), timestamp, payload: {}, provenance: source })
    } else if (block.type === "image") {
      for (const url of Array.isArray(block.image_urls) ? block.image_urls : []) {
        events.push({ kind: "context", role, timestamp, payload: { block_type: "image", image_url: url }, provenance: source })
      }
    }
  }
  return events
}

function resultBlocks(content: unknown) {
  const blocks: Record<string, unknown>[] = []
  for (const value of Array.isArray(content) ? content : []) {
    const block = obj(value)
    if (block.type === "text") blocks.push({ type: "text", text: block.text ?? "" })
    else if (block.type === "image") {
      for (const url of Array.isArray(block.image_urls) ? block.image_urls : []) {
        blocks.push({ type: "image", image_url: url })
      }
    }
  }
  return blocks
}

function textContent(value: unknown) {
  const block = obj(value)
  return block.type === "text" ? str(block.text) : undefined
}

function pickerTitle(events: Record<string, unknown>[]) {
  for (const event of events) {
    if (event.kind !== "MessageEvent" || event.source !== "user") continue
    const content = obj(event.llm_message).content
    const first = Array.isArray(content) ? content[0] : undefined
    const block = obj(first)
    if (block.type === "text" && str(block.text)) return String(block.text)
  }
  return undefined
}

function portableTimestamp(value: unknown) {
  const text = str(value)
  if (!text) return undefined
  const parsed = Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function nativeTimestamp(value: unknown) {
  return portableTimestamp(value) !== undefined
}
