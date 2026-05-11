import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRecovery } from "../../src/session/recovery"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

describe("session.recovery", () => {
  test("repairs unfinished assistant messages and tools for a stopped session", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = MessageID.ascending()
        const assistant = MessageID.ascending()

        await Session.updateMessage({
          id: user,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          tools: {},
        } as unknown as MessageV2.Info)
        await Session.updateMessage({
          id: assistant,
          sessionID: session.id,
          role: "assistant",
          parentID: user,
          time: { created: Date.now() },
          providerID: "test",
          modelID: "test",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as unknown as MessageV2.Info)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: assistant,
          sessionID: session.id,
          type: "tool",
          callID: "call-test",
          tool: "bash",
          state: {
            status: "running",
            input: {},
            time: { start: Date.now() },
          },
        })

        await SessionRecovery.repairSession(session.id)

        const messages = await Session.messages({ sessionID: session.id })
        const msg = messages.find((item) => item.info.id === assistant)
        const part = msg?.parts.find((item): item is MessageV2.ToolPart => item.type === "tool")

        expect(msg?.info.role).toBe("assistant")
        if (msg?.info.role !== "assistant") throw new Error("expected repaired assistant")
        expect(typeof msg.info.time.completed).toBe("number")
        expect(msg.info.error?.data.message).toContain("interrupted")
        expect(part?.state.status).toBe("error")
        if (part?.state.status !== "error") throw new Error("expected repaired tool error")
        expect(part.state.error).toBe("Tool execution interrupted.")
      },
    })
  })
})
