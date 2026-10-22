import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Process } from "@/util/process"
import { which } from "@/util/which"
import { MigrateError } from "../error"
import type { Event, ParsedSession, SourceFormat } from "../model"
import { loadJSON } from "../read"
import { fromMillis, list as array, obj, portableDataImage, str, truthy } from "../util"

export const pinned = { opencode: "1.17.20", kilo: "7.5.0" } as const

const images = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const partTypes = new Set([
  "text",
  "reasoning",
  "file",
  "tool",
  "compaction",
  "snapshot",
  "patch",
  "step-start",
  "step-finish",
  "agent",
  "subtask",
  "retry",
])

export type CliOptions = {
  cli?: string
  env?: NodeJS.ProcessEnv
}

export async function parse(path: string, source: "opencode" | "kilo" = "opencode"): Promise<ParsedSession> {
  const loaded = await loadJSON(path)
  const value = obj(loaded.value)
  validate(value)
  const info = obj(value.info)
  const messages = array(value.messages)
  const sessionID = String(info.id)
  const cwd = String(info.directory)
  const title = String(info.title)
  const time = obj(info.time)
  const created = fromMillis(Number(time.created))
  const events: Event[] = []
  let partCount = 0
  let model: string | undefined
  let provider: string | undefined

  for (const [reason, metadata] of [
    ["opencode_parent_session", info.parentID],
    ["opencode_session_summary", info.summary],
    ["opencode_session_revert", info.revert],
    ["opencode_session_share", info.share],
    ["opencode_session_permission", info.permission],
    ["opencode_session_metadata", info.metadata],
  ] as const) {
    if (truthy(metadata)) {
      events.push({
        kind: "opaque",
        timestamp: created,
        payload: { reason },
        provenance: { recordIndex: 0, recordType: "session" },
      })
    }
  }

  const compactions = new Map<string, Record<string, unknown>>()
  const summaries = new Set<string>()
  for (const value of messages) {
    const message = obj(value)
    const messageInfo = obj(message.info)
    const id = str(messageInfo.id) ?? ""
    const parts = array(message.parts).map(obj)
    const compaction = parts.find((part) => part.type === "compaction")
    if (compaction) compactions.set(id, compaction)
    if (messageInfo.role === "assistant" && messageInfo.summary === true) {
      const parent = str(messageInfo.parentID)
      if (parent) summaries.add(parent)
    }
  }

  for (const [messageIndex, value] of messages.entries()) {
    const message = obj(value)
    const messageInfo = obj(message.info)
    const parts = array(message.parts).map(obj)
    const role = str(messageInfo.role)
    const timestamp = fromMillis(Number(obj(messageInfo.time).created))
    const summary = messageInfo.summary === true
    if (role === "user") {
      const messageModel = obj(messageInfo.model)
      model = str(messageModel.modelID) ?? model
      provider = str(messageModel.providerID) ?? provider
      const system = str(messageInfo.system)
      if (system) {
        events.push({
          kind: "message",
          role: "system",
          text: system,
          timestamp,
          payload: { source_subtype: "opencode_user_system" },
          provenance: { recordIndex: messageIndex, recordType: role },
        })
      }
      for (const [field, reason] of [
        ["summary", "opencode_user_summary_metadata"],
        ["format", "opencode_user_output_format"],
        ["tools", "opencode_user_tool_policy"],
      ] as const) {
        if (messageInfo[field] !== undefined && messageInfo[field] !== null) {
          events.push(opaque(messageIndex, role, timestamp, reason))
        }
      }
    } else {
      model = str(messageInfo.modelID) ?? model
      provider = str(messageInfo.providerID) ?? provider
      if (messageInfo.error !== undefined && messageInfo.error !== null) {
        events.push(opaque(messageIndex, role, timestamp, "opencode_assistant_error"))
      }
    }

    if (summary) {
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => str(part.text) ?? "")
        .join("\n")
        .trim()
      const parent = str(messageInfo.parentID) ?? ""
      const trigger = compactions.get(parent)
      if (text) {
        events.push({
          kind: "compaction",
          role: "system",
          text,
          timestamp,
          payload: {
            source_subtype: "opencode_compaction_summary",
            has_boundary_metadata: !!trigger && (trigger.tail_start_id !== undefined || trigger.overflow !== undefined),
          },
          provenance: { recordIndex: messageIndex, recordType: role },
        })
      } else {
        events.push(opaque(messageIndex, role, timestamp, "opencode_empty_compaction_summary"))
      }
    }

    for (const [partIndex, part] of parts.entries()) {
      partCount++
      const provenance = { recordIndex: messageIndex, recordType: role, blockIndex: partIndex }
      const type = str(part.type)
      if (type === "text") {
        if (summary) continue
        const text = str(part.text)
        if (part.ignored === true) {
          events.push({ kind: "opaque", role: role === "user" ? "user" : "assistant", timestamp, payload: { reason: "opencode_ignored_text" }, provenance })
        } else if (text) {
          events.push({
            kind: "message",
            role: role === "user" ? "user" : "assistant",
            text,
            timestamp,
            payload: { synthetic: part.synthetic === true },
            provenance,
          })
        } else {
          events.push({ kind: "opaque", role: role === "user" ? "user" : "assistant", timestamp, payload: { reason: "opencode_empty_text" }, provenance })
        }
        continue
      }
      if (type === "file") {
        const url = portableFileURL(part)
        if (role === "user" && url) {
          events.push({
            kind: "context",
            role: "user",
            timestamp,
            payload: { block_type: "image", image_url: url, mime_type: str(part.mime) },
            provenance,
          })
        } else {
          events.push(opaquePart(provenance, role, timestamp, "opencode_nonportable_file"))
        }
        if (part.source !== undefined) {
          events.push(opaquePart(provenance, role, timestamp, "opencode_file_source_metadata"))
        }
        continue
      }
      if (type === "tool" && role === "assistant") {
        events.push(...toolEvents(part, timestamp, provenance))
        continue
      }
      if (type === "reasoning" && role === "assistant") {
        events.push({
          kind: "thinking",
          role: "assistant",
          text: str(part.text),
          timestamp,
          provenance,
          payload: {},
        })
        continue
      }
      if (type === "compaction" && role === "user") {
        if (!summaries.has(String(messageInfo.id))) {
          events.push(opaquePart(provenance, role, timestamp, "opencode_unpaired_compaction"))
        }
        continue
      }
      events.push(opaquePart(provenance, role, timestamp, `opencode_${type ?? "unknown"}_part`))
    }
  }

  return {
    source,
    path,
    sha256: loaded.sha256,
    sessionID,
    cwd,
    startedAt: created,
    cliVersion: str(info.version),
    model: model ?? sessionModel(info, "id"),
    provider: provider ?? sessionModel(info, "providerID"),
    title,
    events,
    rawRecordCount: 1 + messages.length + partCount,
  }
}

export async function list(source: "opencode" | "kilo", options: CliOptions = {}) {
  const cli = resolve(source, options)
  const output = await run(cli, ["session", "list", "--format", "json", "--pure"], options, source)
  if (output.length > 64 * 1024 * 1024) throw new MigrateError(`${label(source)} session list exceeded the safety limit`)
  const text = output.toString().trim()
  if (!text) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new MigrateError(`${label(source)} session list did not return valid JSON`)
  }
  if (!Array.isArray(value)) throw new MigrateError(`${label(source)} session list returned an unexpected shape`)
  return value.map((item) => {
    const entry = obj(item)
    const id = str(entry.id)
    if (!id) throw new MigrateError(`${label(source)} session list contains invalid metadata`)
    const time = obj(entry.time)
    return {
      source,
      id,
      path: `${source}:${id}`,
      title: str(entry.title),
      updated: typeof time.updated === "number" ? time.updated : undefined,
    }
  })
}

export async function exportSession(id: string, source: "opencode" | "kilo", options: CliOptions = {}) {
  const cli = resolve(source, options)
  const directory = mkdtempSync(join(tmpdir(), "aether-migrate-"))
  const path = join(directory, "bundle.json")
  try {
    const output = await run(cli, ["export", id, "--pure"], options, source)
    if (output.length > 256 * 1024 * 1024) throw new MigrateError(`${label(source)} export exceeded the safety limit`)
    writeFileSync(path, output, { mode: 0o600 })
    return { ...(await parse(path, source)), path: `${source}:${id}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function resolve(source: "opencode" | "kilo", options: CliOptions) {
  const env = options.env ?? process.env
  const name = source === "opencode" ? "opencode" : "kilo"
  const home = process.platform === "win32" ? env.USERPROFILE ?? homedir() : env.HOME ?? homedir()
  const fallback = source === "opencode" ? ".opencode/bin/opencode" : ".kilo/bin/kilo"
  const candidates = [
    options.cli,
    env[source === "opencode" ? "OPENCODE_BIN" : "KILO_BIN"],
    which(name, env) ?? undefined,
    ...(process.platform === "win32" ? [join(home, `${fallback}.exe`)] : []),
    join(home, fallback),
  ].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  throw new MigrateError(
    `${label(source)} CLI was not found; pass --source-cli, set ${source === "opencode" ? "OPENCODE_BIN" : "KILO_BIN"}, or add ${name} to PATH`,
  )
}

async function run(cli: string, args: string[], options: CliOptions, source: "opencode" | "kilo") {
  const proc = await Process.run([cli, ...args], {
    env: options.env,
    nothrow: true,
  })
  if (proc.code !== 0) {
    const error = proc.stderr.toString().trim()
    throw new MigrateError(`${label(source)} command failed: ${error || `exit ${proc.code}`}`)
  }
  return proc.stdout
}

function label(source: SourceFormat) {
  return source === "kilo" ? "Kilo" : "OpenCode"
}

function validate(value: Record<string, unknown>) {
  const info = obj(value.info)
  if (!Object.keys(info).length) throw new MigrateError("OpenCode import bundle is missing session info")
  const sessionID = str(info.id)
  const cwd = str(info.directory)
  const title = str(info.title)
  const version = str(info.version)
  const time = obj(info.time)
  const messages = array(value.messages)
  if (!sessionID || !sessionID.startsWith("ses_") || !cwd || cwd.includes("\0") || !title) {
    throw new MigrateError("OpenCode import bundle has invalid required metadata")
  }
  if (!str(info.slug) || !str(info.projectID) || !version) {
    throw new MigrateError("OpenCode import bundle has invalid required metadata")
  }
  if (typeof time.created !== "number" || !Number.isInteger(time.created) || time.created < 0) {
    throw new MigrateError("OpenCode import bundle has an invalid creation time")
  }
  if (typeof time.updated !== "number" || !Number.isInteger(time.updated) || time.updated < Number(time.created)) {
    throw new MigrateError("OpenCode import bundle has an invalid update time")
  }
  if (!messages.length) throw new MigrateError("OpenCode import bundle has no conversation history")
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()
  let resumable = false
  for (const value of messages) {
    const message = obj(value)
    const messageInfo = obj(message.info)
    const id = str(messageInfo.id)
    const role = str(messageInfo.role)
    if (!id || !id.startsWith("msg_") || messageIDs.has(id) || messageInfo.sessionID !== sessionID || (role !== "user" && role !== "assistant")) {
      throw new MigrateError("OpenCode import bundle has invalid message metadata")
    }
    messageIDs.add(id)
    const created = obj(messageInfo.time).created
    if (typeof created !== "number" || !Number.isInteger(created) || created < 0) {
      throw new MigrateError("OpenCode message has an invalid timestamp")
    }
    if (role === "assistant" && !str(messageInfo.parentID)) {
      throw new MigrateError("OpenCode assistant message is missing its parent ID")
    }
    const parts = message.parts
    if (!Array.isArray(parts)) throw new MigrateError("OpenCode import bundle message is missing parts")
    for (const value of parts) {
      const part = obj(value)
      const partID = str(part.id)
      const type = str(part.type)
      if (!partID || !partID.startsWith("prt_") || partIDs.has(partID) || part.sessionID !== sessionID || part.messageID !== id || !type) {
        throw new MigrateError("OpenCode import bundle has invalid part metadata")
      }
      if (!partTypes.has(type)) throw new MigrateError(`OpenCode import bundle has unsupported part type: ${type}`)
      partIDs.add(partID)
      validatePart(part, type)
      if (type === "text" || type === "file" || type === "tool" || type === "compaction") resumable = true
    }
  }
  if (!resumable) throw new MigrateError("OpenCode import bundle has no resumable conversation context")
}

function validatePart(part: Record<string, unknown>, type: string) {
  if (part.metadata !== undefined && (typeof part.metadata !== "object" || Array.isArray(part.metadata))) {
    throw new MigrateError(`OpenCode import bundle has invalid ${type} part metadata`)
  }
  if (type === "text") {
    if (typeof part.text !== "string") throw new MigrateError("OpenCode text part is invalid")
    return
  }
  if (type === "reasoning") {
    if (typeof part.text !== "string" || typeof obj(part.time).start !== "number") {
      throw new MigrateError("OpenCode reasoning part is invalid")
    }
    return
  }
  if (type === "file") {
    if (!str(part.mime) || !str(part.url)) throw new MigrateError("OpenCode file part is invalid")
    return
  }
  if (type === "tool") {
    if (!str(part.callID) || !str(part.tool)) throw new MigrateError("OpenCode tool part is invalid")
    const state = obj(part.state)
    const status = str(state.status)
    if (!state.input || typeof state.input !== "object" || Array.isArray(state.input)) {
      throw new MigrateError("OpenCode tool part is invalid")
    }
    if (status === "pending") {
      if (typeof state.raw !== "string") throw new MigrateError("OpenCode tool part is invalid")
      return
    }
    if (status === "running") return
    if (status === "completed") {
      if (typeof state.output !== "string" || typeof state.title !== "string" || !state.metadata) {
        throw new MigrateError("OpenCode tool part is invalid")
      }
      return
    }
    if (status === "error") {
      if (typeof state.error !== "string") throw new MigrateError("OpenCode tool part is invalid")
      return
    }
    throw new MigrateError("OpenCode tool part is invalid")
  }
  if (type === "compaction") {
    if (typeof part.auto !== "boolean") throw new MigrateError("OpenCode compaction part is invalid")
    return
  }
  if (type === "snapshot") {
    if (typeof part.snapshot !== "string") throw new MigrateError("OpenCode snapshot part is invalid")
    return
  }
  if (type === "patch") {
    if (typeof part.hash !== "string" || !Array.isArray(part.files)) throw new MigrateError("OpenCode patch part is invalid")
    return
  }
  if (type === "agent") {
    if (!str(part.name)) throw new MigrateError("OpenCode agent part is invalid")
    return
  }
  if (type === "subtask") {
    if (!str(part.prompt) || !str(part.description) || !str(part.agent)) {
      throw new MigrateError("OpenCode subtask part is invalid")
    }
    return
  }
  if (type === "retry") {
    if (typeof part.attempt !== "number" || !part.error || typeof part.error !== "object" || typeof obj(part.time).created !== "number") {
      throw new MigrateError("OpenCode retry part is invalid")
    }
    return
  }
  if (type === "step-start") return
  if (type === "step-finish") {
    if (typeof part.reason !== "string" || typeof part.cost !== "number" || !part.tokens) {
      throw new MigrateError("OpenCode step-finish part is invalid")
    }
    return
  }
}

function toolEvents(part: Record<string, unknown>, timestamp: string, provenance: Event["provenance"]): Event[] {
  const callID = str(part.callID)
  const name = str(part.tool)
  const state = obj(part.state)
  const result: Event[] = [
    {
      kind: "tool_call",
      role: "assistant",
      timestamp,
      toolName: name,
      toolCallID: callID,
      payload: { input: state.input ?? {} },
      provenance,
    },
  ]
  const status = str(state.status)
  if (status !== "completed" && status !== "error") {
    result.push(opaquePart(provenance, "assistant", timestamp, `opencode_tool_${status ?? "unknown"}`))
    return result
  }
  const blocks: Record<string, unknown>[] = []
  let text: string | undefined
  if (status === "completed") {
    const output = str(state.output)
    if (output) {
      blocks.push({ type: "text", text: output })
      text = output
    }
    for (const value of Array.isArray(state.attachments) ? state.attachments : []) {
      const attachment = obj(value)
      const url = portableFileURL(attachment)
      if (url) blocks.push({ type: "image", image_url: url })
      else result.push(opaquePart(provenance, "assistant", timestamp, "opencode_tool_attachment_non_image"))
    }
  } else {
    text = str(state.error)
    if (text) blocks.push({ type: "text", text })
  }
  result.push({
    kind: "tool_result",
    role: "tool",
    text,
    timestamp,
    toolName: name,
    toolCallID: callID,
    payload: { is_error: status === "error", content_blocks: blocks },
    provenance,
  })
  if (part.metadata !== undefined || state.metadata !== undefined) {
    result.push(opaquePart(provenance, "assistant", timestamp, "opencode_tool_metadata"))
  }
  if (status === "completed" && obj(state.time).compacted !== undefined) {
    result.push(opaquePart(provenance, "assistant", timestamp, "opencode_tool_result_compacted"))
  }
  return result
}

function portableFileURL(part: Record<string, unknown>) {
  const mime = str(part.mime)
  const url = str(part.url)
  if (!mime || !url || !images.has(mime)) return undefined
  if (url.startsWith("https://") || url.startsWith("http://")) return url
  const image = portableDataImage(url)
  return image && image[0] === mime ? url : undefined
}

function sessionModel(info: Record<string, unknown>, field: string) {
  const model = obj(info.model)
  return str(model[field])
}

function opaque(index: number, role: string | undefined, timestamp: string, reason: string): Event {
  return opaquePart({ recordIndex: index, recordType: role }, role, timestamp, reason)
}

function opaquePart(provenance: Event["provenance"], role: string | undefined, timestamp: string, reason: string): Event {
  return {
    kind: "opaque",
    role: role === "user" ? "user" : role === "assistant" ? "assistant" : undefined,
    timestamp,
    payload: { reason },
    provenance,
  }
}
