import path from "node:path"
import { pathToFileURL } from "node:url"
import z from "zod"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { NativeHistory } from "./history"
import { NativeDisplay } from "./display"
import { NativeQuestion } from "./questions"

export type Link = { turn: string; item: string; message: MessageID; client?: string }
export type Options = {
  sessionID: SessionID
  scope: string
  cwd: string
  existing?: MessageV2.WithParts[]
  receipts?: MessageV2.Assistant[]
  /** Import a verified fork snapshot without inferring the source thread's execution state. */
  terminal?: boolean
}

const object = z.record(z.string(), z.unknown())
const strings = z.array(z.string())
const tools = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "functionCallOutput",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
  "hookPrompt",
])

function string(value: unknown) {
  return typeof value === "string" ? value : ""
}

function render(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value, null, 2)
}

function mime(url: string) {
  const data = /^data:(image\/[\w.+-]+);/i.exec(url)
  if (data) return data[1]
  const extension = path.extname(url.split(/[?#]/)[0]).toLowerCase()
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    }[extension] ?? "image/*"
  )
}

/** Pure display projection. Incomplete results must never replace or erase old history. */
export function project(snapshot: NativeHistory.Snapshot, opts: Options) {
  const messages: MessageV2.WithParts[] = []
  const links: Link[] = []
  const issues = [...snapshot.issues]
  const thread = snapshot.thread
  if (!thread) return { messages, links, complete: false, issues }
  const existing = (opts.existing ?? []).filter((row) => row.info.sessionID === opts.sessionID)
  const answers = NativeQuestion.texts(
    snapshot.turns
      .filter((turn) => turn.status === "completed" || (opts.terminal && NativeHistory.terminal(turn)))
      .flatMap((turn) => turn.items),
  )
  const users = new Map(existing.filter((row) => row.info.role === "user").map((row) => [String(row.info.id), row]))
  const replies = new Map(
    [
      ...existing.flatMap((row) => (row.info.role === "assistant" ? [row.info] : [])),
      ...(opts.receipts ?? []).filter((row) => row.sessionID === opts.sessionID),
    ].map((row) => [String(row.parentID), row]),
  )
  const claimed = new Set<string>()
  const used = new Set<string>()
  const provider = ProviderID.make("codex-native")
  const unknown = ModelID.make("unknown")

  for (const turn of snapshot.turns) {
    if (turn.status !== "completed" && !(opts.terminal && NativeHistory.terminal(turn))) {
      issues.push({ code: "unsettled", turn: turn.id, message: "Only completed native turns can be projected" })
      continue
    }
    const created = Math.max(0, (turn.startedAt ?? thread.createdAt) * 1_000)
    const completed = Math.max(created, (turn.completedAt ?? turn.startedAt ?? thread.createdAt) * 1_000)
    const state: {
      user?: MessageV2.WithParts
      assistant?: MessageV2.WithParts
      root?: MessageID
      accounted?: boolean
    } = {}
    const reply = () => {
      if (state.assistant) return state.assistant
      const parent = state.user!.info.id
      const primary = parent === state.root
      const prior = replies.get(parent)
      const original = state.root ? replies.get(state.root) : undefined
      const usage =
        prior &&
        !state.accounted &&
        (prior.nativeUsage !== undefined ||
          prior.tokens.total !== undefined ||
          prior.tokens.input > 0 ||
          prior.tokens.output > 0 ||
          prior.tokens.reasoning > 0 ||
          prior.tokens.cache.read > 0 ||
          prior.tokens.cache.write > 0)
      if (usage) state.accounted = true
      state.assistant = {
        info: {
          id: primary && prior ? prior.id : NativeDisplay.id(parent),
          sessionID: opts.sessionID,
          role: "assistant",
          parentID: parent,
          time: { created, completed },
          modelID: prior?.modelID ?? original?.modelID ?? unknown,
          providerID: provider,
          mode: "codex",
          agent: "codex",
          path: { cwd: opts.cwd, root: opts.cwd },
          cost: primary ? (prior?.cost ?? 0) : 0,
          tokens: usage ? prior.tokens : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          ...(usage && prior.nativeUsage ? { nativeUsage: prior.nativeUsage } : {}),
          ...((prior?.variant ?? original?.variant) ? { variant: prior?.variant ?? original?.variant } : {}),
          finish: turn.status === "completed" ? "stop" : "unknown",
        },
        parts: [],
      }
      messages.push(state.assistant)
      return state.assistant
    }
    if (!turn.items.length)
      issues.push({ code: "empty", turn: turn.id, message: "The completed turn contains no items" })

    for (const [ordinal, item] of turn.items.entries()) {
      const key = NativeHistory.key(opts.sessionID, opts.scope, thread.id, turn.id, item.id)
      if (used.has(key)) {
        issues.push({ code: "duplicate", turn: turn.id, item: item.id, message: "Repeated native item identity" })
        continue
      }
      used.add(key)
      const native = {
        engine: "codex",
        scope: opts.scope,
        thread: thread.id,
        turn: turn.id,
        item: item.id,
        type: item.type,
        raw: item,
        ...(opts.terminal ? { status: turn.status } : {}),
      }
      const issue = (message: string) => issues.push({ code: "unrepresented", turn: turn.id, item: item.id, message })
      // Parts are sorted by ID in both storage and the UI. The fixed-width
      // prefix records display position; the suffix and metadata retain native
      // identity. A reordered native snapshot can change a display ID, so use
      // native thread/turn/item identity (not PartID) for durable references.
      const base = (message: MessageID, index = 0) => ({
        id: PartID.make(
          `prt_${ordinal.toString(16).padStart(8, "0")}${index.toString(16).padStart(8, "0")}_${NativeHistory.key(key, String(index))}`,
        ),
        sessionID: opts.sessionID,
        messageID: message,
      })

      if (item.type === "userMessage") {
        const client = string(item.clientId)
        const previous = !client || !claimed.has(client) ? (users.get(client) ?? users.get(`msg_${key}`)) : undefined
        if (client && claimed.has(client)) issue("The same client message ID occurs more than once")
        if (client) claimed.add(client)
        const id = previous?.info.id ?? MessageID.make(`msg_${key}`)
        const info: MessageV2.User = {
          ...(previous?.info.role === "user" ? previous.info : {}),
          id,
          sessionID: opts.sessionID,
          role: "user",
          time: { created },
          agent: "codex",
          model: previous?.info.role === "user" ? previous.info.model : { providerID: provider, modelID: unknown },
        }
        const identity = { ...native, raw: undefined }
        const parts: MessageV2.Part[] = [
          { ...base(id), type: "text", text: "", ignored: true, synthetic: true, metadata: { native } },
        ]
        const texts: string[] = []
        const content = z.array(object).safeParse(item.content)
        if (!content.success) issue("The native user message has invalid content")
        for (const [index, value] of (content.success ? content.data : [item]).entries()) {
          const part = base(id, index + 2)
          if (value.type === "text" && typeof value.text === "string") {
            texts.push(value.text)
            continue
          }
          const url =
            value.type === "localImage" && typeof value.path === "string"
              ? path.isAbsolute(value.path)
                ? pathToFileURL(value.path).href
                : ""
              : value.type === "image" && typeof value.url === "string"
                ? value.url
                : ""
          if (url && /^(?:https?:|file:|data:image\/)/i.test(url)) {
            parts.push({ ...part, type: "file", mime: mime(url), url })
            continue
          }
          issue(`Unsupported native user content: ${string(value.type) || "unknown"}`)
          texts.push(`[Unsupported Codex content: ${string(value.type) || "unknown"}]\n${render(value)}`)
        }
        // The shared user bubble renders one non-synthetic text part. Preserve
        // every text segment there; the hidden anchor retains original input
        // ordering (including images) without shadowing that visible body.
        if (texts.length)
          parts.splice(1, 0, {
            ...base(id, 1),
            type: "text",
            text: texts.join("\n\n"),
            metadata: { native: identity, content: "text" },
          })
        const user = { info, parts }
        // Keep an observed first segment even when the native snapshot omitted
        // its output. Every later user starts a display segment in this same turn.
        if (state.user && !state.assistant && replies.has(state.user.info.id)) reply()
        state.root ??= id
        state.user = user
        state.assistant = undefined
        messages.push(user)
        links.push({ turn: turn.id, item: item.id, message: id, ...(client ? { client } : {}) })
        continue
      }

      // Manual compaction may be its own turn without a user prompt. Attach its
      // marker to the preceding reply, without inventing a question or moving
      // that reply's selectable fork boundary into the maintenance turn.
      if (
        turn.status === "completed" &&
        !state.user &&
        turn.items.every((entry) => entry.type === "contextCompaction")
      ) {
        if (item.status !== undefined && item.status !== "completed") {
          issue("A completed compaction turn contains an unfinished item")
          continue
        }
        const owner = messages.findLast((entry) => entry.info.role === "assistant")
        if (!owner) continue
        owner.parts.push({
          ...base(owner.info.id),
          id: PartID.make(`prt_zz${String(owner.parts.length).padStart(8, "0")}_${key}`),
          type: "tool",
          callID: item.id,
          tool: "codex.contextCompaction",
          metadata: { native },
          state: {
            status: "completed",
            input: { ...item },
            output: render(item),
            title: "contextCompaction",
            metadata: { native: item },
            time: { start: created, end: completed },
          },
        })
        continue
      }
      if (!state.user) {
        issue("The native turn has no preceding user item; a display-only placeholder was required")
        const id = MessageID.make(
          `msg_${NativeHistory.key(opts.sessionID, opts.scope, thread.id, turn.id, "missing-user")}`,
        )
        state.user = {
          info: {
            id,
            sessionID: opts.sessionID,
            role: "user",
            time: { created },
            agent: "codex",
            model: { providerID: provider, modelID: unknown },
          },
          parts: [
            {
              id: PartID.make(
                `prt_${ordinal.toString(16).padStart(8, "0")}00000000_${NativeHistory.key(key, "missing-user")}`,
              ),
              sessionID: opts.sessionID,
              messageID: id,
              type: "text",
              text: "[Codex history: user input unavailable]",
              ignored: true,
              metadata: { native },
            },
          ],
        }
        state.root ??= id
        messages.push(state.user)
      }
      const assistant = reply()
      const part = base(assistant.info.id)
      links.push({ turn: turn.id, item: item.id, message: assistant.info.id })
      if (item.type === "agentMessage" || item.type === "plan") {
        if (typeof item.text !== "string") issue("Native text item has no text")
        const question = NativeQuestion.parse(item, { thread: thread.id, turn: turn.id })
        assistant.parts.push({
          ...part,
          type: "text",
          text: typeof item.text === "string" ? item.text : render(item),
          time: { start: created, end: completed },
          metadata: { native, phase: item.phase },
          ...(question ? { nativeQuestion: NativeQuestion.answered(question, answers) } : {}),
        })
        continue
      }
      if (item.type === "reasoning") {
        const summary = strings.safeParse(item.summary)
        const content = strings.safeParse(item.content)
        if ((item.summary !== undefined && !summary.success) || (item.content !== undefined && !content.success))
          issue("Native reasoning has an unsupported format")
        assistant.parts.push({
          ...part,
          type: "reasoning",
          text: (summary.success && summary.data.length ? summary.data : content.success ? content.data : []).join(
            "\n\n",
          ),
          time: { start: created, end: completed },
          metadata: { native },
        })
        continue
      }
      if (!tools.has(item.type)) issue(`Unsupported native item: ${item.type}`)
      const failed =
        ["failed", "declined", "cancelled", "interrupted"].includes(string(item.status)) || item.success === false
      if (
        turn.status !== "completed" &&
        ((!failed && item.status !== "completed" && item.success !== true) ||
          (item.type === "commandExecution" && typeof item.aggregatedOutput !== "string"))
      ) {
        assistant.parts.push({
          ...part,
          type: "text",
          text: `[Incomplete tool result]\n${string(item.command) || string(item.tool) || item.type}\n${render(item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.output ?? item)}`,
          metadata: { native },
        })
        continue
      }
      if (["inProgress", "running", "pending"].includes(string(item.status)))
        issue("A completed turn contains an unfinished item")
      if (item.type === "commandExecution" && typeof item.aggregatedOutput !== "string")
        issue("The native history does not contain the command output")
      const name =
        item.type === "commandExecution"
          ? "bash"
          : item.type === "fileChange"
            ? "codex.fileChange"
            : item.type === "mcpToolCall"
              ? `mcp.${string(item.server)}.${string(item.tool)}`
              : `codex.${item.type}`
      const output =
        item.type === "commandExecution"
          ? render(item.aggregatedOutput)
          : item.type === "fileChange"
            ? render(item.changes)
            : render(item.result ?? item.contentItems ?? item.output ?? item)
      const input =
        item.type === "commandExecution"
          ? { command: item.command, cwd: item.cwd }
          : item.type === "fileChange"
            ? { changes: item.changes }
            : { ...item }
      assistant.parts.push({
        ...part,
        type: "tool",
        callID: item.id,
        tool: name,
        metadata: { native },
        state: failed
          ? {
              status: "error",
              input,
              error: render(item.error ?? item.failure) || output,
              metadata: { native: item },
              time: { start: created, end: completed },
            }
          : {
              status: "completed",
              input,
              output,
              title: string(item.command) || string(item.tool) || item.type,
              metadata: { native: item, exit: item.exitCode },
              time: { start: created, end: completed },
            },
      })
    }
  }
  return { messages, links, complete: snapshot.complete && !issues.length, issues }
}
