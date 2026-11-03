import { describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { NativeHistory } from "../../src/native/history"
import { NativeAnswers } from "../../src/native/answers"
import { NativeInteraction } from "../../src/native/interaction"
import { NativeQueue } from "../../src/native/queue"
import { NativeQuestion } from "../../src/native/questions"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import type { Protocol } from "../../src/native/protocol"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Database } from "../../src/storage/db"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (session: Session.Info) => Promise<void>) {
  await using dir = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        await NativeStore.migrate(session)
        await Session.setEngine({ sessionID: session.id, engine: { type: "codex", thread: "thread" } })
        await run(await Session.get(session.id))
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
}

function turn(id: string, client?: MessageID): NativeHistory.Turn {
  return {
    id,
    status: "completed",
    itemsView: "full",
    startedAt: 101,
    completedAt: 102,
    items: [
      { id: "user", type: "userMessage", clientId: client, content: [{ type: "text", text: `Question ${id}` }] },
      { id: "answer", type: "agentMessage", text: `Answer ${id}`, phase: "final_answer" },
    ],
  }
}

function snapshot(turns: NativeHistory.Turn[]): NativeHistory.Snapshot {
  return {
    thread: { id: "thread", createdAt: 100, updatedAt: 110, status: { type: "notLoaded" } },
    turns,
    complete: true,
    issues: [],
  }
}

function reader(value: NativeHistory.Snapshot): Pick<Protocol.Client, "request"> {
  return {
    request: async <T>(method: string): Promise<T> => {
      if (method === "thread/read") return { thread: value.thread } as T
      if (method === "thread/turns/list") return { data: value.turns, nextCursor: null } as T
      throw new Error(`Unexpected native history request ${method}`)
    },
  }
}

function input(session: Session.Info, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: session.id,
      role: "user",
      time: { created: 100 },
      agent: "codex",
      model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("research") },
    },
    parts: [{ id: PartID.ascending(), sessionID: session.id, messageID: id, type: "text", text }],
  }
}

function accept(session: Session.Info, message: MessageV2.WithParts, id: string, context?: MessageV2.WithParts) {
  NativeStore.add(message, false)
  if (context) NativeStore.add(context, true)
  NativeStore.begin(session.id, message.info.id, MessageID.ascending(), "thread", [
    ...(context ? [context.info.id] : []),
    message.info.id,
  ])
  NativeStore.accept(session.id, message.info.id, id)
  return turn(id, message.info.id)
}

describe("external native history reconciliation", () => {
  test("retires removed deliveries and replaces cursor and diffs while preserving pending, failed and queued input", async () => {
    await scenario(async (session) => {
      const first = input(session, "Retain this")
      const second = input(session, "Remove this")
      const context = input(session, "Removed citation")
      const before = accept(session, first, "first")
      await NativeSync.apply(session, snapshot([before, accept(session, second, "second", context)]))
      const pending = input(session, "Pending paper selection")
      NativeStore.add(pending, true)
      const failed = input(session, "Failed request")
      NativeStore.add(failed, false)
      NativeStore.fail(session.id, failed.info.id)
      const queued = await NativeQueue.enqueue({
        sessionID: session.id,
        messageID: MessageID.ascending(),
        text: "Queued figure",
      })
      await Session.setEngine({ sessionID: session.id, engine: { ...session.engine!, cursor: second.info.id } })
      await Session.setSummary({ sessionID: session.id, summary: { additions: 2, deletions: 1, files: 1 } })
      await Storage.write(
        ["session_diff", session.id],
        [{ file: "paper.tex", before: "a", after: "b", additions: 1, deletions: 1 }],
      )
      const value = snapshot([before, turn("external")])
      expect(await NativeSync.reconcile(await Session.get(session.id), value, reader(value))).toMatchObject({
        state: "synced",
      })
      const messages = await NativeStore.history(session.id)
      expect(messages.some((entry) => entry.info.id === second.info.id || entry.info.id === context.info.id)).toBe(
        false,
      )
      expect(messages.map((entry) => entry.info.id)).toEqual(
        expect.arrayContaining([first.info.id, pending.info.id, failed.info.id]),
      )
      expect(
        messages
          .flatMap((entry) => entry.parts)
          .some((part) => part.type === "text" && part.text === "Answer external"),
      ).toBe(true)
      expect(NativeStore.dispatches(session.id).map((entry) => entry.id)).toEqual([first.info.id])
      expect(
        NativeStore.dispatches(session.id, { retired: true }).find((entry) => entry.id === second.info.id),
      ).toMatchObject({ state: "retired", turn_id: "second" })
      expect(
        NativeStore.inputs(session.id, { retired: true }).find((entry) => entry.id === context.info.id),
      ).toMatchObject({ state: "consumed" })
      expect(NativeStore.pending(session.id).map((entry) => entry.id)).toEqual([pending.info.id])
      expect(await NativeQueue.list(session.id)).toEqual(queued)
      expect((await Session.get(session.id)).engine?.cursor).not.toBe(second.info.id)
      expect((await Session.get(session.id)).summary).toBeUndefined()
      expect(await Session.diff(session.id)).toEqual([])
      await NativeSync.apply(await Session.get(session.id), value)
      expect(await NativeStore.history(session.id)).toEqual(messages)
    })
  })

  test("empty native history retains consumed tombstones and rejects delayed resend through every entry point", async () => {
    await scenario(async (session) => {
      const message = input(session, "Removed first question")
      await NativeSync.apply(session, snapshot([accept(session, message, "first")]))
      const value = snapshot([])
      expect(await NativeSync.reconcile(session, value, reader(value))).toMatchObject({ state: "synced" })
      expect(await NativeStore.history(session.id)).toEqual([])
      expect(NativeStore.inputs(session.id)).toEqual([])
      expect(NativeStore.inputs(session.id, { retired: true })).toHaveLength(1)
      expect(() => NativeStore.add(message, false)).toThrow("removed")
      expect(() =>
        NativeStore.begin(session.id, message.info.id, MessageID.ascending(), "thread", [message.info.id]),
      ).toThrow("dispatched")
      await expect(
        NativeQueue.enqueue({ sessionID: session.id, messageID: message.info.id, text: "Removed first question" }),
      ).rejects.toThrow("already")
      expect(
        await NativeInteraction.steer({
          sessionID: session.id,
          messageID: message.info.id,
          turnID: "first",
          text: "Removed first question",
        }),
      ).toMatchObject({ status: "rejected" })
      NativeStore.accept(session.id, message.info.id, "first")
      NativeStore.delivery(session.id, message.info.id, "rejected")
      NativeStore.uncertain(session.id, message.info.id)
      expect(NativeStore.dispatches(session.id, { retired: true })[0]?.state).toBe("retired")
      expect(NativeStore.inputs(session.id, { retired: true })[0]?.state).toBe("consumed")
      await NativeSync.revert(await Session.get(session.id), value)
      expect(NativeStore.dispatches(session.id, { retired: true })[0]?.state).toBe("retired")
      expect(NativeStore.inputs(session.id, { retired: true })).toHaveLength(1)
    })
  })

  test("rebuilds unresolved questions from the retained native history after removing their answers", async () => {
    await scenario(async (session) => {
      const item = {
        id: "question",
        type: "agentMessage",
        text: "Choose a style",
        delivery: "async",
        questions: [{ title: "Style?", options: ["Short", "Detailed"] }],
      }
      const before = { ...turn("first"), items: [turn("first").items[0], item] }
      const question = NativeQuestion.parse(item, { thread: "thread", turn: "first" })!
      const after = {
        ...turn("second"),
        items: [
          {
            id: "user",
            type: "userMessage",
            content: [{ type: "text", text: NativeQuestion.reply(question, ["Short"]) }],
          },
        ],
      }
      const card = async () =>
        (await NativeStore.history(session.id))
          .flatMap((entry) => entry.parts)
          .flatMap((part) => (part.type === "text" && part.nativeQuestion ? [part.nativeQuestion] : []))[0]
      await NativeSync.apply(session, snapshot([before, after]))
      expect(await card()).toMatchObject({ state: "answered" })
      const value = snapshot([before])
      let guarded = false
      const listener = (event: { payload: { type: string; properties: { sessionID?: string } } }) => {
        if (event.payload.type !== Session.Event.Updated.type || event.payload.properties.sessionID !== session.id)
          return
        expect(() => NativeAnswers.block(session.id)).toThrow("Wait for the submitted answer")
        guarded = true
      }
      GlobalBus.on("event", listener)
      try {
        await NativeSync.reconcile(session, value, reader(value))
      } finally {
        GlobalBus.off("event", listener)
      }
      expect(guarded).toBe(true)
      expect(await card()).toMatchObject({ state: "pending" })
      expect((await card()).answers).toBeUndefined()
      await NativeSync.apply(session, value)
      expect(await card()).toMatchObject({ state: "pending" })
    })
  })

  test("rejects a new answer in the reset-to-projection gap and releases the gate after replacement", async () => {
    await scenario(async (session) => {
      const item = {
        id: "question",
        type: "agentMessage",
        text: "Choose a style",
        delivery: "async",
        questions: [{ title: "Style?", options: ["Short", "Detailed"] }],
      }
      await NativeSync.apply(session, snapshot([{ ...turn("first"), items: [turn("first").items[0], item] }]))
      const answer = { sessionID: session.id, threadID: "thread", itemID: "question", answers: ["Short"] }
      {
        using gate = NativeAnswers.block(session.id)
        await NativeAnswers.reset(session.id)
        await expect(NativeAnswers.reply(answer)).rejects.toThrow("cancelled")
        expect(NativeAnswers.active(session.id)).toBe(false)
        expect(NativeStore.inputs(session.id)).toEqual([])
        await NativeSync.apply(session, snapshot([]))
      }
      await expect(NativeAnswers.reply(answer)).rejects.toThrow("no longer available")
      expect(NativeAnswers.active(session.id)).toBe(false)
    })
  })

  test("keeps old projection and delivery evidence when the read is partial or changes during confirmation", async () => {
    await scenario(async (session) => {
      const message = input(session, "Keep until confirmed")
      await NativeSync.apply(session, snapshot([accept(session, message, "first"), turn("second")]))
      const history = await NativeStore.history(session.id)
      const ledger = NativeStore.dispatches(session.id)
      expect(
        await NativeSync.reconcile(session, { ...snapshot([]), complete: false }, reader(snapshot([]))),
      ).toMatchObject({ state: "partial" })
      expect(await NativeSync.reconcile(session, snapshot([]), reader(snapshot([turn("new")])))).toMatchObject({
        state: "partial",
      })
      const active = { ...snapshot([]), thread: { ...snapshot([]).thread!, status: { type: "active" } } }
      expect(await NativeSync.reconcile(session, snapshot([]), reader(active))).toMatchObject({ state: "partial" })
      expect(await NativeStore.history(session.id)).toEqual(history)
      expect(NativeStore.dispatches(session.id)).toEqual(ledger)
    })
  })

  test("unconfirmed dispatches prevent replacement without discarding pending user input", async () => {
    await scenario(async (session) => {
      await NativeSync.apply(session, snapshot([turn("first")]))
      const message = input(session, "Delivery unknown")
      NativeStore.add(message, false)
      NativeStore.begin(session.id, message.info.id, MessageID.ascending(), "thread", [message.info.id])
      NativeStore.uncertain(session.id, message.info.id)
      const history = await NativeStore.history(session.id)
      await expect(NativeSync.reconcile(session, snapshot([]), reader(snapshot([])))).rejects.toThrow("unconfirmed")
      expect(await NativeStore.history(session.id)).toEqual(history)
      expect(NativeStore.dispatches(session.id)[0]?.state).toBe("uncertain")
    })
  })

  test("older interrupted turns can be retained when a later completed turn confirms the boundary", async () => {
    await scenario(async (session) => {
      await NativeSync.apply(session, snapshot([turn("first"), turn("second"), turn("third")]))
      const value = snapshot([{ ...turn("first"), status: "interrupted" }, turn("second")])
      const initial = await NativeHistory.read(reader(value), "thread")
      expect(initial.complete).toBe(false)
      expect(await NativeSync.reconcile(session, initial, reader(value))).toMatchObject({ state: "synced" })
      expect(await NativeStore.history(session.id)).toHaveLength(4)
      const ending = snapshot([{ ...turn("first"), status: "interrupted" }])
      expect(
        await NativeSync.reconcile(session, await NativeHistory.read(reader(ending), "thread"), reader(ending)),
      ).toMatchObject({ state: "partial" })
      expect(await NativeStore.history(session.id)).toHaveLength(4)
    })
  })

  test("compaction imports its marker without deleting native turns or inventing a user message", async () => {
    await scenario(async (session) => {
      const first = accept(session, input(session, "First"), "first")
      await NativeSync.apply(session, snapshot([first]))
      const ids = (await NativeStore.history(session.id)).map((entry) => entry.info.id)
      const value = snapshot([
        first,
        { id: "compact", status: "completed", itemsView: "full", items: [{ id: "marker", type: "contextCompaction" }] },
      ])
      expect(await NativeSync.reconcile(session, value, reader(value))).toMatchObject({ state: "synced" })
      expect((await NativeStore.history(session.id)).map((entry) => entry.info.id)).toEqual(ids)
      expect((await NativeStore.history(session.id)).flatMap((entry) => entry.parts)).toContainEqual(
        expect.objectContaining({ type: "tool", tool: "codex.contextCompaction" }),
      )
      expect(NativeStore.dispatches(session.id)).toHaveLength(1)
      const same = {
        request: async () => {
          throw new Error("Already reconciled compaction should not require another confirming read")
        },
      }
      expect(await NativeSync.reconcile(session, value, same)).toMatchObject({ state: "synced" })
    })
  })

  test("a failed transaction rolls back retirement, message deletion and cursor changes together", async () => {
    await scenario(async (session) => {
      const first = accept(session, input(session, "First"), "first")
      const second = input(session, "Second")
      await NativeSync.apply(session, snapshot([first, accept(session, second, "second")]))
      await Session.setEngine({ sessionID: session.id, engine: { ...session.engine!, cursor: second.info.id } })
      const original = await Session.get(session.id)
      const history = await NativeStore.history(session.id)
      const ledger = NativeStore.dispatches(session.id)
      const sqlite = Database.attach(Instance.project.id).$client
      sqlite.exec(
        "CREATE TEMP TRIGGER reject_reconcile BEFORE UPDATE ON native_state BEGIN SELECT RAISE(ABORT, 'projection failed'); END",
      )
      try {
        const value = snapshot([first])
        await expect(NativeSync.reconcile(original, value, reader(value))).rejects.toThrow("projection failed")
        expect(await NativeStore.history(session.id)).toEqual(history)
        expect(NativeStore.dispatches(session.id)).toEqual(ledger)
        expect(await Session.get(session.id)).toEqual(original)
      } finally {
        sqlite.exec("DROP TRIGGER reject_reconcile")
      }
    })
  })
})
