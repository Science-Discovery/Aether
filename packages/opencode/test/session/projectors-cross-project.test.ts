import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Database, eq } from "../../src/storage/db"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util/log"
import { Flag } from "../../src/flag/flag"
import { initProjectors } from "../../src/server/projectors"

Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

beforeEach(() => {
  Database.close()
  initProjectors()
  // @ts-expect-error test override
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
})

afterEach(() => {
  // @ts-expect-error test override
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
})

type Tmp = Awaited<ReturnType<typeof tmpdir>>

async function seedB(tmpB: Tmp) {
  return Instance.provide({
    directory: tmpB.path,
    fn: async () => {
      const session = await Session.create({})
      const msg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID: session.id,
        time: { created: Date.now() },
        role: "user",
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      }
      await Session.updateMessage(msg)
      const part: MessageV2.TextPart = {
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: msg.id,
        type: "text",
        text: "before",
      }
      await Session.updatePart(part)
      return { session, msg, part, pidB: Instance.project.id }
    },
  })
}

describe("cross-project message/part projectors", () => {
  test("part edit on a foreign instance lands in the owning project db", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const { session, part, pidB } = await seedB(tmpB)
    const pidA = await Instance.provide({ directory: tmpA.path, fn: () => Instance.project.id })
    expect(pidA).not.toBe(pidB)

    await Instance.provide({
      directory: tmpA.path,
      fn: async () => {
        await Session.updatePart({ ...part, text: "edited" })
      },
    })

    const rowB = Database.useProject(pidB, (db) => db.select().from(PartTable).where(eq(PartTable.id, part.id)).get())
    expect(rowB?.data).toMatchObject({ type: "text", text: "edited" })
    expect(Database.useProject(pidA, (db) => db.select().from(PartTable).all())).toHaveLength(0)
  })

  test("part removed on a foreign instance is deleted from the owning project db", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const { session, part, pidB } = await seedB(tmpB)
    const pidA = await Instance.provide({ directory: tmpA.path, fn: () => Instance.project.id })
    expect(pidA).not.toBe(pidB)

    await Instance.provide({
      directory: tmpA.path,
      fn: async () => {
        await Session.removePart({ sessionID: session.id, messageID: part.messageID, partID: part.id })
      },
    })

    expect(
      Database.useProject(pidB, (db) => db.select().from(PartTable).where(eq(PartTable.id, part.id)).get()),
    ).toBeUndefined()
  })

  test("message removed on a foreign instance is deleted from the owning project db", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const { msg, pidB } = await seedB(tmpB)
    const pidA = await Instance.provide({ directory: tmpA.path, fn: () => Instance.project.id })
    expect(pidA).not.toBe(pidB)

    await Instance.provide({
      directory: tmpA.path,
      fn: async () => {
        await Session.removeMessage({ sessionID: msg.sessionID, messageID: msg.id })
      },
    })

    expect(
      Database.useProject(pidB, (db) => db.select().from(MessageTable).where(eq(MessageTable.id, msg.id)).get()),
    ).toBeUndefined()
  })

  test("message edit on a foreign instance lands in the owning project db", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const { msg, pidB } = await seedB(tmpB)
    const pidA = await Instance.provide({ directory: tmpA.path, fn: () => Instance.project.id })
    expect(pidA).not.toBe(pidB)

    await Instance.provide({
      directory: tmpA.path,
      fn: async () => {
        await Session.updateMessage({ ...msg, time: { created: 12345 } })
      },
    })

    const rowB = Database.useProject(pidB, (db) =>
      db.select().from(MessageTable).where(eq(MessageTable.id, msg.id)).get(),
    )
    expect(rowB?.data.time.created).toBe(12345)
    expect(Database.useProject(pidA, (db) => db.select().from(MessageTable).all())).toHaveLength(0)
  })

  test("same-project writes still take the current-project fast path", async () => {
    await using tmpB = await tmpdir()
    const { part, pidB } = await seedB(tmpB)

    await Instance.provide({
      directory: tmpB.path,
      fn: async () => {
        await Session.updatePart({ ...part, text: "local" })
      },
    })

    const rowB = Database.useProject(pidB, (db) => db.select().from(PartTable).where(eq(PartTable.id, part.id)).get())
    expect(rowB?.data).toMatchObject({ text: "local" })
  })

  test("late update for a deleted session stays swallowed and throws nothing", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const { session, part, pidB } = await seedB(tmpB)
    const pidA = await Instance.provide({ directory: tmpA.path, fn: () => Instance.project.id })

    Database.useProject(pidB, (db) => db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run())

    await Instance.provide({
      directory: tmpA.path,
      fn: async () => {
        await Session.updatePart({ ...part, text: "late" })
      },
    })

    expect(Database.useProject(pidB, (db) => db.select().from(PartTable).all())).toHaveLength(0)
    expect(Database.useProject(pidA, (db) => db.select().from(PartTable).all())).toHaveLength(0)
  })
})
