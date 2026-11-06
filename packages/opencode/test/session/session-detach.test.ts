import { describe, expect, spyOn, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq, NotFoundError } from "../../src/storage/db"
import { Lock } from "../../src/util/lock"
import { tmpdir } from "../fixture/fixture"

async function scope(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn })
}

async function turn(sessionID: SessionID, text: string) {
  const id = MessageID.ascending()
  const time = Date.now()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: time },
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  })
  await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text })
  await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    parentID: id,
    time: { created: time + 1, completed: time + 2 },
    providerID: ProviderID.make("test"),
    modelID: ModelID.make("test"),
    agent: "build",
    mode: "build",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return id
}

describe("independent session forks", () => {
  test("creates an independent root with copied history and a linear graph", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      await turn(root.id, "first")
      const next = await turn(root.id, "second")
      const child = await Session.fork({ sessionID: root.id, messageID: next, detached: true })
      expect(child.parentID).toBeUndefined()
      expect(child.forkParentSessionID).toBeUndefined()
      expect(child.forkAfterUserMessageID).toBeUndefined()
      expect(child.treeID).not.toBe(root.treeID)
      const messages = await Session.messages({ sessionID: child.id })
      expect(messages).toHaveLength(2)
      expect(messages[0].info.sessionID).toBe(child.id)
      expect(messages[0].parts[0]).toMatchObject({ type: "text", text: "first" })
      expect(messages[1].info.role).toBe("assistant")
      if (messages[1].info.role === "assistant") expect(messages[1].info.parentID).toBe(messages[0].info.id)
      await turn(child.id, "own")
      const graph = await Session.graph(child.id)
      expect(graph.kind).toBe("graph")
      if (graph.kind !== "graph") throw new Error("Expected graph")
      expect(graph.nodes.map((node) => node.label)).toEqual(["first", "own"])
      expect(graph.nodes.every((node) => node.sessionID === child.id && node.lane === 0)).toBe(true)
      expect(graph.edges.map((edge) => edge.kind)).toEqual(["continuation"])
      const tree = await Session.tree(root.id)
      expect(tree.kind).toBe("tree")
      if (tree.kind === "tree") expect(tree.sessions.map((session) => session.id)).toEqual([root.id])
    }))

  test("keeps grouped forks as the default", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      expect(child.parentID).toBe(root.id)
      expect(child.treeID).toBe(root.treeID)
      expect(child.forkParentSessionID).toBe(root.id)
    }))

  test("survives source archive and deletion with its history intact", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      await turn(root.id, "retained")
      const child = await Session.fork({ sessionID: root.id, detached: true })
      const messages = await Session.messages({ sessionID: child.id })
      await Session.archive(root.id)
      expect((await Session.get(child.id)).time.archived).toBeUndefined()
      await Session.remove(root.id)
      expect(await Session.messages({ sessionID: child.id })).toEqual(messages)
      expect((await Session.graph(child.id)).kind).toBe("graph")
    }))

  test("skips occupied independent and archived titles during concurrent forks", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      await Session.create({ title: "Root (fork #1)" })
      const archived = await Session.create({ title: "Root (fork #2)" })
      await Session.archive(archived.id)
      const children = await Promise.all(
        Array.from({ length: 4 }, () => Session.fork({ sessionID: root.id, detached: true })),
      )
      expect(children.map((child) => child.title).sort()).toEqual([
        "Root (fork #3)",
        "Root (fork #4)",
        "Root (fork #5)",
        "Root (fork #6)",
      ])
      expect(new Set(children.map((child) => child.treeID)).size).toBe(4)
    }))
})

describe("session.detach", () => {
  test("moves the complete subtree and hidden subagents without changing messages or archive state", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      await turn(root.id, "shared")
      const child = await Session.fork({ sessionID: root.id })
      await turn(child.id, "child")
      const leaf = await Session.fork({ sessionID: child.id })
      const worker = await Session.create({ parentID: child.id, title: "worker" })
      const before = await Session.messages({ sessionID: child.id })
      const detached = await Session.detach(child.id)
      expect(detached.treeID).not.toBe(root.treeID)
      expect(detached.parentID).toBeUndefined()
      expect(detached.forkParentSessionID).toBeUndefined()
      expect(detached.forkAfterUserMessageID).toBeUndefined()
      expect(detached.time.archived).toBeUndefined()
      expect(detached.title).toBe(child.title)
      expect(await Session.messages({ sessionID: child.id })).toEqual(before)
      expect(await Session.get(leaf.id)).toMatchObject({
        treeID: detached.treeID,
        parentID: child.id,
        forkParentSessionID: child.id,
      })
      expect(await Session.get(worker.id)).toMatchObject({ treeID: detached.treeID, parentID: child.id })
      const tree = await Session.tree(child.id)
      expect(tree.kind).toBe("tree")
      if (tree.kind === "tree")
        expect(tree.sessions.map((session) => session.id).sort()).toEqual([child.id, leaf.id].sort())
      await Session.archive(root.id)
      expect((await Session.get(child.id)).time.archived).toBeUndefined()
      expect((await Session.get(leaf.id)).time.archived).toBeUndefined()
      await Session.remove(root.id)
      expect((await Session.get(child.id)).treeID).toBe(detached.treeID)
      const next = await Session.fork({ sessionID: child.id, messageID: before[0].info.id })
      expect(next.parentID).toBe(child.id)
      expect(next.treeID).toBe(detached.treeID)
    }))

  test("is idempotent for independent roots and rejects task subagents", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const worker = await Session.create({ parentID: child.id, title: "worker" })
      await expect(Session.detach(worker.id)).rejects.toThrow()
      expect(await Session.detach(root.id)).toEqual(root)
      const detached = await Session.detach(child.id)
      expect(await Session.detach(child.id)).toEqual(detached)
    }))

  test("rolls back the whole subtree and emits no updates if a row update fails", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const worker = await Session.create({ parentID: child.id, title: "worker" })
      const events: string[] = []
      const off = Bus.subscribe(Session.Event.Updated, (event) => events.push(event.properties.sessionID))
      const db = Database.projectClient(root.projectID).$client
      db.exec(
        `CREATE TEMP TRIGGER fail_detach BEFORE UPDATE OF tree_id ON session WHEN OLD.id = '${worker.id}' BEGIN SELECT RAISE(ABORT, 'forced detach failure'); END`,
      )
      try {
        await expect(Session.detach(child.id)).rejects.toThrow("forced detach failure")
        expect(await Session.get(child.id)).toEqual(child)
        expect(await Session.get(worker.id)).toEqual(worker)
        expect(events).toEqual([])
      } finally {
        db.exec("DROP TRIGGER fail_detach")
        off()
      }
    }))

  test("rejects busy and retry descendants, including hidden subagents", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const worker = await Session.create({ parentID: child.id, title: "worker" })
      try {
        await SessionStatus.set(worker.id, { type: "busy" })
        await expect(Session.detach(child.id)).rejects.toBeInstanceOf(Session.BusyError)
        await SessionStatus.set(worker.id, { type: "retry", attempt: 1, message: "wait", next: Date.now() + 60000 })
        await expect(Session.detach(child.id)).rejects.toBeInstanceOf(Session.BusyError)
        expect(await Session.get(child.id)).toEqual(child)
      } finally {
        await SessionStatus.set(worker.id, { type: "idle" })
      }
    }))

  test("checks the directory owning a descendant instead of only the request directory", () =>
    scope(async () => {
      await using tmp = await tmpdir({ git: true })
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const context = { directory: tmp.path, project: Instance.project, worktree: tmp.path }
      const worker = await Instance.provide({
        ...context,
        fn: () => Session.create({ parentID: child.id, title: "worker" }),
      })
      await Instance.provide({ ...context, fn: () => SessionStatus.set(worker.id, { type: "busy" }) })
      try {
        await expect(Session.detach(child.id)).rejects.toBeInstanceOf(Session.BusyError)
        expect(await Session.get(child.id)).toEqual(child)
      } finally {
        await Instance.provide({ ...context, fn: () => SessionStatus.set(worker.id, { type: "idle" }) })
      }
    }))

  test("rejects a pending permission request in the subtree", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const worker = await Session.create({ parentID: child.id, title: "worker" })
      const asked = Promise.withResolvers<Permission.Request>()
      const off = Bus.subscribe(Permission.Event.Asked, (event) => asked.resolve(event.properties))
      const pending = Permission.ask({
        sessionID: worker.id,
        permission: "edit",
        patterns: ["file"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "*", pattern: "*", action: "ask" }],
      })
      const request = await asked.promise
      try {
        await expect(Session.detach(child.id)).rejects.toBeInstanceOf(Session.BusyError)
        expect(await Session.get(child.id)).toEqual(child)
      } finally {
        await Permission.reply({ requestID: request.id, reply: "once" })
        await pending
        off()
      }
    }))

  test("rejects a pending question in the subtree", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const asked = Promise.withResolvers<Question.Request>()
      const off = Bus.subscribe(Question.Event.Asked, (event) => asked.resolve(event.properties))
      const pending = Question.ask({
        sessionID: child.id,
        questions: [{ header: "Choose", question: "Continue?", options: [] }],
      })
      const request = await asked.promise
      try {
        await expect(Session.detach(child.id)).rejects.toBeInstanceOf(Session.BusyError)
        expect(await Session.get(child.id)).toEqual(child)
      } finally {
        await Question.reply({ requestID: request.id, answers: [[]] })
        await pending
        off()
      }
    }))

  test("exposes detach through the session API and returns conflicts for busy subtrees", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const app = Server.Default()
      const url = `/session/${child.id}/detach?directory=${encodeURIComponent(Instance.directory)}`
      await SessionStatus.set(child.id, { type: "busy" })
      try {
        const response = await app.request(url, { method: "POST" })
        expect(response.status).toBe(409)
      } finally {
        await SessionStatus.set(child.id, { type: "idle" })
      }
      const response = await app.request(url, { method: "POST" })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ id: child.id })
      expect((await Session.get(child.id)).parentID).toBeUndefined()
    }))

  test("ignores a late parent repair and reads the new graph tree after detach", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      await turn(root.id, "shared")
      const parent = await Session.fork({ sessionID: root.id })
      await turn(parent.id, "parent")
      const child = await Session.fork({ sessionID: parent.id })
      const prefix = (await Session.messages({ sessionID: parent.id }))[0].info.id
      Database.useProject(root.projectID, (db) =>
        db.update(SessionTable).set({ fork_after_user_message_id: prefix }).where(eq(SessionTable.id, child.id)).run(),
      )
      const read = Session.messages
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const spy = spyOn(Session, "messages").mockImplementation(
        Object.assign(async (input: Parameters<typeof read>[0]) => {
          const result = await read(input)
          if (input.sessionID === parent.id) {
            entered.resolve()
            await release.promise
          }
          return result
        }, read),
      )
      const graph = Session.graph(child.id)
      try {
        await entered.promise
        const detached = await Session.detach(child.id)
        release.resolve()
        const result = await graph
        expect(result.kind).toBe("graph")
        if (result.kind === "graph") {
          expect(result.treeID).toBe(detached.treeID!)
          expect(result.nodes.every((node) => node.sessionID === child.id)).toBe(true)
        }
        expect((await Session.get(child.id)).parentID).toBeUndefined()
        expect((await Session.get(child.id)).forkParentSessionID).toBeUndefined()
      } finally {
        release.resolve()
        await graph
        spy.mockRestore()
      }
    }))

  test("serializes grouped forks with a concurrent detach", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const held = await Lock.write(`session.tree:${root.projectID}`)
      const detaching = Session.detach(child.id)
      const forking = Session.fork({ sessionID: child.id })
      held[Symbol.dispose]()
      const [detached, forked] = await Promise.all([detaching, forking])
      expect(forked.treeID).toBe(detached.treeID)
      expect(forked.parentID).toBe(child.id)
      expect((await Session.get(forked.id)).treeID).toBe((await Session.get(child.id)).treeID)
    }))

  test("does not report a successful detach during an older recursive deletion", () =>
    scope(async () => {
      const root = await Session.create({ title: "Root" })
      const child = await Session.fork({ sessionID: root.id })
      const read = Session.children
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const spy = spyOn(Session, "children").mockImplementation(
        Object.assign(async (id: Parameters<typeof read>[0]) => {
          const result = await read(id)
          if (id === root.id) {
            entered.resolve()
            await release.promise
          }
          return result
        }, read),
      )
      const deleting = Session.remove(root.id)
      try {
        await entered.promise
        const detaching = Session.detach(child.id).then(
          () => undefined,
          (err: unknown) => err,
        )
        release.resolve()
        await deleting
        expect(NotFoundError.isInstance(await detaching)).toBe(true)
      } finally {
        release.resolve()
        await deleting
        spy.mockRestore()
      }
    }))
})
