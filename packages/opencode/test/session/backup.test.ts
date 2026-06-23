import { describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { buildSessionBackup, estimateSessionBackup, importSessionBackup } from "../../src/session/backup"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Database, count, eq, sql } from "../../src/storage/db"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { Bus } from "../../src/bus"
import { SessionStatus } from "../../src/session/status"
import { SyncEvent } from "../../src/sync"
import { EventTable } from "../../src/sync/event.sql"

Log.init({ print: false })

describe("session backup", () => {
  test("imports a legacy backup into the current project and workspace", async () => {
    await using src = await tmpdir({ git: true })
    await using dst = await tmpdir({ git: true })

    const source = await Instance.provide({
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
        return {
          backup: buildSessionBackup(session, await Session.messages({ sessionID: session.id })),
          estimate: await estimateSessionBackup(session.id),
        }
      },
    })
    const backup = source.backup
    expect(source.estimate.messages).toBe(2)
    expect(source.estimate.parts).toBe(2)
    expect(source.estimate.bytes).toBeGreaterThan(0)

    const workspaceID = WorkspaceID.ascending()
    const result = await Instance.provide({
      directory: dst.path,
      fn: async () => {
        expect([...SyncEvent.registry.values()].some((event) => event.type === "session.imported")).toBe(false)
        const events = Database.use((db) => db.select({ count: count() }).from(EventTable).get()?.count ?? 0)
        let imported = false
        let created = false
        const offImported = Bus.subscribe(Session.Event.Imported, (event) => {
          imported = Database.useProject(Instance.project.id, (db) => {
            const session = db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.id, event.properties.info.id))
              .get()
            const messages = db
              .select({ count: count() })
              .from(MessageTable)
              .where(eq(MessageTable.session_id, event.properties.info.id))
              .get()?.count
            const parts = db
              .select({ count: count() })
              .from(PartTable)
              .where(eq(PartTable.session_id, event.properties.info.id))
              .get()?.count
            return !!session && messages === 2 && parts === 2
          })
        })
        const offCreated = Bus.subscribe(Session.Event.Created, () => {
          created = true
        })
        const result = await WorkspaceContext.provide({
          workspaceID,
          fn: () => importSessionBackup({ info: backup.info, messages: backup.messages }),
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        offImported()
        offCreated()
        expect(imported).toBe(true)
        expect(created).toBe(false)
        expect(Database.use((db) => db.select({ count: count() }).from(EventTable).get()?.count ?? 0)).toBe(events)
        return result
      },
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
        await expect(importSessionBackup(backup)).rejects.toMatchObject({
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
        await expect(importSessionBackup(invalid)).rejects.toMatchObject({
          data: { message: `Part ${part.id} belongs to another message` },
        })
        expect([...Session.list({ roots: true })]).toHaveLength(before)
      },
    })
  })

  test("rolls back every row when an imported part fails", async () => {
    await using src = await tmpdir({ git: true })
    await using dst = await tmpdir({ git: true })
    const backup = await Instance.provide({
      directory: src.path,
      fn: async () => {
        const session = await Session.create({ title: "atomic source" })
        const message = MessageV2.Info.parse({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: 1_000 },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
        })
        const part = MessageV2.Part.parse({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "atomic",
        })
        return buildSessionBackup(session, [{ info: message, parts: [part] }])
      },
    })

    await Instance.provide({
      directory: dst.path,
      fn: async () => {
        let imported = false
        const off = Bus.subscribe(Session.Event.Imported, () => {
          imported = true
        })
        const before = [...Session.list({ roots: true })].length
        try {
          const abort = new AbortController()
          abort.abort()
          await expect(importSessionBackup(backup, abort.signal)).rejects.toMatchObject({ name: "AbortError" })
          expect([...Session.list({ roots: true })]).toHaveLength(before)

          Database.useProject(Instance.project.id, (db) =>
            db.run(
              sql.raw(
                "CREATE TRIGGER fail_session_import BEFORE INSERT ON part BEGIN SELECT RAISE(ABORT, 'forced import failure'); END",
              ),
            ),
          )
          await expect(importSessionBackup(backup)).rejects.toThrow("forced import failure")
          expect([...Session.list({ roots: true })]).toHaveLength(before)
          expect(imported).toBe(false)
        } finally {
          off()
        }
      },
    })
  })

  test("rejects import while another session is active", async () => {
    await using src = await tmpdir({ git: true })
    await using dst = await tmpdir({ git: true })
    await using sibling = await tmpdir({ git: true })
    const backup = await Instance.provide({
      directory: src.path,
      fn: async () => buildSessionBackup(await Session.create({ title: "active guard source" }), []),
    })

    const target = await Instance.provide({
      directory: dst.path,
      fn: async () => {
        const running = await Session.create({ title: "running" })
        return { project: Instance.project, running }
      },
    })

    await Instance.provide({
      directory: sibling.path,
      project: target.project,
      worktree: sibling.path,
      fn: () => SessionStatus.set(target.running.id, { type: "busy" }),
    })
    const reject = () =>
      Instance.provide({
        directory: dst.path,
        fn: async () => {
          const before = [...Session.list({ roots: true })].length
          await expect(importSessionBackup(backup)).rejects.toMatchObject({ name: "SessionImportActiveError" })
          expect([...Session.list({ roots: true })]).toHaveLength(before)
        },
      })
    try {
      await reject()
      await Instance.provide({
        directory: sibling.path,
        project: target.project,
        worktree: sibling.path,
        fn: () => SessionStatus.set(target.running.id, { type: "retry", attempt: 1, message: "retry", next: 1 }),
      })
      await reject()
    } finally {
      await Instance.provide({
        directory: sibling.path,
        project: target.project,
        worktree: sibling.path,
        fn: () => SessionStatus.set(target.running.id, { type: "idle" }),
      })
    }
  })
})
