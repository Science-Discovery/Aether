import { MigrateError } from "../error"
import type { Event, ParsedSession } from "../model"
import { loadJSONL } from "../read"
import { obj, requireUUID, str } from "../util"

export async function parse(path: string): Promise<ParsedSession> {
  const loaded = await loadJSONL(path)
  const records = loaded.records.map((record) => record.value)
  validate(records)
  const first = records[0]!
  const metadata = obj(obj(first.payload).record)
  const sessionID = String(obj(first.stream).id)
  const events: Event[] = []
  const pending = new Map<string, number>()

  for (const [index, record] of records.entries()) {
    if (retained(record)) {
      const omission = obj(record.omitted_record)
      events.push(opaque(index, record, `muse_retained_marker:${str(omission.omission_class) ?? "unknown"}`))
      continue
    }
    const type = String(record.payload_type)
    const payload = obj(record.payload)
    const timestamp = usTimestamp(record.recorded_at)
    const provenance = { recordIndex: index, recordType: type, sourceID: str(record.id) }
    if (type === "runtime.user_intent.accepted") {
      for (const value of Array.isArray(payload.model_messages) ? payload.model_messages : []) {
        const message = obj(value)
        for (const item of Array.isArray(message.content) ? message.content : []) {
          const content = obj(item)
          if (content.kind === "text" && str(content.text)) {
            const text = String(content.text)
            events.push({ kind: "message", role: "user", text, timestamp, payload: {}, provenance })
            pending.set(text, (pending.get(text) ?? 0) + 1)
          }
        }
      }
      continue
    }
    if (type === "runtime.session" && payload.kind === "run") {
      const run = obj(payload.event)
      if (!Object.keys(run).length) {
        events.push(opaque(index, record, "muse_malformed_run_event"))
        continue
      }
      const kind = run.kind
      if (kind === "started" && str(run.prompt)) {
        const prompt = String(run.prompt)
        const count = pending.get(prompt) ?? 0
        if (count > 0) pending.set(prompt, count - 1)
        else events.push({ kind: "message", role: "user", text: prompt, timestamp, payload: {}, provenance })
      } else if (kind === "assistant_message_committed" && str(run.text)) {
        events.push({ kind: "message", role: "assistant", text: String(run.text), timestamp, payload: {}, provenance })
      } else if (kind === "reasoning_committed") {
        events.push({
          kind: "thinking",
          role: "assistant",
          text: str(run.text),
          timestamp,
          payload: { reason: "muse_private_thinking" },
          provenance,
        })
      } else if (kind === "assistant_tool_calls_committed") {
        for (const value of Array.isArray(run.tool_calls) ? run.tool_calls : []) {
          const call = obj(value)
          let args: unknown = call.args ?? {}
          if (typeof args === "string") {
            try {
              args = JSON.parse(args)
            } catch {}
          }
          events.push({
            kind: "tool_call",
            role: "assistant",
            toolName: str(call.name),
            toolCallID: str(call.call_id) ?? str(call.id),
            timestamp,
            payload: { input: args },
            provenance,
          })
        }
      } else if (kind === "tool_result_batch_committed") {
        for (const value of Array.isArray(run.results) ? run.results : []) {
          const result = obj(value)
          const text = str(result.text)
          events.push({
            kind: "tool_result",
            role: "tool",
            text,
            toolCallID: str(result.tool_call_id),
            timestamp,
            payload: { content: text ?? "", content_blocks: text ? [{ type: "text", text }] : [] },
            provenance,
          })
        }
      } else if (kind !== "started" && kind !== "model_completed" && kind !== "terminal") {
        events.push(opaque(index, record, `muse_run:${kind ?? "unknown"}`))
      }
      continue
    }
    if (type !== "runtime.session.metadata" && type !== "session.opened.observed" && type !== "session.end") {
      events.push(opaque(index, record, `muse_native:${type}`))
    }
  }

  const build = obj(metadata.build)
  return {
    source: "muse",
    path,
    sha256: loaded.sha256,
    sessionID,
    cwd: str(metadata.workspace_root),
    startedAt: usTimestamp(first.recorded_at),
    cliVersion: str(build.semver),
    model: str(metadata.model_id),
    provider: str(metadata.provider_id),
    events,
    rawRecordCount: records.length,
  }
}

function validate(records: Record<string, unknown>[]) {
  if (!records.length) throw new MigrateError("Muse session is empty")
  let streamID: string | undefined
  const ids = new Set<string>()
  let history = false
  let previous = -1
  for (const [offset, record] of records.entries()) {
    const expected = offset + 1
    if (retained(record)) {
      const position = obj(record.position)
      if (position.sequence !== expected) throw new MigrateError("Muse retained-marker sequence is not contiguous")
      const id = requireUUID(position.id, "Muse retained-marker id")
      if (ids.has(id)) throw new MigrateError("Muse session contains a duplicate event id")
      ids.add(id)
      const current = requireUUID(obj(record.stream).id, "Muse stream id")
      streamID ??= current
      if (current !== streamID) throw new MigrateError("Muse event stream linkage is inconsistent")
      continue
    }
    if (record.record_type !== "event" || record.schema_version !== 1 || record.durability !== "durable") {
      throw new MigrateError("Muse event envelope is unsupported")
    }
    if (record.sequence !== expected) throw new MigrateError("Muse event sequence is not contiguous")
    const id = requireUUID(record.id, "Muse record id")
    if (ids.has(id)) throw new MigrateError("Muse session contains a duplicate event id")
    ids.add(id)
    const recorded = record.recorded_at
    if (typeof recorded !== "number" || !Number.isInteger(recorded) || recorded <= previous) {
      throw new MigrateError("Muse event timestamps are not strictly increasing")
    }
    previous = recorded
    const stream = obj(record.stream)
    if (stream.kind !== "session") throw new MigrateError("Muse event has invalid stream metadata")
    const current = requireUUID(stream.id, "Muse stream id")
    streamID ??= current
    if (current !== streamID) throw new MigrateError("Muse event stream linkage is inconsistent")
    if (!str(record.payload_type) || typeof record.payload_schema_version !== "number" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
      throw new MigrateError("Muse event payload metadata is malformed")
    }
    if (record.payload_type === "runtime.user_intent.accepted" || record.payload_type === "runtime.session") history = true
  }
  const first = records[0]!
  if (first.payload_type !== "runtime.session.metadata") {
    throw new MigrateError("Muse session does not begin with canonical metadata")
  }
  const payload = obj(first.payload)
  const metadata = payload.kind === "metadata" ? obj(payload.record) : {}
  if (!str(metadata.workspace_root)) throw new MigrateError("Muse session metadata is malformed")
  if (!history) throw new MigrateError("Muse session has no resumable conversation history")
  validateTurns(records)
}

function validateTurns(records: Record<string, unknown>[]) {
  const accepted = new Map<string, [string, number]>()
  const started = new Map<string, [string, string]>()
  for (const record of records) {
    if (retained(record)) continue
    const type = String(record.payload_type)
    const payload = obj(record.payload)
    if (type === "session.opened.observed") {
      const observed = obj(payload.record)
      if (observed.security_mode !== "normal" && observed.security_mode !== "approval_disabled" && observed.security_mode !== "sandbox_disabled" && observed.security_mode !== "yolo") {
        throw new MigrateError("Muse session has an invalid security mode")
      }
      continue
    }
    if (type === "runtime.user_intent.accepted") {
      const intent = requireUUID(payload.intent_id, "Muse user intent id")
      if (!Array.isArray(payload.model_messages) || !payload.model_messages.length || !Array.isArray(payload.refill_blocks) || !payload.refill_blocks.length) {
        throw new MigrateError("Muse user intent has no native prompt/refill content")
      }
      accepted.set(intent, [String(record.id), Number(record.sequence)])
      continue
    }
    if (type === "runtime.session" && payload.kind === "run") {
      const run = obj(payload.event)
      const runID = requireUUID(payload.run_id, "Muse run id")
      if (run.kind === "started") {
        started.set(runID, [String(record.id), requireUUID(payload.source_run_record_id, "Muse source run record id")])
      }
      continue
    }
    if (type !== "runtime.user_intent.materialized") continue
    const outcome = obj(payload.outcome)
    if (outcome.kind !== "top_level_turn_started") continue
    const intent = requireUUID(payload.intent_id, "Muse materialized intent id")
    const entry = accepted.get(intent)
    if (!entry || entry[0] !== payload.envelope_record_id || entry[1] !== payload.envelope_sequence) {
      throw new MigrateError("Muse materialized intent envelope linkage is invalid")
    }
    const runID = requireUUID(outcome.run_id, "Muse materialized run id")
    const run = started.get(runID)
    if (!run || run[0] !== outcome.run_started_session_record_id || run[1] !== outcome.run_started_source_record_id) {
      throw new MigrateError("Muse materialized run linkage is invalid")
    }
  }
}

function retained(record: Record<string, unknown>) {
  const position = obj(record.position)
  const stream = obj(record.stream)
  const omitted = obj(record.omitted_record)
  return (
    record.schema_version === 1 &&
    typeof record.retained_marker === "string" &&
    Object.keys(position).length === 2 &&
    Object.keys(position).every((key) => key === "id" || key === "sequence") &&
    typeof position.sequence === "number" &&
    stream.kind === "session" &&
    Object.keys(omitted).length > 0 &&
    omitted.record_type === "status" &&
    omitted.durability === "ephemeral" &&
    str(omitted.payload_type) !== undefined &&
    typeof omitted.payload_schema_version === "number" &&
    str(omitted.payload_kind) !== undefined &&
    str(omitted.omission_class) !== undefined
  )
}

function opaque(index: number, record: Record<string, unknown>, reason: string): Event {
  const position = obj(record.position)
  return {
    kind: "opaque",
    timestamp: usTimestamp(record.recorded_at),
    payload: { reason },
    provenance: {
      recordIndex: index,
      recordType: str(record.payload_type),
      sourceID: str(record.id) ?? str(position.id),
    },
  }
}

function usTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined
  return new Date(value / 1000).toISOString()
}
