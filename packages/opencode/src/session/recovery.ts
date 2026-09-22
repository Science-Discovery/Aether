import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import type { SessionID } from "./schema"

export namespace SessionRecovery {
  const log = Log.create({ service: "session.recovery" })
  const limit = 100_000

  async function repair(input: {
    messages: MessageV2.WithParts[]
    completed: number
    message: string
    tool: string
    previous: boolean
  }) {
    const stale = input.messages.flatMap((msg) => {
      if (msg.info.role !== "assistant") return []
      if (typeof msg.info.time.completed === "number") return []
      if (input.previous && msg.info.time.created >= input.completed) return []
      return [{ info: msg.info, parts: msg.parts }]
    })

    await Promise.all(
      stale.map((msg) =>
        Promise.all([
          ...msg.parts
            .filter((part): part is MessageV2.ToolPart => part.type === "tool")
            .filter((part) => part.state.status !== "completed" && part.state.status !== "error")
            .map((part) =>
              Session.updatePart({
                ...part,
                state: {
                  ...("metadata" in part.state ? { metadata: part.state.metadata } : {}),
                  status: "error",
                  input: part.state.input,
                  error: input.tool,
                  time: {
                    start: part.state.status === "running" ? part.state.time.start : input.completed,
                    end: input.completed,
                  },
                },
              }),
            ),
          Session.updateMessage({
            ...msg.info,
            finish: msg.info.finish ?? "error",
            error:
              msg.info.error ??
              MessageV2.fromError(new Error(input.message), {
                providerID: msg.info.providerID,
              }),
            time: {
              ...msg.info.time,
              completed: input.completed,
            },
          }),
        ]),
      ),
    )

    return stale.length
  }

  // Only sessions touched recently can have crash-interrupted runs; older
  // ones are left as-is so opening a project with thousands of sessions
  // does not read every conversation.
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

  export async function repairInterrupted() {
    const boot = Date.now()
    const cutoff = boot - WINDOW_MS
    const all = [...Session.list({ limit })]
    const sessions = all.filter((session) => (session.time?.updated ?? 0) >= cutoff)
    let count = 0

    for (const session of sessions) {
      count += await repair({
        messages: await Session.messages({ sessionID: session.id }).catch(() => []),
        completed: boot,
        message: "Assistant response was interrupted by a previous shutdown.",
        tool: "Tool execution interrupted by a previous shutdown.",
        previous: true,
      })
    }

    if (all.length > sessions.length) {
      log.info("skipped old sessions for repair", { skipped: all.length - sessions.length })
    }
    if (count > 0) log.info("repaired interrupted assistant messages", { count })
  }

  export async function repairSession(sessionID: SessionID) {
    const count = await repair({
      messages: await Session.messages({ sessionID }).catch(() => []),
      completed: Date.now(),
      message: "Assistant response was interrupted.",
      tool: "Tool execution interrupted.",
      previous: false,
    })

    if (count > 0) log.info("repaired interrupted session", { sessionID, count })
  }
}
