import { describe, expect, test } from "bun:test"
import { NativeAnswers } from "../../src/native/answers"
import { NativeHistory } from "../../src/native/history"
import { NativeQuestion } from "../../src/native/questions"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
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

describe("native revert projection", () => {
  test("prunes the suffix ledger and cache together while retaining research input and metadata", async () => {
    await scenario(async (session) => {
      const context = input(session, "Selected paper citation, page 3")
      const first = input(session, "Explain this image")
      first.parts.push({
        id: PartID.ascending(),
        messageID: first.info.id,
        sessionID: session.id,
        type: "file",
        mime: "image/png",
        filename: "plot.png",
        url: "data:image/png;base64,cGxvdA==",
      })
      const second = input(session, "Discard this later question")
      const before = accept(session, first, "first", context)
      const after = accept(session, second, "second")
      await NativeSync.apply(session, snapshot([before, after]))
      await Session.setEngine({
        sessionID: session.id,
        engine: { ...session.engine!, cursor: second.info.id, model: "research", permission: "auto", mode: "plan" },
      })
      await Session.setSummary({ sessionID: session.id, summary: { additions: 2, deletions: 1, files: 1 } })
      await Storage.write(
        ["session_diff", session.id],
        [{ file: "paper.tex", before: "a", after: "b", additions: 1, deletions: 1 }],
      )

      expect(await NativeSync.revert(await Session.get(session.id), snapshot([before]))).toMatchObject({
        state: "synced",
      })
      expect(
        NativeStore.inputs(session.id)
          .map((row) => row.id)
          .sort(),
      ).toEqual([context.info.id, first.info.id].sort())
      expect(NativeStore.dispatches(session.id).map((row) => row.id)).toEqual([first.info.id])
      const messages = await NativeStore.history(session.id)
      expect(messages.find((entry) => entry.info.id === first.info.id)?.parts).toEqual(
        expect.arrayContaining(first.parts),
      )
      expect(messages.find((entry) => entry.info.id === context.info.id)?.parts).toEqual(context.parts)
      expect(messages.some((entry) => entry.info.id === second.info.id)).toBe(false)
      expect(await Session.get(session.id)).toMatchObject({
        engine: { thread: "thread", cursor: first.info.id, model: "research", permission: "auto", mode: "plan" },
      })
      expect((await Session.get(session.id)).summary).toBeUndefined()
      expect(await Session.diff(session.id)).toEqual([])
      await NativeSync.apply(await Session.get(session.id), snapshot([before]))
      const refreshed = await NativeStore.history(session.id)
      expect(refreshed.map((entry) => entry.info.id)).toEqual(messages.map((entry) => entry.info.id))
      expect(refreshed.find((entry) => entry.info.id === first.info.id)?.parts).toEqual(
        expect.arrayContaining(first.parts),
      )
      expect(NativeStore.dispatches(session.id).map((row) => row.turn_id)).toEqual(["first"])
      await NativeSync.apply(await Session.get(session.id), snapshot([before]))
      expect(await NativeStore.history(session.id)).toEqual(refreshed)
    })
  })

  test("an empty retained prefix clears inputs, deliveries and cursor but keeps the native thread", async () => {
    await scenario(async (session) => {
      const message = input(session, "First question")
      await NativeSync.apply(session, snapshot([accept(session, message, "first")]))
      await Session.setEngine({ sessionID: session.id, engine: { ...session.engine!, cursor: message.info.id } })
      await NativeSync.revert(await Session.get(session.id), snapshot([]))
      expect(await NativeStore.history(session.id)).toEqual([])
      expect(NativeStore.inputs(session.id)).toEqual([])
      expect(NativeStore.dispatches(session.id)).toEqual([])
      expect((await Session.get(session.id)).engine).toEqual(session.engine)
      await NativeSync.apply(await Session.get(session.id), snapshot([]))
      expect(await NativeStore.history(session.id)).toEqual([])
    })
  })

  test.each(["interrupted", "failed"])("retains observed %s output before the cut", async (status) => {
    await scenario(async (session) => {
      const before = turn("first")
      const after = turn("second")
      await NativeSync.apply(session, snapshot([before, after]))
      const message = (await NativeStore.history(session.id)).find((entry) => entry.info.role === "assistant")!
      const part = message.parts.find((part) => part.type === "text")!
      if (part.type !== "text") throw new Error("Expected text")
      await Session.updatePart({ ...part, text: "Previously observed longer answer" })
      before.status = status
      const result = await NativeSync.revert(session, snapshot([before]))
      expect(result.state).toBe("synced")
      const messages = await NativeStore.history(session.id)
      expect(messages).toHaveLength(2)
      expect(messages.flatMap((entry) => entry.parts)).toContainEqual(
        expect.objectContaining({ text: "Previously observed longer answer" }),
      )
      await NativeSync.apply(await Session.get(session.id), snapshot([before]))
      expect(await NativeStore.history(session.id)).toEqual(messages)
    })
  })

  test("rebuilds question answers only from retained native users", async () => {
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
      await NativeSync.apply(session, snapshot([before, after, turn("third")]))
      expect(await card()).toMatchObject({ state: "answered", answers: ["Short"] })
      await NativeAnswers.reset(session.id)
      await NativeSync.revert(session, snapshot([before, after]))
      expect(await card()).toMatchObject({ state: "answered", answers: ["Short"] })
      await NativeSync.apply(await Session.get(session.id), snapshot([before, after]))
      await NativeAnswers.reset(session.id)
      await NativeSync.revert(await Session.get(session.id), snapshot([before]))
      expect(await card()).toMatchObject({ state: "pending" })
      expect((await card()).answers).toBeUndefined()
      await NativeSync.apply(await Session.get(session.id), snapshot([before]))
      expect(await card()).toMatchObject({ state: "pending" })
    })
  })

  test("rejects incomplete history and unconfirmed input before changing local state", async () => {
    await scenario(async (session) => {
      await NativeSync.apply(session, snapshot([turn("first")]))
      const before = await NativeStore.history(session.id)
      await expect(NativeSync.revert(session, { ...snapshot([]), complete: false })).rejects.toThrow("completely")
      expect(await NativeStore.history(session.id)).toEqual(before)
      NativeStore.add(input(session, "Still waiting for dispatch"), false)
      expect(() => NativeStore.prefix(session, [])).toThrow("unconfirmed")
      await expect(NativeSync.revert(session, snapshot([]))).rejects.toThrow("unconfirmed")
      expect(await NativeStore.history(session.id)).toEqual(before)
      expect(NativeStore.pending(session.id)).toHaveLength(1)
    })
  })

  test("rolls back ledger pruning, metadata and projection when the transaction fails", async () => {
    await scenario(async (session) => {
      const first = input(session, "Retain this")
      const second = input(session, "Remove this")
      const before = accept(session, first, "first")
      await NativeSync.apply(session, snapshot([before, accept(session, second, "second")]))
      await Session.setEngine({ sessionID: session.id, engine: { ...session.engine!, cursor: second.info.id } })
      await Session.setSummary({ sessionID: session.id, summary: { additions: 1, deletions: 1, files: 1 } })
      const original = await Session.get(session.id)
      const messages = await NativeStore.history(session.id)
      const inputs = NativeStore.inputs(session.id)
      const ledger = NativeStore.dispatches(session.id)
      const sqlite = Database.attach(Instance.project.id).$client
      sqlite.exec(
        "CREATE TEMP TRIGGER reject_revert BEFORE UPDATE ON native_state BEGIN SELECT RAISE(ABORT, 'revert projection failed'); END",
      )
      try {
        await expect(NativeSync.revert(original, snapshot([before]))).rejects.toThrow("revert projection failed")
        expect(await NativeStore.history(session.id)).toEqual(messages)
        expect(NativeStore.inputs(session.id)).toEqual(inputs)
        expect(NativeStore.dispatches(session.id)).toEqual(ledger)
        expect(await Session.get(session.id)).toEqual(original)
      } finally {
        sqlite.exec("DROP TRIGGER reject_revert")
      }
      await NativeSync.revert(original, snapshot([before]))
      expect(NativeStore.dispatches(session.id).map((row) => row.id)).toEqual([first.info.id])
    })
  })

  test.each(["sending", "uncertain"])("still blocks %s dispatches even alongside confirmed failures", async (state) => {
    await scenario(async (session) => {
      const failed = input(session, "Confirmed local failure")
      NativeStore.add(failed, false)
      NativeStore.fail(session.id, failed.info.id)
      const message = input(session, "Delivery is not confirmed")
      NativeStore.add(message, false)
      NativeStore.begin(session.id, message.info.id, MessageID.ascending(), "thread", [message.info.id])
      if (state === "uncertain") NativeStore.uncertain(session.id, message.info.id)
      const rows = NativeStore.inputs(session.id)
      const ledger = NativeStore.dispatches(session.id)
      await expect(NativeSync.revert(session, snapshot([]))).rejects.toThrow("unconfirmed")
      expect(NativeStore.inputs(session.id)).toEqual(rows)
      expect(NativeStore.dispatches(session.id)).toEqual(ledger)
    })
  })
})
