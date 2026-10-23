import { describe, expect, test } from "bun:test"
import { createSessionBackup } from "@opencode-ai/util/session-backup"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { importSessionBackup, linkSubagent } from "../../src/session/backup"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("subagent import", () => {
  test("imports a child session and links it with a task part", async () => {
    await using dir = await tmpdir({ git: true })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const parent = await Session.create({ title: "Parent" })
        const user = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: parent.id,
          role: "user",
          time: { created: 1_000 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        })
        await Session.updateMessage(user)
        await Session.updatePart(
          MessageV2.Part.parse({
            id: PartID.ascending(),
            sessionID: parent.id,
            messageID: user.id,
            type: "text",
            text: "parent prompt",
          }),
        )

        const info = {
          id: "ses_child_source",
          slug: "child-source",
          projectID: "global",
          directory: dir.path,
          title: "Child source",
          version: "local",
          time: { created: 1, updated: 2 },
        }
        const childUser = {
          id: "msg_child_user",
          sessionID: info.id,
          role: "user" as const,
          time: { created: 1 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        }
        const childAssistant = {
          id: "msg_child_assistant",
          sessionID: info.id,
          role: "assistant" as const,
          time: { created: 2, completed: 3 },
          parentID: childUser.id,
          modelID: "claude",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { cwd: dir.path, root: dir.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }
        const rows: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }> = [
          {
            info: childUser,
            parts: [
              {
                id: "prt_child_user",
                sessionID: info.id,
                messageID: childUser.id,
                type: "text",
                text: "child prompt",
              },
            ],
          },
          {
            info: childAssistant,
            parts: [
              {
                id: "prt_child_assistant",
                sessionID: info.id,
                messageID: childAssistant.id,
                type: "text",
                text: "child answer",
              },
            ],
          },
        ]
        const backup = createSessionBackup(info, rows)

        const imported = await importSessionBackup(backup, undefined, {
          parentID: parent.id,
          title: "Parent · Fixture",
        })
        const child = await Session.get(imported.sessionID)
        expect(child.parentID).toBe(parent.id)
        expect(child.treeID).toBe((await Session.get(parent.id)).treeID)
        expect(child.title).toBe("Parent · Fixture")

        const linked = await linkSubagent({
          parentID: parent.id,
          childID: imported.sessionID,
          title: "Parent · Fixture",
        })
        expect(linked).toBe(true)

        const parentMessages = await Session.messages({ sessionID: parent.id })
        const task = parentMessages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "task")
        if (!task || task.type !== "tool") throw new Error("expected task part")
        expect(task.state.status).toBe("completed")
        if (task.state.status === "completed") {
          expect(task.state.metadata?.sessionId).toBe(imported.sessionID)
        }
      },
    })
  })
})
