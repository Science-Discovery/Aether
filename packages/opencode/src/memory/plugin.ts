import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Memory } from "."
import { Log } from "@/util/log"

const log = Log.create({ service: "memory.plugin" })

function textFromParts(parts: Array<{ type?: string; text?: string }>) {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

export async function MemoryPlugin(input: PluginInput): Promise<Hooks> {
  function schedule(task: Promise<unknown>) {
    void task.catch((error) => {
      log.warn("memory hook failed", { error })
    })
  }

  return {
    async "chat.message"(ctx, output) {
      const text = textFromParts(output.parts as Array<{ type?: string; text?: string }>)
      if (!text) return
      if (Memory.detectForgetIntent(text)) {
        schedule(Memory.forget({
          query: text,
          source: {
            createdAt: Date.now(),
            projectID: input.project.id,
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            role: "user",
          },
        }))
        return
      }
      schedule(Memory.remember({
        text,
        intent: "observed",
        source: {
          createdAt: Date.now(),
          projectID: input.project.id,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          role: "user",
        },
      }))
    },
    async "experimental.chat.system.transform"(ctx, output) {
      if ((ctx as { purpose?: string }).purpose !== "chat") return
      const prompt = await Memory.shortcutSystemPrompt()
      if (prompt) output.system.push(prompt)
    },
  }
}
