import { expect, test } from "bun:test"
import z from "zod"
import { NativeTree } from "../../src/native/tree"

function scenario() {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const events: { method: string; params: Record<string, unknown> }[] = []
  const metadata = (id: string, parent: string | null = null, status = "active") => ({
    id,
    parentThreadId: parent,
    sessionId: "session",
    agentNickname: id,
    status: { type: status },
    turns: [],
  })
  const records = new Map([
    ["root", metadata("root")],
    ["child", metadata("child", "root")],
    ["foreign", metadata("foreign")],
  ])
  const hooks = {
    read: undefined as (() => Promise<unknown>) | undefined,
    start: undefined as (() => Promise<unknown>) | undefined,
  }
  const tree = NativeTree.create({
    request: async (method, value) => {
      const params = z.record(z.string(), z.unknown()).parse(value)
      calls.push({ method, params })
      if (method === "thread/read") {
        if (hooks.read) return hooks.read()
        return { thread: structuredClone(records.get(String(params.threadId))) }
      }
      if (method === "thread/resume") return { thread: metadata(String(params.threadId), "root", "idle") }
      if (method === "turn/steer") return { turnId: "child-turn" }
      if (method === "turn/start") return hooks.start ? hooks.start() : { turn: { id: "child-next" } }
      if (method === "turn/interrupt") return {}
      if (method === "thread/loaded/list") return { data: [], nextCursor: null }
      throw new Error(`Unexpected method ${method}`)
    },
    emit: (method, value) => {
      events.push({ method, params: z.record(z.string(), z.unknown()).parse(value) })
    },
    fail: (error) => {
      throw error
    },
  })
  const start = async () => {
    tree.registerRoot(records.get("root"))
    tree.activate()
    tree.bindTurn("root-turn")
    await tree.notification("thread/started", { thread: records.get("child") })
    await tree.notification("turn/started", { threadId: "child", turn: { id: "child-turn" } })
  }
  const idle = async () => {
    records.set("child", metadata("child", "root", "idle"))
    await tree.notification("turn/completed", {
      threadId: "child",
      turn: { id: "child-turn", status: "completed", items: [] },
    })
  }
  return { tree, calls, events, hooks, records, metadata, start, idle, [Symbol.dispose]: () => tree.close() }
}

test("child async items retain the raw question identity and replies target the child turn", async () => {
  using run = scenario()
  await run.start()
  await run.tree.notification("item/completed", {
    threadId: "child",
    turnId: "child-turn",
    item: {
      id: "original-question",
      type: "agentMessage",
      delivery: "async",
      text: "Choose",
      questions: [{ title: "Which?", options: ["A", "B"] }],
    },
  })
  const event = run.events.find(
    (event) =>
      z.object({ item: z.object({ type: z.string() }) }).safeParse(event.params).data?.item.type === "agentMessage",
  )!
  expect(event.params.nativeAgent).toMatchObject({
    threadId: "child",
    turnId: "child-turn",
    itemId: "original-question",
  })
  expect(z.object({ item: z.object({ id: z.string() }) }).parse(event.params).item.id).not.toBe("original-question")
  await run.tree.reply({ thread: "child", text: "answer for child", id: "client-answer" })
  expect(run.calls.filter((call) => call.method === "turn/steer")).toEqual([
    {
      method: "turn/steer",
      params: {
        threadId: "child",
        expectedTurnId: "child-turn",
        clientUserMessageId: "client-answer",
        input: [{ type: "text", text: "answer for child", text_elements: [] }],
      },
    },
  ])
  await expect(run.tree.reply({ thread: "root", text: "wrong", id: "root-answer" })).rejects.toThrow("verified child")
  await expect(run.tree.reply({ thread: "foreign", text: "wrong", id: "foreign-answer" })).rejects.toThrow(
    "verified child",
  )
  expect(run.calls.filter((call) => call.method === "turn/start")).toHaveLength(0)
})

test("an idle child answer starts only the verified child with the owning root turn", async () => {
  using run = scenario()
  await run.start()
  await run.idle()
  await run.tree.reply({ thread: "child", text: "continue child", id: "next-answer" })
  expect(run.calls.filter((call) => call.method === "turn/start")).toEqual([
    {
      method: "turn/start",
      params: {
        threadId: "child",
        clientUserMessageId: "next-answer",
        input: [{ type: "text", text: "continue child", text_elements: [] }],
        parentTurnId: "root-turn",
        rootTurnId: "root-turn",
      },
    },
  ])
  expect(run.tree.active()).toContainEqual({ threadId: "child", turnId: "child-next" })
})

test("a child completion before the answer acknowledgement keeps its final status", async () => {
  using run = scenario()
  await run.start()
  await run.idle()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<unknown>()
  run.hooks.start = () => {
    entered.resolve()
    return gate.promise
  }
  const pending = run.tree.reply({ thread: "child", text: "quick child answer", id: "quick" })
  await entered.promise
  await run.tree.notification("turn/started", { threadId: "child", turn: { id: "child-next" } })
  await run.tree.notification("turn/completed", {
    threadId: "child",
    turn: { id: "child-next", status: "completed", items: [] },
  })
  gate.resolve({ turn: { id: "child-next" } })
  await pending
  expect(run.tree.active()).toHaveLength(1)
  expect(run.tree.active()[0].threadId).toBe("root")
  expect(run.events.at(-1)).toMatchObject({
    method: "item/completed",
    params: { nativeAgent: { threadId: "child", turnId: "child-next" }, item: { status: "completed" } },
  })
})

test("stopping while the child state is being read prevents a late answer turn", async () => {
  using run = scenario()
  await run.start()
  await run.idle()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<unknown>()
  run.hooks.read = () => {
    entered.resolve()
    return gate.promise
  }
  const pending = run.tree.reply({ thread: "child", text: "late answer", id: "late" }).catch((err: unknown) => err)
  await entered.promise
  await run.tree.interrupt()
  gate.resolve({ thread: run.metadata("child", "root", "idle") })
  const failure = await pending
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error ? failure.message : "").toContain("parent task has finished")
  expect(run.calls.filter((call) => ["turn/start", "turn/steer"].includes(call.method))).toHaveLength(0)
})

test("two question answers cannot start overlapping turns on the same child", async () => {
  using run = scenario()
  await run.start()
  await run.idle()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<unknown>()
  run.hooks.read = () => {
    entered.resolve()
    return gate.promise
  }
  const first = run.tree.reply({ thread: "child", text: "first", id: "first" })
  await entered.promise
  await expect(run.tree.reply({ thread: "child", text: "second", id: "second" })).rejects.toThrow("Another answer")
  gate.resolve({ thread: run.metadata("child", "root", "idle") })
  await first
  expect(run.calls.filter((call) => call.method === "turn/start")).toHaveLength(1)
})

test("a delayed idle read cannot overwrite a child turn that started meanwhile", async () => {
  using run = scenario()
  await run.start()
  await run.idle()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<unknown>()
  run.hooks.read = () => {
    entered.resolve()
    return gate.promise
  }
  const pending = run.tree.reply({ thread: "child", text: "stale", id: "stale" }).catch((err: unknown) => err)
  await entered.promise
  await run.tree.notification("turn/started", { threadId: "child", turn: { id: "already-running" } })
  gate.resolve({ thread: run.metadata("child", "root", "idle") })
  const failure = await pending
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error ? failure.message : "").toContain("changed before submission")
  expect(run.tree.active()).toContainEqual({ threadId: "child", turnId: "already-running" })
  expect(run.calls.filter((call) => call.method === "turn/start")).toHaveLength(0)
})
