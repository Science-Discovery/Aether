import { describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { buildSessionBackup, importSessionBackup } from "../../src/session/backup"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Database, eq } from "../../src/storage/db"
import { PartTable } from "../../src/session/session.sql"

Log.init({ print: false })

describe("session backup", () => {
  test("imports a validated backup into the current project and workspace", async () => {
    await using src = await tmpdir({ git: true })
    await using dst = await tmpdir({ git: true })

    const backup = await Instance.provide({
      directory: src.path,
      fn: async () => {
        const session = await Session.create({
          title: "backup source",
          permission: [{ permission: "*", action: "allow", pattern: "*" }],
        })
        const user = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: 1_000 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        })
        await Session.updateMessage(user)
        await Session.updatePart(
          MessageV2.Part.parse({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: user.id,
            type: "text",
            text: "hello",
            time: { start: 1_100 },
          }),
        )
        const assistant = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          time: { created: 2_000, completed: 2_500 },
          parentID: user.id,
          modelID: "claude",
          providerID: "anthropic",
          mode: "",
          agent: "build",
          path: { cwd: src.path, root: src.path },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updateMessage(assistant)
        await Session.updatePart(
          MessageV2.Part.parse({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: assistant.id,
            type: "text",
            text: "world",
            metadata: { sourceMessageID: user.id },
          }),
        )
        return buildSessionBackup(session, await Session.messages({ sessionID: session.id }))
      },
    })

    const workspaceID = WorkspaceID.ascending()
    const result = await Instance.provide({
      directory: dst.path,
      fn: () => WorkspaceContext.provide({ workspaceID, fn: () => importSessionBackup(backup) }),
    })

    await Instance.provide({
      directory: dst.path,
      fn: async () => {
        const session = await Session.get(result.sessionID)
        expect(session.id).not.toBe(backup.info.id)
        expect(session.directory).toBe(dst.path)
        expect(session.workspaceID).toBe(workspaceID)
        expect(session.permission).toBeUndefined()
        expect(session.share).toBeUndefined()
        expect(session.parentID).toBeUndefined()
        expect(session.time.archived).toBeUndefined()
        expect(session.time.updated).toBeGreaterThan(session.time.created)

        const messages = await Session.messages({ sessionID: result.sessionID })
        expect(messages).toHaveLength(2)
        if (messages[1]?.info.role !== "assistant") throw new Error("expected assistant message")
        expect(messages[1].info.parentID).toBe(messages[0]?.info.id)
        const text = messages[1].parts.find((part) => part.type === "text")
        expect(text && "metadata" in text ? text.metadata?.sourceMessageID : undefined).toBe(messages[0]?.info.id)

        const first = messages[0]?.parts[0]
        expect(
          Database.useProject(Instance.project.id, (db) =>
            db.select({ time: PartTable.time_created }).from(PartTable).where(eq(PartTable.id, first!.id)).get(),
          )?.time,
        ).toBe(1_100)
      },
    })
  })

  test("rejects duplicate IDs before creating a session", async () => {
    await using dir = await tmpdir({ git: true })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ title: "source" })
        const message = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: 1_000 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        })
        const backup = buildSessionBackup(session, [
          { info: message, parts: [] },
          { info: message, parts: [] },
        ])
        const before = [...Session.list({ roots: true })].length
        expect(importSessionBackup(backup)).rejects.toMatchObject({
          data: { message: "Duplicate message ID in session backup" },
        })
        expect([...Session.list({ roots: true })]).toHaveLength(before)

        const part = MessageV2.Part.parse({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: MessageID.ascending(),
          type: "text",
          text: "invalid",
        })
        const invalid = buildSessionBackup(session, [{ info: message, parts: [part] }])
        expect(importSessionBackup(invalid)).rejects.toMatchObject({
          data: { message: `Part ${part.id} belongs to another message` },
        })
        expect([...Session.list({ roots: true })]).toHaveLength(before)
      },
    })
  })
})
