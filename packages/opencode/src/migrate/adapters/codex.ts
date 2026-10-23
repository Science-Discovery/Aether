import { Database } from "bun:sqlite"
import { readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { MigrateError } from "../error"
import type { Event, ParsedSession, Role } from "../model"
import { loadJSONL } from "../read"
import type { JsonRecord } from "../read-types"
import { contentText, obj, str } from "../util"

const modes = new Set(["legacy", "paginated"])

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records
  const mode = historyMode(records)
  const projection = records.some((record) => {
    const payload = obj(record.value.payload)
    return (
      (payload.subagent_history_start_ordinal !== undefined && payload.subagent_history_start_ordinal !== null) ||
      (payload.history_base !== undefined && payload.history_base !== null)
    )
  })
  const canonicalUsers = records.some((record) => {
    if (str(record.value.type) !== "event_msg") return false
    const payload = obj(record.value.payload)
    return payload.type === "item_completed" && obj(payload.item).type === "UserMessage"
  })
  const providerUsers = mode === "paginated" && projection && !canonicalUsers
  if (mode === "paginated" && !projection) validatePaginated(records)

  const events: Event[] = []
  const fallback: Event[] = []
  const compacted: Event[] = []
  const messages = new Map<string, number>()
  let sessionID: string | undefined
  let cwd: string | undefined
  let startedAt: string | undefined
  let cliVersion: string | undefined
  let model: string | undefined
  let provider: string | undefined
  let title: string | undefined
  let parent: string | undefined
  let nickname: string | undefined
  let messageCount = 0

  for (const record of records) {
    const value = record.value
    const type = str(value.type)
    const timestamp = str(value.timestamp)
    const payload = obj(value.payload)
    const provenance = { recordIndex: record.index, recordType: type }
    if (type === "session_meta") {
      sessionID ??= str(payload.id) ?? str(payload.session_id)
      cwd ??= str(payload.cwd)
      startedAt ??= str(payload.timestamp) ?? timestamp
      cliVersion ??= str(payload.cli_version)
      provider ??= str(payload.model_provider)
      parent ??= str(payload.parent_thread_id) ?? str(payload.forked_from_id)
      nickname ??= str(payload.agent_nickname)
      if (payload.subagent_history_start_ordinal !== undefined && payload.subagent_history_start_ordinal !== null) {
        events.push({
          kind: "opaque",
          timestamp,
          payload: { reason: "codex_subagent_history_projection" },
          provenance,
        })
      }
      if (payload.history_base !== undefined && payload.history_base !== null) {
        events.push({
          kind: "opaque",
          timestamp,
          payload: { reason: "codex_history_base" },
          provenance,
        })
      }
      continue
    }
    if (type === "response_item") {
      const itemType = str(payload.type)
      const userProjection = providerUsers && itemType === "message" && payload.role === "user"
      const parsed =
        mode === "paginated" && (itemType === "message" || itemType === "agent_message") && !userProjection
          ? [
              {
                kind: "opaque" as const,
                timestamp,
                payload: { source_item_type: itemType ?? "<missing>", reason: "paginated_provider_message" },
                provenance,
              },
            ]
          : responseItem(payload, timestamp, provenance)
      events.push(...parsed)
      messageCount += parsed.filter((event) => event.kind === "message" && (event.role === "user" || event.role === "assistant")).length
      for (const event of parsed) {
        if (event.kind !== "message" || (event.role !== "user" && event.role !== "assistant") || !event.text) continue
        const key = fingerprint(event)
        messages.set(key, (messages.get(key) ?? 0) + 1)
      }
      continue
    }
    if (type === "event_msg") {
      const eventType = str(payload.type)
      if (eventType === "item_completed" && mode === "paginated") {
        events.push(...paginatedItem(payload, timestamp, provenance))
      } else if (eventType === "user_message" && mode === "legacy") {
        fallback.push({
          kind: "message",
          role: "user",
          text: str(payload.message),
          timestamp,
          provenance,
          payload: {},
        })
      } else if (eventType === "agent_message" && mode === "legacy") {
        fallback.push({
          kind: "message",
          role: "assistant",
          text: str(payload.message),
          timestamp,
          provenance,
          payload: {},
        })
      } else if (eventType === "task_started") {
        model ??= str(payload.model)
      } else if (eventType === "thread_name_updated") {
        title = str(payload.thread_name) ?? str(payload.name) ?? title
      } else if (eventType === "context_compacted") {
        compacted.push({
          kind: "opaque",
          timestamp,
          payload: { source_event_type: eventType },
          provenance,
        })
      } else if (eventType !== "user_message" && eventType !== "agent_message") {
        events.push({
          kind: "opaque",
          timestamp,
          payload: { source_event_type: eventType ?? "<missing>" },
          provenance,
        })
      }
      continue
    }
    if (type === "compacted") {
      if (payload.replacement_history !== undefined && payload.replacement_history !== null && !Array.isArray(payload.replacement_history)) {
        throw new MigrateError("Codex replacement_history must be an array")
      }
      events.push({
        kind: "compaction",
        role: "system",
        text: str(payload.message),
        timestamp,
        payload: payload.replacement_history !== undefined && payload.replacement_history !== null ? { replacement_history_expanded: true } : {},
        provenance,
      })
      continue
    }
    if (type === "turn_context") {
      model ??= str(payload.model)
      events.push({
        kind: "context",
        role: "system",
        timestamp,
        payload: { source_record_type: "turn_context" },
        provenance,
      })
      continue
    }
    if (type === "world_state" || type === "security_risk_score") {
      events.push({
        kind: "opaque",
        timestamp,
        payload: { source_record_type: type },
        provenance,
      })
      continue
    }
    events.push({
      kind: "opaque",
      timestamp,
      payload: { source_record_type: type ?? "<missing>" },
      provenance,
    })
  }

  if (mode === "paginated") {
    events.sort((a, b) => a.provenance.recordIndex - b.provenance.recordIndex)
  } else if (messageCount === 0) {
    events.push(...fallback.filter((event) => event.text))
    events.sort((a, b) => a.provenance.recordIndex - b.provenance.recordIndex)
  } else {
    for (const event of fallback) {
      const key = fingerprint(event)
      const count = messages.get(key) ?? 0
      if (event.text && count > 0) {
        messages.set(key, count - 1)
        continue
      }
      events.push({ ...event, payload: { ...event.payload, ui_only_projection: true } })
    }
    events.sort((a, b) => a.provenance.recordIndex - b.provenance.recordIndex)
  }
  const compactions = events.filter((event) => event.kind === "compaction").length
  events.push(...compacted.slice(compactions))
  events.sort((a, b) => a.provenance.recordIndex - b.provenance.recordIndex)

  title ??= threadTitle(path, sessionID, parent, nickname)
  const activity = parent && sessionID ? await parentActivity(path, sessionID, parent) : undefined

  return {
    source: "codex",
    path,
    sha256: loaded.sha256,
    sessionID,
    cwd,
    startedAt,
    cliVersion,
    model,
    provider,
    title,
    events,
    rawRecordCount: records.length,
    parentActivity: activity,
  }
}

export async function meta(path: string) {
  const info = await Bun.file(path)
    .stat()
    .catch(() => undefined)
  if (!info?.isFile()) return {}
  const text = await Bun.file(path)
    .slice(0, Math.min(info.size, 2 * 1024 * 1024))
    .text()
    .catch(() => "")
  let id: string | undefined
  let cwd: string | undefined
  let parent: string | undefined
  let nickname: string | undefined
  let title: string | undefined
  for (const line of text.split("\n")) {
    if (!line.includes("session_meta") && !line.includes("thread_name")) continue
    try {
      const value = JSON.parse(line)
      const payload = obj(value.payload)
      if (value.type === "session_meta") {
        id ??= str(payload.id) ?? str(payload.session_id)
        cwd ??= str(payload.cwd)
        parent ??= str(payload.parent_thread_id) ?? str(payload.forked_from_id)
        nickname ??= str(payload.agent_nickname)
      } else if (value.type === "event_msg" && payload.type === "thread_name_updated") {
        title = str(payload.thread_name) ?? str(payload.name) ?? title
      }
    } catch {}
  }
  return { title: title ?? threadTitle(path, id, parent, nickname), cwd, parentID: parent }
}

function threadTitle(path: string, id?: string, parent?: string, nickname?: string) {
  if (!id) return undefined
  const database = stateDatabase(path)
  if (!database) return undefined
  try {
    const db = new Database(database, { readonly: true })
    try {
      const own = db
        .query("select name, title from threads where id = ? limit 1")
        .get(id) as { name?: unknown; title?: unknown } | undefined
      const title = str(own?.name) ?? str(own?.title)
      if (title) return title
      if (!parent) return undefined
      const source = db
        .query("select name, title from threads where id = ? limit 1")
        .get(parent) as { name?: unknown; title?: unknown } | undefined
      const base = str(source?.name) ?? str(source?.title)
      if (!base) return undefined
      return nickname ? `${base} · ${nickname}` : `${base} · subagent`
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

async function parentActivity(path: string, child: string, parent: string) {
  const target = await parentRollout(path, parent)
  if (!target) return undefined
  const text = await Bun.file(target)
    .text()
    .catch(() => "")
  let first: { timestamp?: number; agent?: string; callID?: string } | undefined
  for (const line of text.split("\n")) {
    if (!line.includes("SubAgentActivity") || !line.includes(child)) continue
    try {
      const value = JSON.parse(line)
      if (value.type !== "event_msg") continue
      const payload = obj(value.payload)
      if (payload.type !== "item_completed") continue
      const item = obj(payload.item)
      if (item.type !== "SubAgentActivity" || item.agent_thread_id !== child) continue
      const agent = str(item.agent_path)
      const activity = {
        timestamp:
          typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp))
            ? Date.parse(value.timestamp)
            : undefined,
        agent: agent ? basename(agent) : undefined,
        callID: str(item.id),
      }
      if (item.kind === "started") return activity
      first ??= activity
    } catch {}
  }
  return first
}

async function parentRollout(path: string, parent: string) {
  const database = stateDatabase(path)
  if (database) {
    try {
      const db = new Database(database, { readonly: true })
      try {
        const row = db
          .query("select rollout_path from threads where id = ? limit 1")
          .get(parent) as { rollout_path?: unknown } | undefined
        const raw = str(row?.rollout_path)
        if (raw) {
          const root = dirname(database)
          for (const candidate of [raw, join(root, raw), join(root, "sessions", raw)]) {
            if (await Bun.file(candidate).exists()) return candidate
          }
        }
      } finally {
        db.close()
      }
    } catch {}
  }
  const directory = dirname(path)
  for (const name of safeNames(directory)) {
    if (name.includes(parent) && name.endsWith(".jsonl")) return join(directory, name)
  }
  const root = codexRoot(path)
  return findRollout(join(root, "sessions"), parent, 6) ?? findRollout(join(root, "archived_sessions"), parent, 2)
}

function findRollout(directory: string, parent: string, depth: number): string | undefined {
  if (depth < 0) return undefined
  const entries = safeEntries(directory)
  for (const entry of entries) {
    if (entry.isFile() && entry.name.includes(parent) && entry.name.endsWith(".jsonl")) {
      return join(directory, entry.name)
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const found = findRollout(join(directory, entry.name), parent, depth - 1)
    if (found) return found
  }
  return undefined
}

function codexRoot(path: string) {
  let directory = dirname(path)
  while (true) {
    const name = basename(directory)
    if (name === "sessions" || name === "archived_sessions") return dirname(directory)
    const next = dirname(directory)
    if (next === directory) return dirname(path)
    directory = next
  }
}

function safeNames(directory: string) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

function safeEntries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

function stateDatabase(path: string) {
  try {
    let dir = dirname(path)
    while (true) {
      const name = readdirSync(dir)
        .filter((value) => /^state.*\.sqlite$/.test(value))
        .at(-1)
      if (name) return join(dir, name)
      const next = dirname(dir)
      if (next === dir) return undefined
      dir = next
    }
  } catch {
    return undefined
  }
}

function historyMode(records: JsonRecord[]) {
  const meta = records.find((record) => str(record.value.type) === "session_meta")
  if (!meta) return "legacy"
  const payload = obj(meta.value.payload)
  const mode = str(payload.history_mode) ?? "legacy"
  if (!modes.has(mode)) {
    throw new MigrateError(`Codex history mode '${mode}' is not supported; expected legacy or paginated`)
  }
  if (mode === "paginated" && str(records[0]?.value.type) !== "session_meta") {
    throw new MigrateError("Codex paginated history must start with session metadata")
  }
  return mode
}

function validatePaginated(records: JsonRecord[]) {
  for (const [index, record] of records.entries()) {
    const ordinal = record.value.ordinal
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal)) {
      throw new MigrateError(`Codex paginated record ${record.index} is missing an integer ordinal`)
    }
    if (ordinal !== index) {
      throw new MigrateError(
        `Codex paginated ordinals must be contiguous from zero; record ${record.index} has ordinal ${ordinal}, expected ${index}`,
      )
    }
  }
}

function paginatedItem(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  provenance: Event["provenance"],
): Event[] {
  const item = obj(payload.item)
  const type = str(item.type)
  if (type === "UserMessage") {
    const content = item.content
    if (!Array.isArray(content)) return [opaqueItem(type, timestamp, provenance, "invalid_content")]
    return content.flatMap((value, index): Event[] => {
      const block = obj(value)
      const source = { ...provenance, blockIndex: index }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [opaqueItem(type, timestamp, source, "invalid_block")]
      }
      if (block.type === "text") {
        const text = str(block.text)
        return text ? [{ kind: "message", role: "user", text, timestamp, provenance: source, payload: {} }] : []
      }
      if (block.type === "image") {
        return [
          {
            kind: "context",
            role: "user",
            timestamp,
            payload: { block_type: "image", image_url: str(block.image_url) },
            provenance: source,
          },
        ]
      }
      if (block.type === "audio") {
        return [
          {
            kind: "context",
            role: "user",
            timestamp,
            payload: { block_type: "audio", audio_url: str(block.audio_url) },
            provenance: source,
          },
        ]
      }
      return [opaqueItem(type, timestamp, source, `unsupported_block:${str(block.type) ?? "<missing>"}`)]
    })
  }
  if (type === "AgentMessage") {
    const content = item.content
    if (!Array.isArray(content)) return [opaqueItem(type, timestamp, provenance, "invalid_content")]
    return content.flatMap((value, index): Event[] => {
      const block = obj(value)
      const source = { ...provenance, blockIndex: index }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [opaqueItem(type, timestamp, source, "invalid_block")]
      }
      if (block.type === "Text" || block.type === "text") {
        const text = str(block.text)
        return text ? [{ kind: "message", role: "assistant", text, timestamp, provenance: source, payload: {} }] : []
      }
      return [opaqueItem(type, timestamp, source, `unsupported_block:${str(block.type) ?? "<missing>"}`)]
    })
  }
  return [opaqueItem(type, timestamp, provenance)]
}

function opaqueItem(
  type: string | undefined,
  timestamp: string | undefined,
  provenance: Event["provenance"],
  reason?: string,
): Event {
  return {
    kind: "opaque",
    timestamp,
    payload: {
      source_event_type: "item_completed",
      source_item_type: type ?? "<missing>",
      ...(reason ? { reason } : {}),
    },
    provenance,
  }
}

function responseItem(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  provenance: Event["provenance"],
): Event[] {
  const type = str(payload.type)
  if (type === "message") {
    const role = messageRole(str(payload.role))
    if (!role) {
      return [{ kind: "opaque", timestamp, payload: { reason: "unknown_message_role" }, provenance }]
    }
    const content = payload.content
    if (!Array.isArray(content)) return []
    return content.flatMap((value, index): Event[] => {
      const block = obj(value)
      const source = { ...provenance, blockIndex: index }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [{ kind: "opaque", provenance: source, payload: {} }]
      }
      const blockType = str(block.type)
      if (blockType === "input_text" || blockType === "output_text" || blockType === "text") {
        const text = str(block.text)
        return text ? [{ kind: "message", role, text, timestamp, provenance: source, payload: {} }] : []
      }
      if (blockType === "input_image" || blockType === "image") {
        return [
          {
            kind: "context",
            role,
            timestamp,
            payload: { block_type: "image", image_url: str(block.image_url) ?? str(block.url) },
            provenance: source,
          },
        ]
      }
      return [
        {
          kind: "opaque",
          role,
          timestamp,
          payload: { source_block_type: blockType ?? "<missing>" },
          provenance: source,
        },
      ]
    })
  }
  if (type === "function_call" || type === "custom_tool_call") {
    let input: unknown = payload.arguments ?? payload.input ?? {}
    if (typeof input === "string") {
      try {
        input = JSON.parse(input)
      } catch {}
    }
    return [
      {
        kind: "tool_call",
        role: "assistant",
        timestamp,
        toolName: str(payload.name),
        toolCallID: str(payload.call_id) ?? str(payload.id),
        payload: { input, ...(str(payload.namespace) ? { namespace: payload.namespace } : {}) },
        provenance,
      },
    ]
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return [
      {
        kind: "tool_result",
        role: "tool",
        timestamp,
        text: contentText(payload.output),
        toolCallID: str(payload.call_id),
        payload: { content_blocks: portableResult(payload.output) },
        provenance,
      },
    ]
  }
  if (type === "reasoning") {
    return [
      {
        kind: "thinking",
        role: "assistant",
        timestamp,
        payload: { source_item_type: "reasoning" },
        provenance,
      },
    ]
  }
  if (type) {
    return [{ kind: "opaque", timestamp, payload: { source_item_type: type }, provenance }]
  }
  return []
}

function portableResult(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) return [{ type: "opaque" }]
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { type: "opaque" }
    const block = obj(item)
    const type = str(block.type)
    if (type === "input_text" || type === "text") {
      const text = str(block.text)
      return text ? { type: "text", text } : { type: "opaque" }
    }
    if (type === "input_image" || type === "image") {
      const url = str(block.image_url) ?? str(block.url)
      return url ? { type: "image", image_url: url } : { type: "opaque" }
    }
    if (type === "tool_reference") {
      const name = str(block.tool_name)
      return name ? { type: "tool_reference", tool_name: name } : { type: "opaque" }
    }
    if (type === "input_audio") return { type: "audio" }
    return { type: "opaque" }
  })
}

function messageRole(value: string | undefined): Role | undefined {
  if (value === "assistant") return "assistant"
  if (value === "user") return "user"
  if (value === "developer" || value === "system") return "system"
  return undefined
}

function fingerprint(event: Event) {
  return `${event.role ?? ""}:${(event.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()}`
}
