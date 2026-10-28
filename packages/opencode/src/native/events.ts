import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { PartID } from "@/session/schema"
import { NativeStore } from "./store"

export namespace NativeEvents {
  export type Outcome = { status: "completed" | "failed" | "interrupted"; error?: string }
  const object = z.record(z.string(), z.unknown())
  const strings = z.array(z.string())

  function string(value: unknown) {
    return typeof value === "string" ? value : ""
  }

  function number(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
  }

  function render(value: unknown) {
    if (typeof value === "string") return value
    return value === undefined || value === null ? "" : JSON.stringify(value, null, 2)
  }

  export function create(assistant: MessageV2.Assistant) {
    const parts = new Map<string, MessageV2.TextPart | MessageV2.ReasoningPart | MessageV2.ToolPart>()
    const done = Promise.withResolvers<Outcome>()
    const state = {
      thread: "",
      turn: "",
      active: false,
      settled: false,
      baseline: undefined as Record<string, number> | undefined,
    }
    const base = () => ({ id: PartID.ascending(), sessionID: assistant.sessionID, messageID: assistant.id })
    const settle = (outcome: Outcome) => {
      if (state.settled) return
      state.settled = true
      done.resolve(outcome)
    }

    function identity(value: unknown) {
      const agent = object.safeParse(value)
      return agent.success ? `Codex agent (${JSON.stringify(agent.data.name ?? agent.data.threadId)}):\n\n` : ""
    }

    async function item(value: unknown, completed: boolean, agent?: unknown) {
      const current = object.parse(value)
      const id = string(current.id)
      const type = string(current.type)
      if (!id || !type || ["userMessage", "hookPrompt"].includes(type)) return
      const previous = parts.get(id)
      const metadata = {
        native: { engine: "codex", item: id, turn: state.turn, type },
        ...(agent ? { nativeAgent: agent } : {}),
      }
      if (type === "agentMessage" || type === "reasoning" || type === "plan") {
        const reasoning = type === "reasoning"
        const summary = strings.safeParse(current.summary)
        const content = strings.safeParse(current.content)
        const text = reasoning
          ? (summary.success && summary.data.length ? summary.data : content.success ? content.data : []).join("\n\n")
          : string(current.text)
        const part = {
          ...(previous?.type === "text" || previous?.type === "reasoning" ? previous : base()),
          type: reasoning ? ("reasoning" as const) : ("text" as const),
          text: text
            ? identity(agent) + text
            : previous?.type === "text" || previous?.type === "reasoning"
              ? previous.text
              : identity(agent),
          time: {
            start:
              previous?.type === "text" || previous?.type === "reasoning"
                ? (previous.time?.start ?? Date.now())
                : Date.now(),
            ...(completed ? { end: Date.now() } : {}),
          },
          metadata: { ...metadata, phase: current.phase },
        }
        parts.set(id, part)
        await Session.updatePart(part)
        return
      }
      const tool = previous?.type === "tool" ? previous : undefined
      const buffered = tool && tool.state.status !== "pending" ? tool.state.metadata?.output : undefined
      const name =
        type === "commandExecution"
          ? "bash"
          : type === "fileChange"
            ? "codex.fileChange"
            : type === "mcpToolCall"
              ? `mcp.${string(current.server)}.${string(current.tool)}`
              : `codex.${type}`
      const input =
        type === "commandExecution"
          ? { command: current.command, cwd: current.cwd }
          : type === "fileChange"
            ? { changes: current.changes }
            : { ...current, id: undefined, type: undefined }
      const start = tool && tool.state.status !== "pending" ? tool.state.time.start : Date.now()
      const title =
        type === "commandExecution"
          ? string(current.command) || "Codex command"
          : type === "fileChange"
            ? "Codex file changes"
            : string(current.tool) || type
      const failed =
        ["failed", "declined", "cancelled", "interrupted"].includes(string(current.status)) || current.success === false
      const output =
        type === "commandExecution"
          ? string(current.aggregatedOutput)
          : type === "fileChange"
            ? render(current.changes)
            : render(current.result ?? current.contentItems ?? current)
      const part: MessageV2.ToolPart = {
        ...(tool ?? base()),
        type: "tool",
        callID: id,
        tool: name,
        metadata,
        state: !completed
          ? {
              status: "running",
              input,
              title,
              metadata: { output: output || buffered || "", native: current },
              time: { start },
            }
          : failed
            ? {
                status: "error",
                input,
                error: render(current.error) || output || `Codex ${type} ${string(current.status)}`,
                metadata: { native: current },
                time: { start, end: Date.now() },
              }
            : {
                status: "completed",
                input,
                output: output || render(buffered),
                title,
                metadata: { native: current, exit: current.exitCode },
                time: { start, end: Date.now() },
              },
      }
      parts.set(id, part)
      await Session.updatePart(part)
    }

    async function notification(method: string, value: unknown) {
      if (state.settled) return
      const parsed = object.safeParse(value)
      if (!parsed.success) return
      const data = parsed.data
      if (!state.active || !state.thread || data.threadId !== state.thread) return
      if (method === "turn/started") {
        const turn = object.parse(data.turn)
        if (!state.turn) state.turn = string(turn.id)
        return
      }
      if (!state.turn) return
      if (typeof data.turnId === "string" && state.turn && data.turnId !== state.turn) return
      if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
        const id = string(data.reviewId)
        const review = object.safeParse(data.review)
        if (!id || !review.success) return
        const key = `review:${id}`
        const previous = parts.get(key)
        const status = string(review.data.status)
        const title = `Codex automatic approval: ${status || "unknown"}`
        const input = { action: data.action, targetItemId: data.targetItemId }
        const metadata = { native: { engine: "codex", type: "autoApprovalReview", turn: state.turn, raw: data } }
        const time = { start: number(data.startedAtMs) || Date.now(), end: number(data.completedAtMs) || Date.now() }
        const part: MessageV2.ToolPart = {
          ...(previous?.type === "tool" ? previous : base()),
          type: "tool",
          tool: "codex.autoApprovalReview",
          callID: key,
          metadata,
          state:
            status === "inProgress" && method.endsWith("/started")
              ? { status: "running", input, title, metadata, time: { start: time.start } }
              : status === "approved"
                ? { status: "completed", input, title, output: render(review.data), metadata, time }
                : { status: "error", input, error: `${title}\n${render(review.data)}`, metadata, time },
        }
        parts.set(key, part)
        NativeStore.review(assistant.sessionID, assistant.parentID, part)
        await Session.updatePart(part)
        return
      }
      if (method === "item/started" || method === "item/completed") {
        await item(data.item, method === "item/completed", data.nativeAgent)
        return
      }
      if (
        [
          "item/agentMessage/delta",
          "item/plan/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ].includes(method)
      ) {
        const id = string(data.itemId)
        const delta = string(data.delta)
        if (!id || !delta) return
        const existing = parts.get(id)
        const reasoning = method.startsWith("item/reasoning/")
        const previous = existing?.type === "text" || existing?.type === "reasoning" ? existing : undefined
        const part = {
          ...(previous ?? base()),
          type: reasoning ? ("reasoning" as const) : ("text" as const),
          text: (previous?.text ?? identity(data.nativeAgent)) + delta,
          time: { start: previous?.time?.start ?? Date.now() },
          metadata: {
            native: { engine: "codex", item: id, turn: state.turn },
            ...(data.nativeAgent ? { nativeAgent: data.nativeAgent } : {}),
          },
        }
        parts.set(id, part)
        await Session.updatePart(part)
        return
      }
      if (method === "item/commandExecution/outputDelta") {
        const part = parts.get(string(data.itemId))
        if (part?.type !== "tool" || part.state.status !== "running") return
        part.state.metadata = {
          ...part.state.metadata,
          output: (string(part.state.metadata?.output) + string(data.delta)).slice(-200_000),
        }
        await Session.updatePart(part)
        return
      }
      if (method === "thread/tokenUsage/updated") {
        const usage = object.safeParse(data.tokenUsage)
        const last = object.safeParse(usage.success ? usage.data.last : undefined)
        if (!last.success) return
        const total = object.safeParse(usage.success ? usage.data.total : undefined)
        const fields = [
          "totalTokens",
          "inputTokens",
          "outputTokens",
          "reasoningOutputTokens",
          "cachedInputTokens",
          "cacheWriteInputTokens",
        ]
        const current = Object.fromEntries(fields.map((field) => [field, number(last.data[field])]))
        const cumulative = total.success && typeof total.data.totalTokens === "number" ? total.data : undefined
        if (cumulative) {
          state.baseline ??= Object.fromEntries(
            fields.map((field) => [field, Math.max(0, number(cumulative[field]) - current[field])]),
          )
        }
        const baseline = state.baseline
        const counts =
          cumulative && baseline
            ? Object.fromEntries(
                fields.map((field) => [field, Math.max(0, number(cumulative[field]) - baseline[field])]),
              )
            : current
        assistant.tokens = {
          total: counts.totalTokens,
          input: Math.max(0, counts.inputTokens - counts.cachedInputTokens - counts.cacheWriteInputTokens),
          output: counts.outputTokens,
          reasoning: counts.reasoningOutputTokens,
          cache: { read: counts.cachedInputTokens, write: counts.cacheWriteInputTokens },
        }
        // Last input is observed context evidence; cumulative turn usage is not
        // the amount currently occupying the model's context window.
        const input = z.number().finite().nonnegative().safeParse(last.data.inputTokens)
        const capacity = z
          .number()
          .finite()
          .positive()
          .safeParse(usage.success ? usage.data.modelContextWindow : undefined)
        const recent = z.number().finite().nonnegative().safeParse(last.data.totalTokens)
        assistant.nativeUsage = {
          input: input.success ? input.data : undefined,
          contextWindow: capacity.success ? capacity.data : undefined,
          total: recent.success ? recent.data : undefined,
          updatedAt: Date.now(),
        }
        await Session.updateMessage(assistant)
        return
      }
      if (method === "error" && data.willRetry === false) {
        const error = object.safeParse(data.error)
        settle({ status: "failed", error: error.success ? string(error.data.message) : "Codex reported an error." })
        return
      }
      if (method !== "turn/completed") return
      const turn = object.parse(data.turn)
      if (state.turn && turn.id !== state.turn) return
      if (Array.isArray(turn.items)) {
        for (const value of turn.items) await item(value, true)
      }
      const error = object.safeParse(turn.error)
      const status =
        turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : "failed"
      settle({ status, error: error.success ? string(error.data.message) : undefined })
    }

    async function finish(outcome: Outcome) {
      state.settled = true
      for (const part of parts.values()) {
        if (part.type === "tool" && (part.state.status === "running" || part.state.status === "pending")) {
          part.state = {
            status: "error",
            input: part.state.input,
            error: outcome.error || "Codex ended before this tool returned a result.",
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now(), end: Date.now() },
          }
          await Session.updatePart(part)
          if (part.tool === "codex.autoApprovalReview")
            NativeStore.review(assistant.sessionID, assistant.parentID, part)
        }
        if (part.type === "text" || part.type === "reasoning") {
          part.time = { start: part.time?.start ?? assistant.time.created, end: Date.now() }
          await Session.updatePart(part)
        }
      }
      assistant.time.completed = Date.now()
      assistant.finish = outcome.status === "completed" ? "stop" : "error"
      if (outcome.status === "interrupted") {
        assistant.error = new MessageV2.AbortedError({ message: outcome.error || "Codex turn interrupted." }).toObject()
      }
      if (outcome.status === "failed") {
        assistant.error = new NamedError.Unknown({ message: outcome.error || "Codex turn failed." }).toObject()
      }
      await Session.updateMessage(assistant)
      return { info: assistant, parts: [...parts.values()] }
    }

    function changes(id: string) {
      const part = parts.get(id)
      if (part?.type !== "tool" || part.tool !== "codex.fileChange") return
      const parsed = z
        .array(z.object({ path: z.string(), kind: z.unknown(), diff: z.string() }))
        .min(1)
        .safeParse(part.state.input.changes)
      if (!parsed.success) return
      return parsed.data
        .map((file) => `File: ${JSON.stringify(file.path)}\nChange: ${render(file.kind)}\n${file.diff}`)
        .join("\n\n")
    }

    function command(id: string) {
      const part = parts.get(id)
      if (part?.type !== "tool" || part.tool !== "bash" || part.state.status === "pending") return
      const parsed = z
        .object({ command: z.string().min(1), cwd: z.string().min(1), processId: z.string().nullable().optional() })
        .safeParse(part.state.metadata?.native)
      return parsed.success ? parsed.data : undefined
    }

    return { state, done: done.promise, notification, settle, finish, changes, command }
  }
}
