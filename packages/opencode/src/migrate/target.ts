import { createSessionBackup, type SessionBackupData } from "@opencode-ai/util/session-backup"
import { MigrateError } from "./error"
import type { Event, Loss, MigrateManifest, ParsedSession } from "./model"
import { bump, imageFilePart, list, num, obj, omissionKey, portableDataImage, sorted, str, titleText } from "./util"

type Part = Record<string, unknown>
type Message = { info: Record<string, unknown>; parts: Part[] }
type Pending = { role: "user" | "assistant"; record: number; created: number; parts: Part[] }
type Tool = { part: Part; start: number; messageID?: string }

export type TargetOptions = {
  directory: string
  version?: string
  agent?: string
  provider?: string
  model?: string
}

export type TargetResult = {
  backup: SessionBackupData
  loss: Loss
  manifest: MigrateManifest
}

export function buildBackup(session: ParsedSession, options: TargetOptions): TargetResult {
  const loss: Loss = {}
  const messages: Message[] = []
  const tools = new Map<string, Tool[]>()
  const calls = new Set<string>()
  const results = new Set<string>()
  const generated: string[] = []
  const directory = options.directory
  const provider = session.provider ?? options.provider ?? "anthropic"
  const model = options.model ?? session.model ?? "unknown"
  const agent = options.agent ?? "build"
  const fallback = (session.startedAt && Date.parse(session.startedAt)) || Date.now()
  const sessionID = `ses_import_${crypto.randomUUID().replaceAll("-", "")}`
  const pinned: Partial<Record<ParsedSession["source"], string>> = {
    claude: "2.1.209",
    codex: "0.144.4",
    copilot: "1.0.70",
    opencode: "1.17.20",
    kilo: "7.5.0",
    omp: "18.0.5",
    qwen: "0.22.1",
    kimi: "0.38.0",
    vibe: "2.24.3",
    muse: "0.2.1",
    grok: "1.0.5",
    openhands: "1.16.0",
  }
  const warnings =
    session.cliVersion && pinned[session.source] && session.cliVersion !== pinned[session.source]
      ? [`unvalidated_source_version:${session.source}:${session.cliVersion}`]
      : []
  const resolvedTitle = (() => {
    if (session.title) return session.title
    const pick = (role: "user" | "assistant") =>
      session.events
        .filter((event) => event.kind === "message" && event.role === role && event.text?.trim())
        .map((event) => titleText(event.text))
        .find(Boolean)
    return pick("user") ?? pick("assistant") ?? `Imported ${session.source} session`
  })()
  let sequence = 0
  let clock = -1
  let lastUser: string | undefined
  let pending: Pending | undefined

  const partID = () => `prt_import_${sequence++}`
  const messageID = () => `msg_import_${sequence++}`
  const stamp = (event: Event) => (event.timestamp && Date.parse(event.timestamp)) || fallback
  const time = (value: number) => {
    const next = Math.max(value, clock)
    if (next !== value) bump(loss, "timestamp:native_order_adjusted")
    clock = next
    return next
  }
  const flush = () => {
    if (!pending || !pending.parts.length) {
      pending = undefined
      return
    }
    if (pending.role === "assistant" && !lastUser) {
      const userID = messageID()
      const created = time(pending.created)
      messages.push({
        info: {
          id: userID,
          sessionID,
          role: "user",
          time: { created },
          agent,
          model: { providerID: provider, modelID: model },
        },
        parts: [{ id: partID(), sessionID, messageID: userID, type: "text", text: "[Imported session]" }],
      })
      lastUser = userID
      bump(loss, "session:synthetic_user_parent")
    }
    const role = pending.role
    const id = messageID()
    for (const part of pending.parts) {
      part.sessionID = sessionID
      part.messageID = id
      if (part.type === "tool") {
        const tool = tools.get(String(part.callID))?.find((entry) => entry.part === part)
        if (tool) tool.messageID = id
      }
    }
    const created = time(pending.created)
    if (role === "user") {
      messages.push({
        info: {
          id,
          sessionID,
          role,
          time: { created },
          agent,
          model: { providerID: provider, modelID: model },
        },
        parts: pending.parts,
      })
      lastUser = id
    } else {
      messages.push({
        info: {
          id,
          sessionID,
          role,
          time: { created, completed: created },
          parentID: lastUser,
          modelID: model,
          providerID: provider,
          mode: agent,
          agent,
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: pending.parts.some((part) => part.type === "tool") ? "tool-calls" : "stop",
        },
        parts: pending.parts,
      })
    }
    pending = undefined
  }
  const queue = (event: Event, role: "user" | "assistant", part: Part) => {
    if (pending && (pending.role !== role || pending.record !== event.provenance.recordIndex)) flush()
    if (!pending) pending = { role, record: event.provenance.recordIndex, created: stamp(event), parts: [] }
    pending.parts.push(part)
  }
  const toolInput = (event: Event) => {
    const input = event.payload.input
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
    if (input !== undefined) bump(loss, "tool_call:non_object_input")
    return input === undefined ? {} : { input }
  }

  for (const event of session.events) {
    if (event.kind === "message" && event.text && (event.role === "user" || event.role === "assistant")) {
      if (event.payload.ui_only_projection === true) bump(loss, "message:ui_only_projection")
      queue(event, event.role, { id: partID(), type: "text", text: event.text })
      continue
    }

    if (event.kind === "tool_call") {
      let callID = event.toolCallID
      if (!callID) {
        callID = `call_import_${sequence++}`
        generated.push(callID)
        bump(loss, "tool_call:missing_id")
      }
      if (!event.toolName) bump(loss, "tool_call:missing_name")
      if (event.payload.namespace) bump(loss, "tool_call:namespace")
      if (calls.has(callID)) bump(loss, "tool_call:duplicate_id")
      calls.add(callID)
      const input = toolInput(event)
      const part: Part = {
        id: partID(),
        callID,
        type: "tool",
        tool: event.toolName ?? "unknown_tool",
        state: { status: "pending", input, raw: JSON.stringify(input) },
      }
      const queueForCall = tools.get(callID) ?? []
      queueForCall.push({ part, start: stamp(event) })
      tools.set(callID, queueForCall)
      queue(event, "assistant", part)
      continue
    }

    if (event.kind === "tool_result") {
      flush()
      let callID = event.toolCallID
      if (!callID) {
        callID = generated.shift() ?? `call_import_missing_${sequence++}`
        bump(loss, "tool_result:missing_id")
      }
      if (event.toolCallID) {
        if (results.has(event.toolCallID)) bump(loss, "tool_result:duplicate_id")
        results.add(event.toolCallID)
      }
      let queueForCall = tools.get(callID)
      let tool = queueForCall?.shift()
      if (!queueForCall?.length) tools.delete(callID)
      if (!tool) {
        bump(loss, "tool_result:orphan_id")
        callID = `call_import_orphan_${sequence++}`
        const part: Part = {
          id: partID(),
          callID,
          type: "tool",
          tool: event.toolName ?? "unknown_tool",
          state: { status: "pending", input: {}, raw: "{}" },
        }
        tool = { part, start: stamp(event) }
        tools.set(callID, [tool])
        queue(event, "assistant", part)
        flush()
        tools.delete(callID)
      }
      const state = obj(tool.part.state)
      const input = obj(state.input)
      const result = toolResult(event, loss)
      const end = Math.max(stamp(event), tool.start)
      if (event.payload.is_error === true) {
        tool.part.state = {
          status: "error",
          input,
          error: result.text || "tool execution failed",
          time: { start: tool.start, end },
        }
      } else {
        const attachments = result.images.flatMap((url) => {
          if (!tool?.messageID) {
            bump(loss, "tool_result:image")
            return []
          }
          const part = imageFilePart(url, { id: partID(), sessionID, messageID: tool.messageID })
          if (!part) {
            bump(loss, "tool_result:image")
            return []
          }
          return [part]
        })
        tool.part.state = {
          status: "completed",
          input,
          output: result.text,
          title: String(tool.part.tool ?? "unknown_tool"),
          metadata: {},
          time: { start: tool.start, end },
          ...(attachments.length ? { attachments } : {}),
        }
      }
      continue
    }

    if (event.kind === "context" && event.payload.block_type === "image" && event.role === "user") {
      const url = str(event.payload.image_url)
      const part = url ? imageFilePart(url, { id: partID(), sessionID, messageID: "" }) : undefined
      if (!part) {
        bump(loss, "context:image")
        continue
      }
      queue(event, "user", part)
      continue
    }

    if (event.kind === "compaction" && event.text) {
      flush()
      if (event.payload.has_boundary_metadata === true) bump(loss, "compaction:boundary_metadata")
      const created = time(stamp(event))
      const userID = messageID()
      messages.push({
        info: {
          id: userID,
          sessionID,
          role: "user",
          time: { created },
          agent,
          model: { providerID: provider, modelID: model },
        },
        parts: [
          {
            id: partID(),
            sessionID,
            messageID: userID,
            type: "compaction",
            auto: true,
            ...(event.payload.overflow === true ? { overflow: true } : {}),
          },
        ],
      })
      lastUser = userID
      const assistantID = messageID()
      messages.push({
        info: {
          id: assistantID,
          sessionID,
          role: "assistant",
          time: { created, completed: created },
          parentID: userID,
          modelID: model,
          providerID: provider,
          mode: agent,
          agent,
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          summary: true,
        },
        parts: [{ id: partID(), sessionID, messageID: assistantID, type: "text", text: event.text }],
      })
      continue
    }

    bump(loss, omissionKey(event))
  }
  flush()

  if (!messages.some((message) => message.info.role === "user")) {
    throw new MigrateError("no user conversation history was found to import")
  }

  const first = num(messages[0]?.info.time && obj(messages[0].info.time).created) ?? fallback
  const updated = messages.reduce((max, message) => Math.max(max, Number(obj(message.info.time).created) || 0), first)
  const backup = createSessionBackup(
    {
      id: sessionID,
      slug: `migrate-${session.source}`,
      projectID: "global",
      directory,
      title: resolvedTitle,
      version: options.version ?? "1.0.0",
      time: { created: first, updated: Math.max(updated, first + 1) },
    },
    messages,
  )
  return {
    backup,
    loss: sorted(loss),
    manifest: {
      source: session.source,
      path: session.path,
      sha256: session.sha256,
      sessionID: session.sessionID,
      title: resolvedTitle,
      cwd: session.cwd,
      cliVersion: session.cliVersion,
      messages: messages.length,
      parts: messages.reduce((sum, message) => sum + message.parts.length, 0),
      events: session.events.length,
      loss: sorted(loss),
      warnings,
    },
  }
}

function toolResult(event: Event, loss: Loss) {
  const blocks = list(event.payload.content_blocks)
  const text: string[] = []
  const images: string[] = []
  for (const value of blocks) {
    const block = obj(value)
    const type = str(block.type)
    if (type === "text" || type === "input_text" || type === "output_text") {
      const value = str(block.text)
      if (value) text.push(value)
      else bump(loss, "tool_result:malformed_text")
      continue
    }
    if (type === "image" || type === "input_image") {
      const url = str(block.image_url) ?? str(block.url)
      if (url && portableDataImage(url)) images.push(url)
      else bump(loss, "tool_result:image")
      continue
    }
    bump(loss, `tool_result:${type ?? "unknown_block"}`)
  }
  if (!text.length && event.text) text.push(event.text)
  return { text: text.join("\n"), images }
}
