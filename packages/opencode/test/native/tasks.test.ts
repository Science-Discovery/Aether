import { expect, test } from "bun:test"
import path from "node:path"
import { NativeTasks } from "../../src/native/tasks"
import { NativeQuestion } from "../../src/native/questions"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import type { NativeHistory } from "../../src/native/history"
import type { Protocol } from "../../src/native/protocol"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

function snapshot(turns = true): NativeHistory.Snapshot {
  return {
    thread: { id: "root", createdAt: 100, updatedAt: 110, status: { type: "notLoaded" } },
    turns: turns
      ? [
          {
            id: "root-turn",
            status: "completed",
            itemsView: "full",
            startedAt: 101,
            completedAt: 102,
            items: [
              { id: "root-user", type: "userMessage", content: [{ type: "text", text: "Root task" }] },
              { id: "root-answer", type: "agentMessage", text: "Root result", phase: "final_answer" },
            ],
          },
        ]
      : [],
    complete: true,
    issues: [],
  }
}

async function scenario(run: (session: Session.Info) => Promise<void>) {
  await using dir = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const created = await Session.create({ engine: { type: "codex" } })
        await NativeStore.migrate(created)
        await Session.setEngine({ sessionID: created.id, engine: { type: "codex", thread: "root" } })
        const session = await Session.get(created.id)
        await NativeSync.apply(session, snapshot())
        try {
          await run(session)
        } finally {
          await NativeTasks.clear(session.id)
        }
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
}

async function observe(id: Session.Info["id"], item = "original-question", origin = "root-turn") {
  await NativeTasks.observe(id, "item/completed", {
    threadId: "root",
    turnId: origin,
    nativeAgent: {
      threadId: "child",
      turnId: "child-turn",
      parentThreadId: "root",
      name: "Research child",
      itemId: item,
    },
    item: {
      id: `codex:child:child-turn:${item}`,
      type: "agentMessage",
      delivery: "async",
      text: "Child result",
      questions: [{ title: "Which method?", options: ["A", "B"] }],
    },
  })
}

async function link(id: Session.Info["id"]) {
  const child = await Session.createNext({ directory: Instance.directory, engine: { type: "codex", thread: "child" } })
  await NativeStore.migrate(child)
  const history = snapshot()
  history.thread = { ...history.thread!, id: "child" }
  history.turns[0].items[1] = {
    id: "child-answer",
    type: "agentMessage",
    text: "Linked child result",
    phase: "final_answer",
  }
  await NativeSync.apply(child, history)
  const file = path.join(Global.Path.data, "native-tasks", Instance.project.id, `${id}.json`)
  const saved = (await Bun.file(file).json()) as { tasks: { thread: string; session?: string }[] }
  saved.tasks.find((task) => task.thread === "child")!.session = child.id
  await Bun.write(file, JSON.stringify(saved))
  return child
}

test("child task questions retain raw identity independently of root transcript refresh", async () => {
  await scenario(async (session) => {
    await observe(session.id)
    const tasks = await NativeTasks.list(session.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ thread: "child", root: "root", origin: "root-turn", output: "Child result" })
    expect(tasks[0].questions[0]).toMatchObject({
      thread: "child",
      turn: "child-turn",
      item: "original-question",
      state: "pending",
    })
    expect(await NativeSync.apply(session, snapshot())).toMatchObject({ state: "synced" })
    expect(JSON.stringify(await NativeStore.history(session.id))).not.toContain("Child result")
    expect((await NativeTasks.list(session.id))[0].questions).toEqual(tasks[0].questions)
  })
})

test("retiring the parent turn hides its child tasks and refuses stale question answers", async () => {
  await scenario(async (session) => {
    const history = await NativeStore.history(session.id)
    const user = history.find((entry) => entry.info.role === "user")!
    const assistant = history.find((entry) => entry.info.role === "assistant")!
    NativeStore.add(user, false)
    NativeStore.begin(session.id, user.info.id, assistant.info.id, "root", [user.info.id])
    NativeStore.accept(session.id, user.info.id, "root-turn")
    await observe(session.id)
    const child = await link(session.id)
    await SessionStatus.set(child.id, { type: "busy" })
    expect(await NativeTasks.list(session.id)).toHaveLength(1)
    await expect(NativeTasks.guard(session.id)).rejects.toThrow("linked child task")
    await NativeTasks.guard(session.id, "child")
    const next = snapshot(false)
    const client: Pick<Protocol.Client, "request"> = {
      request: async <T>(method: string) => {
        if (method === "thread/read") return { thread: next.thread } as T
        if (method === "thread/turns/list") return { data: [], nextCursor: null } as T
        throw new Error(`Unexpected method ${method}`)
      },
    }
    expect(await NativeSync.reconcile(session, next, client)).toMatchObject({ state: "synced" })
    expect(NativeStore.dispatches(session.id, { retired: true })[0].state).toBe("retired")
    expect(await NativeTasks.list(session.id)).toEqual([])
    await NativeTasks.guard(session.id)
    expect((await SessionStatus.get(child.id)).type).toBe("busy")
    await expect(
      NativeTasks.reply({ sessionID: session.id, threadID: "child", itemID: "original-question", answers: ["A"] }),
    ).rejects.toThrow("no longer part")
  })
})

test("reused child threads inherit their linked session before decorating state and output", async () => {
  await scenario(async (session) => {
    await observe(session.id)
    const child = await link(session.id)
    const next = snapshot()
    next.turns.push({
      ...next.turns[0],
      id: "root-next",
      startedAt: 103,
      completedAt: 104,
      items: [
        { id: "next-user", type: "userMessage", content: [{ type: "text", text: "Reuse the child" }] },
        { id: "next-answer", type: "agentMessage", text: "Next result", phase: "final_answer" },
      ],
    })
    await NativeSync.apply(session, next)
    await observe(session.id, "next-question", "root-next")
    const tasks = await NativeTasks.list(session.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      origin: "root-next",
      session: child.id,
      state: "completed",
      output: "Linked child result",
    })
    expect(tasks[0].questions.map((question) => question.item)).toEqual(["original-question", "next-question"])
    await SessionStatus.set(child.id, { type: "busy" })
    expect((await NativeTasks.list(session.id))[0].state).toBe("running")
    await expect(NativeTasks.guard(session.id)).rejects.toThrow("linked child task")
    await NativeTasks.guard(session.id, "child")
    await SessionStatus.set(child.id, { type: "idle" })
  })
})

test("submitted child answers preserve their receipt and never resend on the same request", async () => {
  await scenario(async (session) => {
    await observe(session.id)
    const calls: { thread: string; text: string; id: string }[] = []
    using run = NativeTasks.open(session.id, async (input) => {
      calls.push(input)
    })
    const input = { sessionID: session.id, threadID: "child", itemID: "original-question", answers: ["A"] }
    expect(await NativeTasks.reply(input)).toMatchObject({ state: "answered", answers: ["A"] })
    expect(await NativeTasks.reply(input)).toMatchObject({ state: "answered", answers: ["A"] })
    expect(calls).toHaveLength(1)
    expect(calls[0].thread).toBe("child")
    expect(NativeQuestion.responses(calls[0].text)[0]).toMatchObject({
      questionItemId: JSON.stringify(["request_user_input_async", "original-question", 0]),
      answer: "A",
    })
    await expect(NativeTasks.reply({ ...input, answers: ["B"] })).rejects.toThrow("different submitted answer")
    expect((await NativeTasks.list(session.id))[0].questions[0].state).toBe("answered")
  })
})

test("lost child answer responses remain uncertain across connection changes without replay", async () => {
  await scenario(async (session) => {
    await observe(session.id)
    const calls: string[] = []
    const input = { sessionID: session.id, threadID: "child", itemID: "original-question", answers: ["B"] }
    {
      using run = NativeTasks.open(session.id, async (input) => {
        calls.push(input.id)
        throw new Error("Transport closed after dispatch")
      })
      expect(await NativeTasks.reply(input)).toMatchObject({ state: "uncertain" })
    }
    using next = NativeTasks.open(session.id, async (input) => {
      calls.push(input.id)
    })
    expect(await NativeTasks.reply(input)).toMatchObject({ state: "uncertain" })
    expect(calls).toHaveLength(1)
    expect((await NativeTasks.list(session.id))[0].questions[0].state).toBe("uncertain")
  })
})
