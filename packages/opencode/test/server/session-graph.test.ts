import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Database, eq } from "../../src/storage/db"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

async function addTurn(input: {
  sessionID: SessionID
  text: string
  time: number
  providerID?: string
  modelID?: string
  mode?: string
}) {
  const userMessageID = MessageID.ascending()
  await Session.updateMessage({
    id: userMessageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.time },
    agent: "user",
    model: { providerID: input.providerID ?? "provider", modelID: input.modelID ?? "model-a" },
    tools: {},
    mode: input.mode ?? "build",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: userMessageID,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
  })

  await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "assistant",
    parentID: userMessageID,
    time: { created: input.time + 1, completed: input.time + 2 },
    providerID: input.providerID ?? "provider",
    modelID: input.modelID ?? "model-a",
    mode: input.mode ?? "build",
    agent: "assistant",
    path: { cwd: projectRoot, root: projectRoot },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)

  return userMessageID
}

describe("session.graph endpoint", () => {
  test("returns an empty graph until the first completed turn exists", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({ title: "Root" })
        const app = Server.Default()

        const response = await app.request(`/session/${session.id}/graph`)
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.kind).toBe("graph")
        expect(body.nodes).toHaveLength(0)
        expect(body.edges).toHaveLength(0)
        expect(body.current.pathNodeIDs).toEqual([])
      },
    })
  })

  test("builds a linear message graph from completed turns", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({ title: "Linear" })
        await addTurn({ sessionID: session.id, text: "你好", time: 10 })
        await addTurn({ sessionID: session.id, text: "你叫什么名字", time: 20 })

        const app = Server.Default()
        const response = await app.request(`/session/${session.id}/graph`)
        const body = await response.json()

        expect(body.kind).toBe("graph")
        expect(body.nodes.map((node: { kind: string; label: string }) => [node.kind, node.label])).toEqual([
          ["turn", "你好"],
          ["turn", "你叫什么名字"],
        ])
        expect(body.edges).toHaveLength(1)
        expect(body.edges[0].kind).toBe("continuation")
        expect(body.current.pathNodeIDs).toHaveLength(2)
      },
    })
  })

  test("shows a bud before the forked branch has its first completed turn", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await Session.create({ title: "Root" })
        const user1 = await addTurn({ sessionID: root.id, text: "你好", time: 10, modelID: "model-a" })
        const user2 = await addTurn({ sessionID: root.id, text: "你叫什么名字", time: 20, modelID: "model-a" })
        const child = await Session.fork({ sessionID: root.id, messageID: user2 })

        const app = Server.Default()
        const response = await app.request(`/session/${child.id}/graph`)
        const body = await response.json()

        expect(body.kind).toBe("graph")
        expect(body.nodes.map((node: { kind: string; label: string }) => [node.kind, node.label])).toEqual([
          ["turn", "你好"],
          ["turn", "你叫什么名字"],
          ["bud", ""],
        ])
        expect(body.edges.map((edge: { kind: string }) => edge.kind)).toEqual(["continuation", "bud"])
        expect(body.current.pathNodeIDs).toEqual([`turn:${root.id}:${user1}`, `bud:${child.id}`])
        expect(body.current.targetNodeID).toBe(`bud:${child.id}`)
      },
    })
  })

  test("replaces a bud with the first completed branch turn and marks model changes with dashed edges", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await Session.create({ title: "Root" })
        const user1 = await addTurn({ sessionID: root.id, text: "你好", time: 10, modelID: "model-a" })
        const user2 = await addTurn({ sessionID: root.id, text: "你叫什么名字", time: 20, modelID: "model-a" })
        const child = await Session.fork({ sessionID: root.id, messageID: user2 })

        await addTurn({ sessionID: child.id, text: "我在浙江，今天天气如何", time: 30, modelID: "model-b" })

        const app = Server.Default()
        const response = await app.request(`/session/${child.id}/graph`)
        const body = await response.json()

        expect(body.kind).toBe("graph")
        expect(body.nodes.map((node: { kind: string; label: string }) => [node.kind, node.label])).toEqual([
          ["turn", "你好"],
          ["turn", "你叫什么名字"],
          ["turn", "我在浙江，今天天气如何"],
        ])
        expect(
          body.edges.some(
            (edge: { kind: string; style: string; to: string }) =>
              edge.kind === "branch" &&
              edge.style === "dashed" &&
              edge.to.startsWith(`turn:${child.id}:`),
          ),
        ).toBe(true)
        expect(body.current.targetNodeID?.startsWith(`turn:${child.id}:`)).toBe(true)
        expect(body.current.latestNodeID?.startsWith(`turn:${child.id}:`)).toBe(true)
        expect(body.current.pathNodeIDs).toEqual([`turn:${root.id}:${user1}`, body.current.targetNodeID])
      },
    })
  })

  test("returns legacy for old sessions but allows legacy forks to start a new graph tree", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const legacy = await Session.create({ title: "Legacy" })
        const user1 = await addTurn({ sessionID: legacy.id, text: "你好", time: 10 })
        const user2 = await addTurn({ sessionID: legacy.id, text: "介绍一下你自己", time: 20 })

        Database.use((db) =>
          db.update(SessionTable).set({ tree_id: null }).where(eq(SessionTable.id, legacy.id)).run(),
        )

        const app = Server.Default()
        const legacyResponse = await app.request(`/session/${legacy.id}/graph`)
        const legacyBody = await legacyResponse.json()
        expect(legacyBody.kind).toBe("legacy")

        const child = await Session.fork({ sessionID: legacy.id, messageID: user2 })
        const childResponse = await app.request(`/session/${child.id}/graph`)
        const childBody = await childResponse.json()

        expect(childBody.kind).toBe("graph")
        expect(childBody.nodes.map((node: { kind: string; label: string }) => [node.kind, node.label])).toEqual([
          ["turn", "你好"],
          ["bud", ""],
        ])
        expect(childBody.current.pathNodeIDs).toEqual([`turn:${legacy.id}:${user1}`, `bud:${child.id}`])
      },
    })
  })
})
