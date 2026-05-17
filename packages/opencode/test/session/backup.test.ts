import { describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { buildSessionBackup, importSessionBackup } from "../../src/session/backup"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"

Log.init({ print: false })

describe("session backup", () => {
  test("imports a backup as a new local session", async () => {
    await using src = await tmpdir({ git: true })
    await using dst = await tmpdir({ git: true })

    const backup = await Instance.provide({
      directory: src.path,
      fn: async () => {
        const session = await Session.create({ title: "backup source" })
        const user = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: 1_000 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        })
        await Session.updateMessage(user)
        const userPart = MessageV2.Part.parse({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text: "hello",
        })
        await Session.updatePart(userPart)

        const assistant = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          time: { created: 2_000, completed: 2_500 },
          parentID: user.id,
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "",
          agent: "build",
          path: { cwd: src.path, root: src.path },
          cost: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        })
        await Session.updateMessage(assistant)
        const assistantPart = MessageV2.Part.parse({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistant.id,
          type: "text",
          text: "world",
          metadata: {
            sourceMessageID: user.id,
          },
        })
        await Session.updatePart(assistantPart)

        const data = buildSessionBackup(session, await Session.messages({ sessionID: session.id }))
        const info = data.info as {
          id: string
          time: {
            created: number
            updated: number
          }
        } & Record<string, unknown>
        return {
          info: {
            ...info,
            share: { url: "https://example.com/share/demo" },
            revert: { messageID: assistant.id, partID: assistantPart.id },
            parentID: session.id,
            forkParentSessionID: session.id,
            forkAfterUserMessageID: user.id,
            time: {
              ...info.time,
              archived: Date.now(),
            },
          },
          messages: data.messages,
        }
      },
    })

    const result = await Instance.provide({
      directory: dst.path,
      fn: async () => importSessionBackup(backup),
    })

    await Instance.provide({
      directory: dst.path,
      fn: async () => {
        const session = await Session.get(result.sessionID)
        expect(session.id).not.toBe(String((backup.info as unknown as { id: string }).id))
        expect(session.title).toBe("backup source")
        expect(session.directory).toBe(dst.path)
        expect(session.parentID).toBeUndefined()
        expect(session.treeID).toBeDefined()
        expect(session.forkIndex).toBeUndefined()
        expect(session.forkParentSessionID).toBeUndefined()
        expect(session.forkAfterUserMessageID).toBeUndefined()
        expect(session.share).toBeUndefined()
        expect(session.revert).toBeUndefined()
        expect(session.time.archived).toBeUndefined()

        const tree = await Session.tree(result.sessionID)
        expect(tree.kind).toBe("tree")
        if (tree.kind !== "tree") throw new Error("expected tree view for imported session")
        expect(tree.sessions).toHaveLength(1)
        expect(tree.sessions[0]?.id).toBe(result.sessionID)

        const messages = await Session.messages({ sessionID: result.sessionID })
        expect(messages).toHaveLength(2)
        expect(messages[0]?.info.id).not.toBe(String((backup.messages[0]?.info as unknown as { id: string }).id))
        if (messages[1]?.info.role !== "assistant") throw new Error("expected assistant message")
        expect(messages[1].info.parentID).toBe(messages[0]?.info.id)

        const text = messages[1].parts.find((part) => part.type === "text")
        expect(text && "metadata" in text ? text.metadata?.sourceMessageID : undefined).toBe(messages[0]?.info.id)
      },
    })
  })

  test("imports multi-turn backups into a non-legacy linear graph", async () => {
    await using src = await tmpdir({ git: true })
    await using dst = await tmpdir({ git: true })

    const backup = await Instance.provide({
      directory: src.path,
      fn: async () => {
        const session = await Session.create({ title: "linear source" })

        const user1 = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: 1_000 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        })
        await Session.updateMessage(user1)
        await Session.updatePart(
          MessageV2.Part.parse({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: user1.id,
            type: "text",
            text: "first",
          }),
        )

        const assistant1 = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          time: { created: 2_000, completed: 2_500 },
          parentID: user1.id,
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "",
          agent: "build",
          path: { cwd: src.path, root: src.path },
          cost: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        })
        await Session.updateMessage(assistant1)
        await Session.updatePart(
          MessageV2.Part.parse({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: assistant1.id,
            type: "text",
            text: "first reply",
          }),
        )

        const user2 = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: 3_000 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        })
        await Session.updateMessage(user2)
        await Session.updatePart(
          MessageV2.Part.parse({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: user2.id,
            type: "text",
            text: "second",
          }),
        )

        const assistant2 = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          time: { created: 4_000, completed: 4_500 },
          parentID: user2.id,
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "",
          agent: "build",
          path: { cwd: src.path, root: src.path },
          cost: 0,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        })
        await Session.updateMessage(assistant2)
        await Session.updatePart(
          MessageV2.Part.parse({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: assistant2.id,
            type: "text",
            text: "second reply",
          }),
        )

        return buildSessionBackup(session, await Session.messages({ sessionID: session.id }))
      },
    })

    const result = await Instance.provide({
      directory: dst.path,
      fn: async () => importSessionBackup(backup),
    })

    await Instance.provide({
      directory: dst.path,
      fn: async () => {
        const graph = await Session.graph(result.sessionID)
        expect(graph.kind).toBe("graph")
        if (graph.kind !== "graph") throw new Error("expected graph view for imported session")
        expect(graph.nodes.filter((node) => node.kind === "turn")).toHaveLength(2)
        expect(new Set(graph.nodes.filter((node) => node.kind === "turn").map((node) => node.sessionID))).toEqual(
          new Set([result.sessionID]),
        )
      },
    })
  })
})
