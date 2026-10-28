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
  state?: "pending" | "interrupted"
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
  if (input.state === "pending") return userMessageID

  await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "assistant",
    parentID: userMessageID,
    time: { created: input.time + 1, completed: input.time + 2 },
    ...(input.state === "interrupted" ? { error: new MessageV2.AbortedError({ message: "Stopped" }).toObject() } : {}),
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
  test("returns a stable empty graph for a native session without a stored tree", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        Database.useProject(session.projectID, (db) =>
          db.update(SessionTable).set({ tree_id: null }).where(eq(SessionTable.id, session.id)).run(),
        )
        const app = Server.Default()
        const response = await app.request(`/session/${session.id}/graph`)
        expect(response.status).toBe(200)
        const graph = Session.GraphResult.parse(await response.json())
        expect(graph.kind).toBe("graph")
        if (graph.kind !== "graph") throw new Error("Expected native graph")
        expect(graph.nodes).toEqual([])
        expect(graph.edges).toEqual([])
        expect(graph.current.pathNodeIDs).toEqual([])
        expect(await Session.graph(session.id)).toEqual(graph)
        expect((await Session.get(session.id)).treeID).toBeUndefined()
      },
    })
  })

  test("keeps native fork history local even when old records share a tree and parent", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const source = await Session.create({ engine: { type: "codex" } })
        const anchor = await addTurn({ sessionID: source.id, text: "Inherited", time: 10 })
        await addTurn({ sessionID: source.id, text: "Source only", time: 20 })
        const fork = await Session.createNext({
          directory: source.directory,
          engine: { type: "codex" },
          parentID: source.id,
          treeID: source.treeID,
          forkParentSessionID: source.id,
          forkAfterUserMessageID: anchor,
        })
        const inherited = await addTurn({ sessionID: fork.id, text: "Inherited", time: 10 })
        const own = await addTurn({ sessionID: fork.id, text: "Fork only", time: 30 })
        const sibling = await Session.createNext({
          directory: source.directory,
          engine: { type: "codex" },
          treeID: source.treeID,
          forkParentSessionID: source.id,
          forkAfterUserMessageID: anchor,
        })
        await addTurn({ sessionID: sibling.id, text: "Sibling only", time: 40 })
        const row = () =>
          Database.useProject(source.projectID, (db) =>
            db.select().from(SessionTable).where(eq(SessionTable.id, fork.id)).get(),
          )
        const before = row()
        const graph = await Session.graph(fork.id)
        expect(graph.kind).toBe("graph")
        if (graph.kind !== "graph") throw new Error("Expected native graph")
        expect(graph.nodes.map((node) => [node.sessionID, node.userMessageID, node.label, node.lane])).toEqual([
          [fork.id, inherited, "Inherited", 0],
          [fork.id, own, "Fork only", 0],
        ])
        expect(graph.edges.map((edge) => edge.kind)).toEqual(["continuation"])
        expect(graph.current.pathNodeIDs).toEqual(graph.nodes.map((node) => node.id))
        expect(graph.current.targetNodeID).toBe(graph.nodes[1].id)
        expect(row()).toEqual(before)
        const origin = await Session.graph(source.id)
        expect(origin.kind).toBe("graph")
        if (origin.kind !== "graph") throw new Error("Expected source graph")
        expect(origin.treeID).not.toBe(graph.treeID)
        expect(origin.nodes.map((node) => node.label)).toEqual(["Inherited", "Source only"])
      },
    })
  })

  test("native navigation follows message chronology and includes stopped and unanswered messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        const stopped = await addTurn({ sessionID: session.id, text: "Stopped", time: 20.5, state: "interrupted" })
        const first = await addTurn({ sessionID: session.id, text: "First", time: 10.5 })
        const pending = await addTurn({ sessionID: session.id, text: "Unanswered", time: 30.5, state: "pending" })
        const graph = await Session.graph(session.id)
        expect(graph.kind).toBe("graph")
        if (graph.kind !== "graph") throw new Error("Expected native graph")
        expect(graph.nodes.map((node) => [node.userMessageID, node.row])).toEqual([
          [first, 0],
          [stopped, 1],
          [pending, 2],
        ])
        expect(graph.edges.map((edge) => [edge.from, edge.to])).toEqual([
          [graph.nodes[0].id, graph.nodes[1].id],
          [graph.nodes[1].id, graph.nodes[2].id],
        ])
        await Session.removeMessage({ sessionID: session.id, messageID: pending })
        const updated = await Session.graph(session.id)
        expect(updated.kind).toBe("graph")
        if (updated.kind !== "graph") throw new Error("Expected native graph")
        expect(updated.nodes.map((node) => node.userMessageID)).toEqual([first, stopped])
        expect(updated.current.latestNodeID).toBe(graph.nodes[1].id)
        expect(updated.edges).toHaveLength(1)
      },
    })
  })

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
              edge.kind === "branch" && edge.style === "dashed" && edge.to.startsWith(`turn:${child.id}:`),
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

        Database.useProject(legacy.projectID, (db) =>
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
