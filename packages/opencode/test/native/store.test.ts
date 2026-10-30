import { describe, expect, test } from "bun:test"
import path from "node:path"
import { NativeStore } from "../../src/native/store"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (session: Session.Info) => Promise<void>) {
  await using dir = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => run(await Session.create({ engine: { type: "codex" } })),
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
}

function input(session: Session.Info, text: string, time = Date.now()): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: session.id,
      role: "user",
      time: { created: time },
      agent: "codex",
      model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("research") },
    },
    parts: [{ id: PartID.ascending(), sessionID: session.id, messageID: id, type: "text", text }],
  }
}

async function cache(message: MessageV2.WithParts) {
  await Session.updateMessage(message.info)
  for (const part of message.parts) await Session.updatePart(part)
}

async function answer(message: MessageV2.WithParts, failed = false) {
  await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: message.info.sessionID,
    role: "assistant",
    parentID: message.info.id,
    time: { created: message.info.time.created + 1, completed: message.info.time.created + 2 },
    modelID: ModelID.make("research"),
    providerID: ProviderID.make("codex-native"),
    mode: "codex",
    agent: "codex",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(failed ? { error: { name: "UnknownError", data: { message: "Connection failed" } } as const } : {}),
  })
}

describe("native input storage", () => {
  test("migrates the cursor once without replaying consumed context or failed requests", async () => {
    await scenario(async (session) => {
      const context = input(session, "Previously submitted paper context", 100)
      const completed = input(session, "First question", 200)
      const failed = input(session, "Failed later question", 300)
      const queued = input(session, "Unsent noReply context", 400)
      for (const message of [context, completed, failed, queued]) await cache(message)
      await answer(completed)
      await answer(failed, true)
      await Session.setEngine({
        sessionID: session.id,
        engine: { type: "codex", thread: "thread-legacy", cursor: completed.info.id },
      })

      await NativeStore.migrate(await Session.get(session.id))
      expect(NativeStore.inputs(session.id).map((row) => [row.id, row.state, row.context])).toEqual([
        [context.info.id, "consumed", true],
        [completed.info.id, "consumed", false],
        [failed.info.id, "failed", false],
        [queued.info.id, "pending", true],
      ])
      expect(NativeStore.pending(session.id).map((row) => row.data)).toEqual([queued])
      expect(NativeStore.dispatches(session.id)).toEqual([
        expect.objectContaining({
          id: completed.info.id,
          state: "uncertain",
          thread_id: "thread-legacy",
          assistant: expect.objectContaining({ role: "assistant", parentID: completed.info.id }),
        }),
      ])

      await NativeStore.migrate(await Session.get(session.id))
      expect(NativeStore.inputs(session.id)).toHaveLength(4)
      expect(NativeStore.pending(session.id).map((row) => row.id)).toEqual([queued.info.id])
    })
  })

  test("preserves failed first requests and pending noReply context without a native thread", async () => {
    await scenario(async (session) => {
      const failed = input(session, "Failed before native thread creation", 100)
      const queued = input(session, "Queued research context", 200)
      await cache(failed)
      await answer(failed, true)
      await cache(queued)

      await Promise.all([NativeStore.migrate(session), NativeStore.migrate(session)])
      expect(NativeStore.inputs(session.id).map((row) => [row.id, row.state])).toEqual([
        [failed.info.id, "failed"],
        [queued.info.id, "pending"],
      ])
      expect(NativeStore.state(session.id)?.version).toBe(1)
      expect(NativeStore.pending(session.id).map((row) => row.id)).toEqual([queued.info.id])
    })
  })

  test.each(["missing cursor", "missing boundary"])("rejects ambiguous legacy history: %s", async (mode) => {
    await scenario(async (session) => {
      const message = input(session, "Keep original input")
      await cache(message)
      await answer(message, true)
      await Session.setEngine({
        sessionID: session.id,
        engine: {
          type: "codex",
          thread: "existing-thread",
          ...(mode === "missing boundary" ? { cursor: MessageID.ascending() } : {}),
        },
      })
      const before = await NativeStore.history(session.id)

      await expect(NativeStore.migrate(await Session.get(session.id))).rejects.toThrow("cursor")
      expect(NativeStore.state(session.id)).toBeUndefined()
      expect(NativeStore.inputs(session.id)).toEqual([])
      expect(await NativeStore.history(session.id)).toEqual(before)
    })
  })

  test("consumes the complete queued batch atomically and rejects duplicate dispatch", async () => {
    await scenario(async (session) => {
      await NativeStore.migrate(session)
      const context = input(session, "Paper context", 100)
      const request = input(session, "Explain the result", 200)
      NativeStore.add(context, true)
      NativeStore.add(request, false)
      const assistant = MessageID.ascending()
      const ids = [context.info.id, request.info.id]

      NativeStore.begin(session.id, request.info.id, assistant, "thread-one", ids)
      expect(NativeStore.pending(session.id)).toEqual([])
      expect(NativeStore.inputs(session.id).map((row) => [row.state, row.dispatch_id])).toEqual([
        ["consumed", request.info.id],
        ["consumed", request.info.id],
      ])
      expect(NativeStore.dispatches(session.id)).toEqual([
        expect.objectContaining({
          id: request.info.id,
          session_id: session.id,
          assistant_id: assistant,
          thread_id: "thread-one",
          state: "sending",
          turn_id: null,
        }),
      ])
      expect(() => NativeStore.begin(session.id, request.info.id, assistant, "thread-one", ids)).toThrow(
        "already been dispatched",
      )
      expect(NativeStore.dispatches(session.id)).toHaveLength(1)
    })
  })

  test.each(["empty", "duplicate", "missing", "failed", "foreign"])(
    "rejects an invalid batch without consuming its pending input: %s",
    async (mode) => {
      await scenario(async (session) => {
        await NativeStore.migrate(session)
        const request = input(session, "Remain pending")
        const other = input(
          mode === "foreign" ? await Session.create({ engine: { type: "codex" } }) : session,
          "Other input",
        )
        NativeStore.add(request, false)
        NativeStore.add(other, true)
        if (mode === "failed") NativeStore.fail(session.id, other.info.id)
        const ids =
          mode === "empty"
            ? []
            : mode === "duplicate"
              ? [request.info.id, request.info.id]
              : [request.info.id, mode === "missing" ? MessageID.ascending() : other.info.id]

        expect(() => NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread-one", ids)).toThrow(
          "already been dispatched",
        )
        expect(NativeStore.inputs(session.id).find((row) => row.id === request.info.id)).toMatchObject({
          state: "pending",
          dispatch_id: null,
        })
        expect(NativeStore.dispatches(session.id)).toEqual([])
      })
    },
  )

  test("rolls back the dispatch record when consuming input fails inside the transaction", async () => {
    await scenario(async (session) => {
      await NativeStore.migrate(session)
      const request = input(session, "Retry only after a local rollback")
      NativeStore.add(request, false)
      const sqlite = Database.attach(Instance.project.id).$client
      sqlite.exec(`CREATE TEMP TRIGGER reject_delivery BEFORE UPDATE ON native_input
        BEGIN SELECT RAISE(ABORT, 'delivery write failed'); END`)
      try {
        expect(() =>
          NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread-one", [request.info.id]),
        ).toThrow("delivery write failed")
        expect(NativeStore.dispatches(session.id)).toEqual([])
        expect(NativeStore.inputs(session.id)).toEqual([
          expect.objectContaining({ id: request.info.id, state: "pending", dispatch_id: null }),
        ])
      } finally {
        sqlite.exec("DROP TRIGGER reject_delivery")
      }
      NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread-one", [request.info.id])
      expect(NativeStore.dispatches(session.id)).toHaveLength(1)
      expect(NativeStore.pending(session.id)).toEqual([])
    })
  })

  test("keeps uncertain delivery consumed and never downgrades an accepted turn", async () => {
    await scenario(async (session) => {
      await NativeStore.migrate(session)
      const request = input(session, "Do not resend after a lost response")
      NativeStore.add(request, false)
      NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread-one", [request.info.id])
      NativeStore.uncertain(session.id, request.info.id)
      expect(NativeStore.dispatches(session.id)[0]?.state).toBe("uncertain")
      NativeStore.fail(session.id, request.info.id)
      expect(NativeStore.pending(session.id)).toEqual([])
      expect(NativeStore.inputs(session.id)[0]?.state).toBe("consumed")

      NativeStore.accept(session.id, request.info.id, "turn-one")
      NativeStore.uncertain(session.id, request.info.id)
      expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "accepted", turn_id: "turn-one" })
      expect(() => NativeStore.accept(session.id, request.info.id, "another-turn")).toThrow("different turn")
      expect(() =>
        NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread-one", [request.info.id]),
      ).toThrow("already been dispatched")
      Database.detach(Instance.project.id)
      expect(NativeStore.pending(session.id)).toEqual([])
      expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "accepted", turn_id: "turn-one" })
    })
  })

  test("preserves input, citations and attachments after clearing the message cache and reopening", async () => {
    await scenario(async (session) => {
      const message = input(session, "Selected passage")
      message.parts.push(
        {
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.info.id,
          type: "text",
          text: "Paper page 7, equation 4",
          synthetic: true,
          metadata: { citation: { page: 7, equation: 4 } },
        },
        {
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: message.info.id,
          type: "file",
          mime: "text/plain",
          filename: "notes.txt",
          url: "data:text/plain;base64,cGFwZXIgbm90ZXM=",
        },
      )
      await cache(message)
      const queued = input(session, "Research context still waiting for a question", message.info.time.created + 1)
      await cache(queued)
      await NativeStore.migrate(session)
      NativeStore.begin(session.id, message.info.id, MessageID.ascending(), "thread-one", [message.info.id])
      await Session.removeMessage({ sessionID: session.id, messageID: message.info.id })
      await Session.removeMessage({ sessionID: session.id, messageID: queued.info.id })
      expect(await NativeStore.history(session.id)).toEqual([])

      Database.detach(Instance.project.id)
      await NativeStore.migrate(await Session.get(session.id))
      expect(NativeStore.inputs(session.id)[0]?.data).toEqual(message)
      expect(NativeStore.pending(session.id).map((row) => row.data)).toEqual([queued])
      expect(NativeStore.dispatches(session.id)).toHaveLength(1)
    })
  })

  test("rejects a changed Codex home while preserving the original binding and sync marker", async () => {
    await scenario(async (session) => {
      const home = path.join(Instance.directory, "codex-one")
      expect(() => NativeStore.bind(session.id, home)).toThrow("not initialized")
      await NativeStore.migrate(session)
      NativeStore.bind(session.id, home)
      NativeStore.bind(session.id, home)
      NativeStore.synced(session.id)
      const before = NativeStore.state(session.id)

      expect(() => NativeStore.bind(session.id, path.join(Instance.directory, "codex-two"))).toThrow(
        "different Codex home",
      )
      expect(NativeStore.state(session.id)).toEqual(before)
      expect(before?.time_synced).toEqual(expect.any(Number))
      Database.detach(Instance.project.id)
      expect(NativeStore.state(session.id)).toEqual(before)
    })
  })

  test("repairs already journaled legacy stores and missing indexes without losing data on reopen", async () => {
    await scenario(async (session) => {
      const message = input(session, "Existing research must survive")
      await cache(message)
      const id = Instance.project.id
      const sqlite = Database.attach(id).$client
      expect(
        sqlite.prepare("SELECT name FROM __drizzle_migrations WHERE name = ?").get("20261026134819_native_delivery"),
      ).toBeTruthy()
      sqlite.exec("DROP TABLE native_input; DROP TABLE native_dispatch; DROP TABLE native_state")
      Database.detach(id)

      const reopened = Database.attach(id).$client
      expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'native_%' ORDER BY name").all()).toEqual(
        [
          { name: "native_dispatch" },
          { name: "native_dispatch_session_idx" },
          { name: "native_input" },
          { name: "native_input_session_idx" },
          { name: "native_state" },
        ],
      )
      expect((await Session.get(session.id)).id).toBe(session.id)
      expect(await NativeStore.history(session.id)).toEqual([message])
      await NativeStore.migrate(session)
      NativeStore.begin(session.id, message.info.id, MessageID.ascending(), "thread-one", [message.info.id])
      const before = NativeStore.dispatches(session.id)

      reopened.exec("DROP INDEX native_input_session_idx")
      Database.detach(id)
      expect(NativeStore.dispatches(session.id)).toEqual(before)
      expect(NativeStore.inputs(session.id)[0]?.data).toEqual(message)
      expect(
        Database.attach(id)
          .$client.prepare("SELECT 1 FROM sqlite_master WHERE name = 'native_input_session_idx'")
          .get(),
      ).toBeTruthy()
      Database.detach(id)
      expect(NativeStore.dispatches(session.id)).toEqual(before)
      expect(NativeStore.pending(session.id)).toEqual([])
    })
  })

  test("cascades session deletion only through its local ledger and preserves the Codex home", async () => {
    await scenario(async (session) => {
      const other = await Session.create({ engine: { type: "codex" } })
      const home = path.join(Instance.directory, "codex-home")
      const file = path.join(home, "sessions", "shared-thread.jsonl")
      await Bun.write(file, "Native history belongs to Codex\n")
      for (const current of [session, other]) {
        await Session.setEngine({ sessionID: current.id, engine: { type: "codex", thread: "shared-thread" } })
        await NativeStore.migrate(current)
        NativeStore.bind(current.id, home)
        const message = input(current, "Local input")
        NativeStore.add(message, false)
        NativeStore.begin(current.id, message.info.id, MessageID.ascending(), "shared-thread", [message.info.id])
        NativeStore.accept(current.id, message.info.id, "turn-one")
      }
      const before = NativeStore.dispatches(other.id)

      await Session.remove(session.id)
      expect(NativeStore.state(session.id)).toBeUndefined()
      expect(NativeStore.inputs(session.id)).toEqual([])
      expect(NativeStore.dispatches(session.id)).toEqual([])
      expect(NativeStore.state(other.id)?.home).toBe(home)
      expect(NativeStore.inputs(other.id)).toHaveLength(1)
      expect(NativeStore.dispatches(other.id)).toEqual(before)
      expect(await Bun.file(file).text()).toBe("Native history belongs to Codex\n")
    })
  })
})
