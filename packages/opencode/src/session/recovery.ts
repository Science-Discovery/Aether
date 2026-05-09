import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { Session } from "."

export namespace SessionRecovery {
  const log = Log.create({ service: "session.recovery" })
  const limit = 100_000

  export async function repairInterrupted() {
    const boot = Date.now()
    let count = 0

    for (const session of Session.list({ limit })) {
      const messages = await Session.messages({ sessionID: session.id }).catch(() => [])
      const stale = messages.flatMap((msg) => {
        if (msg.info.role !== "assistant") return []
        if (typeof msg.info.time.completed === "number") return []
        if (msg.info.time.created >= boot) return []
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
                    ...part.state,
                    status: "error",
                    error: "Tool execution interrupted by a previous shutdown.",
                    time: {
                      start: Date.now(),
                      end: Date.now(),
                    },
                  },
                }),
              ),
            Session.updateMessage({
              ...msg.info,
              error:
                msg.info.error ??
                MessageV2.fromError(new Error("Assistant response was interrupted by a previous shutdown."), {
                  providerID: msg.info.providerID,
                }),
              time: {
                ...msg.info.time,
                completed: boot,
              },
            }),
          ]),
        ),
      )
      count += stale.length
    }

    if (count > 0) log.info("repaired interrupted assistant messages", { count })
  }
}
