import { expect, test } from "bun:test"
import path from "node:path"
import { NativeTree } from "../../src/native/tree"
import { Protocol } from "../../src/native/protocol"

function scenario(
  handler: (method: string, params: unknown) => Promise<unknown> = async () => ({ decision: "decline" }),
) {
  const events: { method: string; params: Record<string, unknown> }[] = []
  const failed = Promise.withResolvers<Error>()
  const finished = Promise.withResolvers<void>()
  const connection = {} as { client: Protocol.Client }
  const tree = NativeTree.create({
    request: (method, params) => connection.client.request(method, params),
    drain: () => connection.client.drain(),
    emit: (method, params) => {
      events.push({ method, params: params as Record<string, unknown> })
      if (method === "turn/completed") finished.resolve()
    },
    fail: (error) => {
      failed.resolve(error)
    },
  })
  connection.client = Protocol.connect({
    executable: process.execPath,
    args: [path.join(import.meta.dir, "tree-fixture.ts")],
    onNotification: tree.notification,
    onRequest: async (method, params) => {
      await connection.client.drain()
      return tree.request(method, params, handler)
    },
  })
  const client = connection.client
  const metadata = (id: string, parentThreadId: string | null = null, status = "active", sessionId = "session") => ({
    id,
    parentThreadId,
    sessionId,
    agentNickname: id,
    status: { type: status },
    turns: [],
  })
  const setup = async (session = "session") => {
    const root = metadata("root", null, "active", session)
    await client.request("fixture/thread", root)
    tree.registerRoot(root)
    tree.activate()
    tree.bindTurn("root-turn")
  }
  const emit = async (method: string, params: unknown) => {
    await client.request("fixture/emit", { method, params })
    await client.drain()
  }
  const start = async (id: string, parent: string) => {
    const thread = metadata(id, parent)
    await client.request("fixture/thread", thread)
    await emit("thread/started", { thread })
    await emit("turn/started", { threadId: id, turn: { id: `${id}-turn` } })
  }
  const end = (id: string, status = "completed") =>
    emit("turn/completed", { threadId: id, turn: { id: `${id}-turn`, status, items: [], error: null } })
  return {
    tree,
    client,
    events,
    failed: failed.promise,
    finished: finished.promise,
    metadata,
    setup,
    emit,
    start,
    end,
    [Symbol.asyncDispose]: async () => {
      tree.close()
      await client.close()
    },
  }
}

test("parent completion drains verified children, grandchildren, and their original approval replies", async () => {
  const answer = Promise.withResolvers<unknown>()
  const asked = Promise.withResolvers<Record<string, unknown>>()
  await using run = scenario(async (_method, value) => {
    asked.resolve(value as Record<string, unknown>)
    return answer.promise
  })
  await run.setup()
  await run.start("child", "root")
  await run.start("grandchild", "child")
  await run.emit("item/completed", {
    threadId: "root",
    turnId: "root-turn",
    item: {
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
    },
  })
  await run.end("root")
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  for (const id of ["root", "child", "grandchild"]) {
    await run.emit("item/agentMessage/delta", { threadId: id, turnId: `${id}-turn`, itemId: "same", delta: id })
  }
  const output = run.events.filter((event) => event.method === "item/agentMessage/delta")
  expect(new Set(output.map((event) => event.params.itemId)).size).toBe(3)
  expect(output[1].params.nativeAgent).toMatchObject({ threadId: "child", parentThreadId: "root", name: "child" })
  const request = run.client.request<{ decision: string }>("fixture/ask", {
    method: "item/commandExecution/requestApproval",
    params: { threadId: "grandchild", turnId: "grandchild-turn", itemId: "same", command: "echo safe" },
  })
  const prompt = await asked.promise
  expect(prompt.nativeAgent).toMatchObject({ threadId: "grandchild" })
  expect(prompt.itemId).not.toBe("same")
  await run.end("child")
  await run.end("grandchild")
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  answer.resolve({ decision: "decline" })
  expect(await request).toEqual({ decision: "decline" })
  await run.finished
  expect(run.events.filter((event) => event.method === "turn/completed")).toHaveLength(1)
})

test("unrelated thread requests and inconsistent session ancestry cannot gain approval", async () => {
  let calls = 0
  await using run = scenario(async () => {
    calls++
    return { decision: "accept" }
  })
  await run.setup()
  await run.client.request("fixture/thread", run.metadata("foreign"))
  await run.client.request("fixture/thread", run.metadata("wrong-session", "root", "active", "other-session"))
  for (const id of ["foreign", "wrong-session"]) {
    await run.emit("thread/started", {
      thread: run.metadata(id, id === "foreign" ? null : "root", "active", "other-session"),
    })
    const error = await run.client
      .request("fixture/ask", {
        method: "item/commandExecution/requestApproval",
        params: { threadId: id, turnId: `${id}-turn`, itemId: "tool" },
      })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Protocol.RpcError)
    expect(error instanceof Protocol.RpcError ? error.code : undefined).toBe(-32602)
  }
  await run.emit("item/agentMessage/delta", {
    threadId: "missing-foreign",
    turnId: "old",
    itemId: "same",
    delta: "ignored",
  })
  expect(calls).toBe(0)
  expect(run.events).toHaveLength(0)
  await run.end("root")
  await run.finished
})

test("cancellation interrupts every known active descendant and rejects late approval requests", async () => {
  await using run = scenario()
  await run.setup()
  await run.start("child", "root")
  await run.start("grandchild", "child")
  await run.tree.interrupt()
  const interrupted = await run.client.request<{ threadId: string; turnId: string }[]>("fixture/interrupts")
  expect(interrupted.map((item) => item.threadId).sort()).toEqual(["child", "grandchild", "root"])
  const error = await run.client
    .request("fixture/ask", {
      method: "item/tool/requestUserInput",
      params: { threadId: "child", turnId: "child-turn", questions: [] },
    })
    .catch((error: unknown) => error)
  expect(error instanceof Error ? error.message : undefined).toContain("no longer active")
  await run.end("child")
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
})

test("loaded-thread reconciliation discovers a child even when its start event was lost", async () => {
  await using run = scenario()
  await run.setup()
  await run.client.request("fixture/thread", run.metadata("child", "root"))
  await run.end("root")
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  await run.emit("turn/started", { threadId: "child", turn: { id: "child-turn" } })
  await run.emit("item/agentMessage/delta", {
    threadId: "child",
    turnId: "child-turn",
    itemId: "answer",
    delta: "late child result",
  })
  await run.end("child")
  await run.finished
  expect(run.events.some((event) => event.params.delta === "late child result")).toBe(true)
})

test("a lost child completion is recovered from native history instead of a quiet-success timeout", async () => {
  await using run = scenario()
  await run.setup()
  await run.start("child", "root")
  await run.end("root")
  await run.client.request("fixture/thread", {
    ...run.metadata("child", "root", "idle"),
    turns: [
      {
        id: "child-turn",
        status: "completed",
        items: [{ id: "answer", type: "agentMessage", text: "Recovered result" }],
      },
    ],
  })
  await run.emit("thread/status/changed", { threadId: "child", status: { type: "idle" } })
  await run.finished
  expect(
    run.events.some((event) => (event.params.item as { text?: string } | undefined)?.text === "Recovered result"),
  ).toBe(true)
})

test("missing terminal history fails visibly and never reports the tree completed", async () => {
  await using run = scenario()
  await run.setup()
  await run.start("child", "root")
  await run.end("root")
  await run.client.request("fixture/thread", run.metadata("child", "root", "idle"))
  await run.emit("thread/status/changed", { threadId: "child", status: { type: "idle" } })
  expect((await run.failed).message).toContain("Cannot confirm")
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
})

test("missing turn-start notifications recover native turn identity for approvals and cancellation", async () => {
  const asked: Record<string, unknown>[] = []
  await using run = scenario(async (_method, value) => {
    asked.push(value as Record<string, unknown>)
    return { decision: "decline" }
  })
  await run.setup()
  const thread = {
    ...run.metadata("child", "root"),
    turns: [{ id: "recovered-turn", status: "inProgress", items: [] }],
  }
  await run.client.request("fixture/thread", thread)
  await run.emit("thread/started", { thread: { ...thread, turns: [] } })
  const answer = await run.client.request<{ decision: string }>("fixture/ask", {
    method: "item/commandExecution/requestApproval",
    params: { threadId: "child", turnId: "recovered-turn", itemId: "tool" },
  })
  expect(answer).toEqual({ decision: "decline" })
  expect(asked[0].nativeAgent).toMatchObject({ threadId: "child", turnId: "recovered-turn" })
  const grandchild = {
    ...run.metadata("grandchild", "child"),
    turns: [{ id: "unannounced-turn", status: "inProgress", items: [] }],
  }
  await run.client.request("fixture/thread", grandchild)
  await run.emit("thread/started", { thread: { ...grandchild, turns: [] } })
  await run.tree.interrupt()
  const interrupted = await run.client.request<{ threadId: string; turnId: string }[]>("fixture/interrupts")
  expect(interrupted).toContainEqual({ threadId: "grandchild", turnId: "unannounced-turn" })
  expect(interrupted).toContainEqual({ threadId: "child", turnId: "recovered-turn" })
})

test("a completed agent can be driven again without confusing a stale prior completion", async () => {
  await using run = scenario()
  await run.setup()
  await run.start("child", "root")
  await run.end("child")
  await run.emit("item/completed", {
    threadId: "root",
    turnId: "root-turn",
    item: {
      id: "followup",
      type: "collabAgentToolCall",
      tool: "followupTask",
      status: "completed",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
    },
  })
  await run.emit("turn/started", { threadId: "child", turn: { id: "second-child-turn" } })
  await run.end("root")
  await run.end("child")
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  await run.emit("turn/completed", {
    threadId: "child",
    turn: { id: "second-child-turn", status: "completed", items: [] },
  })
  await run.finished
  expect(run.events.filter((event) => event.method === "turn/completed")).toHaveLength(1)
})

test("a delayed completion snapshot cannot finish a newer followup turn", async () => {
  await using run = scenario()
  await run.setup()
  await run.start("child", "root")
  const before = await run.client.request<number>("fixture/reads")
  await run.end("root")
  await run.client.request("fixture/thread", {
    ...run.metadata("child", "root", "idle"),
    delay: 250,
    turns: [{ id: "child-turn", status: "completed", items: [] }],
  })
  for (let index = 0; index < 200; index++) {
    if ((await run.client.request<number>("fixture/reads")) > before) break
    await Bun.sleep(20)
  }
  expect(await run.client.request<number>("fixture/reads")).toBeGreaterThan(before)
  await run.end("child")
  await run.emit("item/completed", {
    threadId: "root",
    turnId: "root-turn",
    item: {
      id: "followup",
      type: "collabAgentToolCall",
      tool: "followupTask",
      status: "completed",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
    },
  })
  await run.emit("turn/started", { threadId: "child", turn: { id: "new-turn" } })
  await run.client.request("fixture/thread", {
    ...run.metadata("child", "root"),
    turns: [{ id: "new-turn", status: "inProgress", items: [] }],
  })
  await Bun.sleep(350)
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  expect(run.tree.active()).toContainEqual({ threadId: "child", turnId: "new-turn" })
  await run.emit("turn/completed", { threadId: "child", turn: { id: "new-turn", status: "completed", items: [] } })
  await run.finished
})

test("real self-id session metadata is accepted only with a verified parent chain", async () => {
  let calls = 0
  await using run = scenario(async () => {
    calls++
    return { decision: "decline" }
  })
  await run.setup("root")
  for (const [id, ancestor] of [
    ["child", "root"],
    ["grandchild", "child"],
  ]) {
    const thread = {
      ...run.metadata(id, ancestor, "active", id),
      source: { subAgent: { thread_spawn: { parent_thread_id: ancestor, depth: id === "child" ? 1 : 2 } } },
    }
    await run.client.request("fixture/thread", thread)
    await run.emit("thread/started", { thread })
    await run.emit("turn/started", { threadId: id, turn: { id: `${id}-turn` } })
  }
  expect(
    await run.client.request<{ decision: string }>("fixture/ask", {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "grandchild", turnId: "grandchild-turn", itemId: "tool" },
    }),
  ).toEqual({ decision: "decline" })
  const foreign = run.metadata("foreign", null, "active", "foreign")
  await run.client.request("fixture/thread", foreign)
  await run.emit("thread/started", { thread: { ...foreign, parentThreadId: "root" } })
  const error = await run.client
    .request("fixture/ask", {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "foreign", turnId: "foreign-turn", itemId: "tool" },
    })
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Protocol.RpcError)
  expect(calls).toBe(1)
  await run.end("root")
  await run.end("child")
  await run.end("grandchild")
  await run.finished
})

test("loading or resuming an idle agent does not replay its old completed history", async () => {
  for (const resume of [false, true]) {
    await using run = scenario()
    await run.setup()
    const thread = {
      ...run.metadata("child", "root", "idle"),
      turns: [
        {
          id: "old-turn",
          rootTurnId: "previous-root-turn",
          status: "completed",
          items: [{ id: "old-output", type: "agentMessage", text: "OLD PRIVATE ANSWER" }],
        },
      ],
    }
    await run.client.request("fixture/thread", thread)
    await run.emit("thread/started", { thread })
    if (resume) {
      await run.emit("item/completed", {
        threadId: "root",
        turnId: "root-turn",
        item: {
          id: "resume",
          type: "collabAgentToolCall",
          tool: "resumeAgent",
          status: "completed",
          senderThreadId: "root",
          receiverThreadIds: ["child"],
        },
      })
    }
    await run.end("root")
    await run.finished
    expect(run.events.some((event) => event.params.nativeAgent)).toBe(false)
    expect(JSON.stringify(run.events)).not.toContain("OLD PRIVATE ANSWER")
  }
})

test("a driven agent cannot use an unrelated historical completion as its new result", async () => {
  await using run = scenario()
  await run.setup()
  const thread = {
    ...run.metadata("child", "root", "idle"),
    turns: [
      {
        id: "old-turn",
        rootTurnId: "previous-root-turn",
        status: "completed",
        items: [{ id: "old-output", type: "agentMessage", text: "OLD PRIVATE ANSWER" }],
      },
    ],
  }
  await run.client.request("fixture/thread", thread)
  await run.emit("item/completed", {
    threadId: "root",
    turnId: "root-turn",
    item: {
      id: "followup",
      type: "collabAgentToolCall",
      tool: "followupTask",
      status: "completed",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
    },
  })
  await run.end("root")
  await run.emit("thread/status/changed", { threadId: "child", status: { type: "idle" } })
  expect((await run.failed).message).toContain("Cannot confirm")
  expect(JSON.stringify(run.events)).not.toContain("OLD PRIVATE ANSWER")
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
})

test("a same-root followup cannot replay its already retired child turn", async () => {
  await using run = scenario()
  await run.setup()
  await run.start("child", "root")
  const first = {
    id: "child-turn",
    rootTurnId: "root-turn",
    status: "completed",
    items: [{ id: "first-output", type: "agentMessage", text: "FIRST CHILD RESULT" }],
  }
  await run.emit("turn/completed", { threadId: "child", turn: first })
  await run.client.request("fixture/thread", {
    ...run.metadata("child", "root", "idle"),
    turns: [
      {
        ...first,
        id: "earlier-unseen-turn",
        items: [{ id: "unseen-output", type: "agentMessage", text: "EVEN EARLIER RESULT" }],
      },
      first,
    ],
  })
  await run.emit("item/completed", {
    threadId: "root",
    turnId: "root-turn",
    item: {
      id: "again",
      type: "collabAgentToolCall",
      tool: "sendInput",
      status: "completed",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
    },
  })
  await run.end("root")
  await run.emit("thread/status/changed", { threadId: "child", status: { type: "idle" } })
  expect((await run.failed).message).toContain("Cannot confirm")
  expect(
    run.events.filter((event) => (event.params.item as { text?: string } | undefined)?.text === "FIRST CHILD RESULT"),
  ).toHaveLength(1)
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  expect(JSON.stringify(run.events)).not.toContain("EVEN EARLIER RESULT")
})

test("an active child without a materialized turn stays live without the unsupported list API", async () => {
  const questions: unknown[] = []
  await using run = scenario(async (_method, value) => {
    questions.push(value)
    return { decision: "decline" }
  })
  await run.setup()
  const child = run.metadata("child", "root")
  await run.client.request("fixture/thread", child)
  await run.emit("thread/started", { thread: child })
  await run.end("root")
  const error = await run.client
    .request("fixture/ask", {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "child", turnId: "unproven-turn", itemId: "tool" },
    })
    .catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Protocol.RpcError)
  expect(questions).toHaveLength(0)
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  expect(await run.client.request<number>("fixture/lists")).toBe(0)
  await run.client.request("fixture/thread", {
    ...child,
    turns: [{ id: "child-turn", rootTurnId: "root-turn", status: "inProgress", items: [] }],
  })
  await run.emit("turn/started", { threadId: "child", turn: { id: "child-turn" } })
  const answer = await run.client.request<{ decision: string }>("fixture/ask", {
    method: "item/commandExecution/requestApproval",
    params: { threadId: "child", turnId: "child-turn", itemId: "tool" },
  })
  expect(answer).toEqual({ decision: "decline" })
  await run.end("child")
  await run.finished
  expect(await run.client.request<number>("fixture/lists")).toBe(0)
})

test("newborn child metadata does not request unsupported history before turn-start arrives", async () => {
  await using run = scenario()
  await run.setup("root")
  await run.client.request("fixture/thread", {
    ...run.metadata("child", "root", "idle", "root"),
    historyUnsupported: true,
  })
  await run.emit("item/started", {
    threadId: "root",
    turnId: "root-turn",
    item: { id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" },
  })
  const before = await run.client.request<number>("fixture/reads")
  await run.emit("thread/status/changed", { threadId: "child", status: { type: "idle" } })
  await run.emit("thread/readState/changed", { threadId: "child", readState: "unread" })
  await run.emit("thread/name/updated", { threadId: "child", name: "Worker" })
  await run.emit("thread/tokenUsage/updated", { threadId: "child", turnId: "unknown-turn", tokenUsage: {} })
  expect(await run.client.request<number>("fixture/reads")).toBe(before)
  await run.emit("turn/started", { threadId: "child", turn: { id: "child-turn" } })
  await run.end("root")
  await run.end("child")
  await run.finished
})

test("parent-first completion preserves active children and queued idle-to-completed events without history", async () => {
  await using run = scenario()
  await run.setup("root")
  const child = { ...run.metadata("child", "root", "active", "root"), historyUnsupported: true }
  await run.client.request("fixture/thread", child)
  await run.emit("thread/started", { thread: child })
  await run.emit("turn/started", { threadId: "child", turn: { id: "child-turn" } })
  const before = await run.client.request<number>("fixture/reads")
  await run.end("root")
  for (let index = 0; index < 150; index++) {
    if ((await run.client.request<number>("fixture/reads")) > before) break
    await Bun.sleep(20)
  }
  await run.client.drain()
  expect(await run.client.request<number>("fixture/reads")).toBe(before + 1)
  expect(run.tree.active()).toContainEqual({ threadId: "child", turnId: "child-turn" })
  expect(run.events.some((event) => event.method === "turn/completed")).toBe(false)
  await run.client.request("fixture/thread", { ...child, status: { type: "idle" } })
  await run.emit("thread/status/changed", { threadId: "child", status: { type: "idle" } })
  await run.end("child")
  await run.finished
  expect(await run.client.request<number>("fixture/reads")).toBe(before + 1)
})

test("verified ancestry allows shared and self session IDs across loaded and unloaded metadata", async () => {
  await using run = scenario()
  await run.setup("root")
  for (const [id, parent, session] of [
    ["child", "root", "child"],
    ["grandchild", "child", "root"],
  ]) {
    const thread = run.metadata(id, parent, "active", session)
    await run.client.request("fixture/thread", thread)
    await run.emit("thread/started", { thread })
    await run.emit("turn/started", { threadId: id, turn: { id: `${id}-turn` } })
  }
  await run.end("root")
  await run.end("child")
  await run.client.request("fixture/thread", {
    ...run.metadata("grandchild", "child", "notLoaded", "grandchild"),
    turns: [{ id: "grandchild-turn", rootTurnId: "root-turn", status: "completed", items: [] }],
  })
  await run.emit("thread/closed", { threadId: "grandchild" })
  await run.finished
  expect(run.tree.active()).toHaveLength(0)
})
