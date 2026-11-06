import { NamedError } from "@opencode-ai/util/error"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { PartID } from "@/session/schema"

export namespace EngineEvents {
  export type Outcome = { status: "completed" | "failed" | "interrupted"; error?: string }

  export type ToolUpdate = {
    id: string
    title?: string
    kind?: string
    status?: "pending" | "in_progress" | "completed" | "failed"
    input?: unknown
    output?: string
    error?: string
  }

  export function create(assistant: MessageV2.Assistant) {
    const parts = new Map<string, MessageV2.TextPart | MessageV2.ReasoningPart | MessageV2.ToolPart>()
    const done = Promise.withResolvers<Outcome>()
    let text: MessageV2.TextPart | undefined
    let thought: MessageV2.ReasoningPart | undefined
    let plan: MessageV2.TextPart | undefined
    let settled = false

    const base = () => ({ id: PartID.ascending(), sessionID: assistant.sessionID, messageID: assistant.id })

    function settle(outcome: Outcome) {
      if (settled) return
      settled = true
      done.resolve(outcome)
    }

    async function textChunk(delta: string) {
      if (!delta) return
      text ??= {
        ...base(),
        type: "text",
        text: "",
        time: { start: Date.now() },
        metadata: { engine: assistant.providerID },
      }
      text.text += delta
      parts.set(text.id, text)
      await Session.updatePart({ ...text })
    }

    async function reasoningChunk(delta: string) {
      if (!delta) return
      thought ??= {
        ...base(),
        type: "reasoning",
        text: "",
        time: { start: Date.now() },
        metadata: { engine: assistant.providerID },
      }
      thought.text += delta
      parts.set(thought.id, thought)
      await Session.updatePart({ ...thought })
    }

    async function planUpdate(entries: Array<{ content: string; status?: string; priority?: string }>) {
      plan ??= {
        ...base(),
        type: "text",
        text: "",
        time: { start: Date.now() },
        metadata: { engine: assistant.providerID, plan: true },
      }
      plan.text = entries.map((entry) => `- [${entry.status ?? "pending"}] ${entry.content}`).join("\n")
      parts.set(plan.id, plan)
      await Session.updatePart({ ...plan })
    }

    function render(value: unknown) {
      if (value === undefined || value === null) return ""
      if (typeof value === "string") return value
      return JSON.stringify(value, null, 2)
    }

    function toolPart(update: ToolUpdate, previous?: MessageV2.ToolPart): MessageV2.ToolPart {
      const status = update.status ?? previous?.state.status ?? "pending"
      const input =
        update.input && typeof update.input === "object" && !Array.isArray(update.input)
          ? (update.input as Record<string, unknown>)
          : previous?.state.input ?? (update.input === undefined ? {} : { value: update.input })
      const title =
        update.title ??
        (previous?.state.status === "running" || previous?.state.status === "completed"
          ? previous.state.title
          : undefined) ??
        update.id
      const output = update.output ?? (previous?.state.status === "completed" ? previous.state.output : "")
      const start = previous && previous.state.status !== "pending" ? previous.state.time.start : Date.now()
      const metadata = { engine: assistant.providerID, acp: update }
      const state: MessageV2.ToolPart["state"] =
        status === "completed"
          ? { status: "completed", input, output, title, metadata, time: { start, end: Date.now() } }
          : status === "failed"
            ? {
                status: "error",
                input,
                error: update.error || output || `${title} failed`,
                metadata,
                time: { start, end: Date.now() },
              }
            : status === "in_progress"
              ? { status: "running", input, title, metadata: { output }, time: { start } }
              : { status: "pending", input, raw: render(update) }
      return {
        ...(previous ?? base()),
        type: "tool",
        callID: update.id,
        tool: `acp.${update.kind ?? "tool"}`,
        metadata: { engine: assistant.providerID },
        state,
      } satisfies MessageV2.ToolPart
    }

    async function tool(update: ToolUpdate) {
      const previous = parts.get(update.id)
      const part = toolPart(update, previous?.type === "tool" ? previous : undefined)
      parts.set(update.id, part)
      await Session.updatePart({ ...part })
    }

    async function finish(outcome: Outcome) {
      if (settled || outcome) settle(outcome)
      for (const part of parts.values()) {
        if (part.type === "tool" && (part.state.status === "running" || part.state.status === "pending")) {
          part.state = {
            status: "error",
            input: part.state.input,
            error: outcome.error || "The agent ended before this tool returned a result.",
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now(), end: Date.now() },
          }
          await Session.updatePart({ ...part })
        }
        if (part.type === "text" || part.type === "reasoning") {
          part.time = { start: part.time?.start ?? assistant.time.created, end: Date.now() }
          await Session.updatePart({ ...part })
        }
      }
      assistant.time.completed = Date.now()
      assistant.finish = outcome.status === "completed" ? "stop" : "error"
      if (outcome.status === "interrupted") {
        assistant.error = new MessageV2.AbortedError({
          message: outcome.error || "The agent turn was interrupted.",
        }).toObject()
      }
      if (outcome.status === "failed") {
        assistant.error = new NamedError.Unknown({ message: outcome.error || "The agent turn failed." }).toObject()
      }
      await Session.updateMessage(assistant)
      return { info: assistant, parts: [...parts.values()] }
    }

    return {
      info: assistant,
      done: done.promise,
      settle,
      text: textChunk,
      reasoning: reasoningChunk,
      plan: planUpdate,
      tool,
      finish,
      get settled() {
        return settled
      },
    }
  }
}
