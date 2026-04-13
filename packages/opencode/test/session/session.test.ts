import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { Database, eq } from "../../src/storage/db"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.created event", () => {
  test("should emit session.created event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: Session.Info | undefined

        const unsub = Bus.subscribe(Session.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as Session.Info
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(session.id)
        expect(receivedInfo?.projectID).toBe(session.projectID)
        expect(receivedInfo?.directory).toBe(session.directory)
        expect(receivedInfo?.title).toBe(session.title)

        await Session.remove(session.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(Session.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(Session.Event.Updated, () => {
          events.push("updated")
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await Session.remove(session.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const messageID = MessageID.ascending()
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: session.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await Session.updatePart(partInput)

          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await Session.remove(session.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("session tree IDs", () => {
  test("new root sessions get a treeID and forked children inherit it", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await Session.create({ title: "Root" })
        const userMessageID = MessageID.ascending()
        await Session.updateMessage({
          id: userMessageID,
          sessionID: root.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMessageID,
          sessionID: root.id,
          type: "text",
          text: "Root prompt",
        })
        await Session.updateMessage({
          id: MessageID.ascending(),
          sessionID: root.id,
          role: "assistant",
          parentID: userMessageID,
          time: { created: Date.now(), completed: Date.now() },
          providerID: "test",
          modelID: "test",
          mode: "build",
          agent: "assistant",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as unknown as MessageV2.Info)

        const child = await Session.fork({ sessionID: root.id, messageID: userMessageID })

        expect(root.treeID).toBeDefined()
        expect(child.treeID).toBe(root.treeID)
        expect(child.parentID).toBe(root.id)
        expect(child.forkParentSessionID).toBe(root.id)
        expect(child.forkAfterUserMessageID).toBeUndefined()
      },
    })
  })

  test("forking a legacy session creates a new tree root on the child", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const legacy = await Session.create({ title: "Legacy" })
        Database.use((db) =>
          db.update(SessionTable).set({ tree_id: null }).where(eq(SessionTable.id, legacy.id)).run(),
        )

        const refreshedLegacy = await Session.get(legacy.id)
        const child = await Session.fork({ sessionID: refreshedLegacy.id })

        expect(refreshedLegacy.treeID).toBeUndefined()
        expect(child.treeID).toBeDefined()
        expect(child.parentID).toBe(refreshedLegacy.id)
        expect(child.forkParentSessionID).toBe(refreshedLegacy.id)
        expect(child.treeID).not.toBe(refreshedLegacy.treeID)
      },
    })
  })
})
