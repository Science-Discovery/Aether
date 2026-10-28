import { describe, expect, test } from "bun:test"
import { NativeHistory } from "../../src/native/history"
import { NativeDisplay } from "../../src/native/display"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
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

function turn(id = "turn", client?: MessageID): NativeHistory.Turn {
  return {
    id,
    status: "completed",
    itemsView: "full",
    startedAt: 101,
    completedAt: 102,
    items: [
      {
        id: "user",
        type: "userMessage",
        ...(client ? { clientId: client } : {}),
        content: [{ type: "text", text: `Native question ${id}` }],
      },
      { id: "answer", type: "agentMessage", text: `Native answer ${id}`, phase: "final_answer" },
    ],
  }
}

function snapshot(turns = [turn()]): NativeHistory.Snapshot {
  return {
    thread: {
      id: "thread",
      createdAt: 100,
      updatedAt: 110,
      status: { type: "notLoaded" },
      model: "current-model-is-not-historical-telemetry",
    },
    turns,
    complete: true,
    issues: [],
  }
}

function input(session: Session.Info, text: string, time = 100): MessageV2.WithParts {
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

describe("native history cache synchronization", () => {
  test.each(["complete", "omitted", "shorter", "rewritten"])(
    "splits a legacy aggregate reply without losing observed text when native history is %s",
    async (mode) => {
      await scenario(async (session) => {
        const request = input(session, "Original question", 101000)
        const supplement = input(session, "Additional instruction", 101002)
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          parentID: request.info.id,
          time: { created: 101001, completed: 102000 },
          providerID: ProviderID.make("codex-native"),
          modelID: ModelID.make("research"),
          agent: "codex",
          mode: "codex",
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { total: 150, input: 100, output: 50, reasoning: 20, cache: { read: 0, write: 0 } },
          nativeUsage: { input: 100, contextWindow: 1000, updatedAt: 102000 },
          finish: "stop",
        }
        const parts: MessageV2.TextPart[] = ["before", "answer"].map((item) => ({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: item === "before" ? "Before steering: the full observed paragraph" : "After steering: the final answer",
          time: { start: item === "before" ? 101001 : 101003, end: 102000 },
          metadata: { native: { engine: "codex", turn: "turn", item, type: "agentMessage" } },
        }))
        NativeStore.add(request, false)
        NativeStore.begin(session.id, request.info.id, assistant.id, "thread", [request.info.id])
        NativeStore.accept(session.id, request.info.id, "turn")
        NativeStore.receipt(assistant)
        const text = supplement.parts[0]
        if (text.type !== "text") throw new Error("Expected supplemental text")
        text.metadata = { nativeSteer: { thread: "thread", turn: "turn", parent: request.info.id, status: "accepted" } }
        NativeStore.steer(supplement, assistant.id, "thread", "turn")
        NativeStore.delivery(session.id, supplement.info.id, "accepted")
        await cache(request)
        await cache({ info: assistant, parts })
        await cache(supplement)
        const value = turn("turn", request.info.id)
        value.items = [
          value.items[0],
          ...(mode === "omitted"
            ? []
            : [
                {
                  id: "before",
                  type: "agentMessage",
                  text: mode === "shorter" ? "Before" : mode === "rewritten" ? "Different text" : parts[0].text,
                },
              ]),
          {
            id: "supplement",
            type: "userMessage",
            clientId: supplement.info.id,
            content: [{ type: "text", text: text.text }],
          },
          { id: "answer", type: "agentMessage", text: parts[1].text, phase: "final_answer" },
        ]
        const result = await NativeSync.apply(session, snapshot([value]))
        expect(result.state).toBe(mode === "complete" ? "synced" : "partial")
        const messages = await NativeStore.history(session.id)
        expect(messages.map((entry) => entry.info.role)).toEqual(["user", "assistant", "user", "assistant"])
        expect(messages[1].info).toMatchObject({
          id: assistant.id,
          parentID: request.info.id,
          tokens: assistant.tokens,
        })
        expect(messages[1].parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
          parts[0].text,
        ])
        expect(messages[3].info).toMatchObject({
          id: NativeDisplay.id(supplement.info.id),
          parentID: supplement.info.id,
        })
        expect(messages[3].parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
          parts[1].text,
        ])
        const replies = messages.flatMap((entry) => (entry.info.role === "assistant" ? [entry.info] : []))
        expect(replies.reduce((sum, entry) => sum + (entry.tokens.total ?? 0), 0)).toBe(150)
        expect(replies.filter((entry) => entry.nativeUsage)).toHaveLength(1)
        expect(
          messages
            .flatMap((entry) => entry.parts)
            .filter((part) => "metadata" in part && part.metadata?.native?.item === "answer"),
        ).toHaveLength(1)
        await NativeSync.apply(session, snapshot([value]))
        expect(await NativeStore.history(session.id)).toEqual(messages)
        Database.detach(Instance.project.id)
        await NativeSync.apply(session, snapshot([value]))
        expect(await NativeStore.history(session.id)).toEqual(messages)
      })
    },
  )

  test("imports completed turns with stable identities and does not duplicate repeated snapshots", async () => {
    await scenario(async (session) => {
      expect(await NativeSync.apply(session, snapshot())).toMatchObject({ state: "synced", messages: 2 })
      const before = await NativeStore.history(session.id)
      expect(before).toHaveLength(2)
      expect(before.map((message) => message.info.role)).toEqual(["user", "assistant"])
      expect(before[1].info).toMatchObject({ parentID: before[0].info.id, modelID: "unknown", finish: "stop" })
      expect(before[1].parts).toContainEqual(expect.objectContaining({ type: "text", text: "Native answer turn" }))
      expect(NativeStore.state(session.id)?.time_synced).toEqual(expect.any(Number))

      await NativeSync.apply(session, snapshot())
      expect(await NativeStore.history(session.id)).toEqual(before)
      expect(NativeStore.inputs(session.id)).toEqual([])
      expect(NativeStore.dispatches(session.id)).toEqual([])
      Database.detach(Instance.project.id)
      await NativeSync.apply(session, snapshot())
      expect(await NativeStore.history(session.id)).toEqual(before)
    })
  })

  test("rebuilds cleared cache from the native snapshot and immutable research inputs", async () => {
    await scenario(async (session) => {
      const context = input(session, "Selected paper context", 100)
      context.parts.push({
        id: PartID.ascending(),
        messageID: context.info.id,
        sessionID: session.id,
        type: "text",
        text: "Page 3, equation 2",
        synthetic: true,
        metadata: { citation: { page: 3, equation: 2 } },
      })
      const request = input(session, "Explain the original attachment", 200)
      request.parts.push({
        id: PartID.ascending(),
        messageID: request.info.id,
        sessionID: session.id,
        type: "file",
        mime: "image/png",
        filename: "plot.png",
        url: "data:image/png;base64,cGxvdA==",
      })
      const pending = input(session, "Unsent noReply context", 300)
      const failed = input(session, "Failed request must remain visible", 400)
      for (const message of [context, request, pending, failed]) {
        await cache(message)
        NativeStore.add(message, message === context || message === pending)
      }
      NativeStore.fail(session.id, failed.info.id)
      const assistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant",
        parentID: request.info.id,
        time: { created: 201, completed: 202 },
        modelID: ModelID.make("research"),
        providerID: ProviderID.make("codex-native"),
        mode: "codex",
        agent: "codex",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 18, output: 9, reasoning: 4, cache: { read: 7, write: 0 } },
        variant: "high",
      }
      NativeStore.begin(session.id, request.info.id, assistant.id, "thread", [context.info.id, request.info.id])
      NativeStore.receipt(assistant)
      NativeStore.accept(session.id, request.info.id, "turn")
      const review: MessageV2.ToolPart = {
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: assistant.id,
        type: "tool",
        callID: "review-one",
        tool: "codex.approvalReview",
        state: {
          status: "completed",
          input: { command: "read paper" },
          output: "Allowed by automatic review",
          title: "Automatic approval",
          metadata: { decision: "allow" },
          time: { start: 201, end: 202 },
        },
      }
      NativeStore.review(session.id, request.info.id, review)
      await cache({ info: assistant, parts: [review] })
      const original = NativeStore.inputs(session.id)
      for (const message of await NativeStore.history(session.id))
        await Session.removeMessage({ sessionID: session.id, messageID: message.info.id })
      expect(await NativeStore.history(session.id)).toEqual([])
      Database.detach(Instance.project.id)

      expect(await NativeSync.apply(session, snapshot([turn("turn", request.info.id)]))).toMatchObject({
        state: "synced",
      })
      const messages = await NativeStore.history(session.id)
      expect(messages).toHaveLength(5)
      for (const message of [context, request, pending, failed]) {
        expect(messages.find((entry) => entry.info.id === message.info.id)?.parts).toEqual(
          expect.arrayContaining(message.parts),
        )
      }
      expect(messages.filter((entry) => entry.info.role === "assistant")).toEqual([
        expect.objectContaining({
          info: expect.objectContaining({
            id: assistant.id,
            parentID: request.info.id,
            modelID: "research",
            variant: "high",
            tokens: assistant.tokens,
          }),
        }),
      ])
      expect(messages.find((entry) => entry.info.id === assistant.id)?.parts).toContainEqual(review)
      expect(NativeStore.inputs(session.id)).toEqual(original)
      expect(NativeStore.pending(session.id).map((entry) => entry.id)).toEqual([pending.info.id])
      await NativeSync.apply(session, snapshot([turn("turn", request.info.id)]))
      expect(await NativeStore.history(session.id)).toEqual(messages)
    })
  })

  test("retains migrated noReply context whose original dispatch association is unknown", async () => {
    await scenario(async (session) => {
      const context = input(session, "Legacy citation metadata")
      NativeStore.add(context, true)
      Database.attach(Instance.project.id)
        .$client.prepare("UPDATE native_input SET state = 'consumed' WHERE id = ?")
        .run(context.info.id)
      expect(await NativeSync.apply(session, snapshot())).toMatchObject({ state: "synced" })
      expect(
        (await NativeStore.history(session.id)).find((message) => message.info.id === context.info.id)?.parts,
      ).toEqual(context.parts)
      expect(NativeStore.pending(session.id)).toEqual([])
    })
  })

  test("adds available turns from partial history without replacing or deleting old cache", async () => {
    await scenario(async (session) => {
      await NativeSync.apply(session, snapshot([turn("old")]))
      const before = await NativeStore.history(session.id)
      const synced = NativeStore.state(session.id)?.time_synced
      const partial = snapshot([turn("new")])
      partial.complete = false
      partial.issues.push({ code: "unavailable", message: "The next history page was unavailable" })

      expect(await NativeSync.apply(session, partial)).toMatchObject({
        state: "partial",
        error: expect.stringContaining("next history page"),
      })
      const after = await NativeStore.history(session.id)
      expect(after).toHaveLength(4)
      expect(after).toEqual(expect.arrayContaining(before))
      expect(NativeStore.state(session.id)?.time_synced).toBe(synced)
      await NativeSync.apply(session, partial)
      expect(await NativeStore.history(session.id)).toEqual(after)

      await NativeSync.apply(session, snapshot([turn("new")]))
      expect(await NativeStore.history(session.id)).toHaveLength(2)
    })
  })

  test("keeps the previous cache and sync marker when no native thread could be read", async () => {
    await scenario(async (session) => {
      await NativeSync.apply(session, snapshot())
      const before = await NativeStore.history(session.id)
      const synced = NativeStore.state(session.id)?.time_synced
      expect(
        await NativeSync.apply(session, {
          turns: [],
          complete: false,
          issues: [{ code: "unavailable", message: "Offline" }],
        }),
      ).toMatchObject({ state: "unavailable", error: "Offline" })
      expect(await NativeStore.history(session.id)).toEqual(before)
      expect(NativeStore.state(session.id)?.time_synced).toBe(synced)
    })
  })

  test.each(["new", "cached"])("retains an unknown item including raw data for a %s turn", async (mode) => {
    await scenario(async (session) => {
      if (mode === "cached") await NativeSync.apply(session, snapshot())
      const before = await NativeStore.history(session.id)
      const value = turn()
      const unknown = { id: "future", type: "futureResearchTool", result: { finding: 42, source: "paper" } }
      value.items.push(unknown)

      expect(await NativeSync.apply(session, snapshot([value]))).toMatchObject({
        state: "partial",
        error: expect.stringContaining("futureResearchTool"),
      })
      const messages = await NativeStore.history(session.id)
      const assistant = messages.find((message) => message.info.role === "assistant")
      expect(messages).toHaveLength(2)
      expect(assistant?.parts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          tool: "codex.futureResearchTool",
          metadata: expect.objectContaining({ native: expect.objectContaining({ raw: unknown }) }),
        }),
      )
      for (const message of before)
        expect(messages.find((entry) => entry.info.id === message.info.id)?.parts).toEqual(
          expect.arrayContaining(message.parts),
        )
    })
  })

  test("appends a missing original image once across repeated partial snapshots and reopen", async () => {
    await scenario(async (session) => {
      const request = input(session, "Explain this plot")
      const image: MessageV2.FilePart = {
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: request.info.id,
        type: "file",
        mime: "image/png",
        filename: "plot.png",
        url: "data:image/png;base64,cGxvdA==",
      }
      request.parts.push(image)
      NativeStore.add(request, false)
      await cache({ info: request.info, parts: [request.parts[0]] })
      NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread", [request.info.id])
      NativeStore.accept(session.id, request.info.id, "turn")
      const partial = snapshot([turn("turn", request.info.id)])
      partial.complete = false
      partial.issues.push({ code: "unavailable", message: "Another page was unavailable" })

      expect(await NativeSync.apply(session, partial)).toMatchObject({ state: "partial" })
      const before = await NativeStore.history(session.id)
      const files = before
        .find((message) => message.info.id === request.info.id)
        ?.parts.filter((part) => part.type === "file")
      expect(files).toEqual([expect.objectContaining({ type: "file", mime: image.mime, url: image.url })])
      expect(files?.[0].id).not.toBe(image.id)
      expect(NativeStore.inputs(session.id)[0]?.data).toEqual(request)
      await NativeSync.apply(session, partial)
      expect(await NativeStore.history(session.id)).toEqual(before)
      Database.detach(Instance.project.id)
      await NativeSync.apply(session, partial)
      expect(await NativeStore.history(session.id)).toEqual(before)
      expect(NativeStore.pending(session.id)).toEqual([])
    })
  })

  test("appends unknown evidence after streamed parts without reordering or duplicating repeated partial reads", async () => {
    await scenario(async (session) => {
      await NativeSync.apply(session, snapshot())
      const assistant = (await NativeStore.history(session.id)).find((message) => message.info.role === "assistant")
      if (!assistant) throw new Error("Expected the completed native reply")
      for (const part of assistant.parts)
        await Session.removePart({ sessionID: session.id, messageID: assistant.info.id, partID: part.id })
      const parts: MessageV2.Part[] = [
        {
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistant.info.id,
          type: "reasoning",
          text: "Previously streamed reasoning",
          time: { start: 101000, end: 101500 },
          metadata: { native: { engine: "codex", turn: "turn", item: "reasoning", type: "reasoning" } },
        },
        {
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistant.info.id,
          type: "text",
          text: "Previously streamed answer",
          time: { start: 101500, end: 102000 },
          metadata: { native: { engine: "codex", turn: "turn", item: "answer", type: "agentMessage" } },
        },
      ]
      await cache({ info: assistant.info, parts })
      const value = turn()
      value.items.splice(1, 0, { id: "reasoning", type: "reasoning", summary: ["Incomplete new summary"], content: [] })
      value.items.push({ id: "future", type: "futureResearchTool", result: { finding: 42 } })
      const partial = snapshot([value])

      expect(await NativeSync.apply(session, partial)).toMatchObject({ state: "partial" })
      const before = await NativeStore.history(session.id)
      const output = before.find((message) => message.info.id === assistant.info.id)?.parts
      expect(output?.slice(0, 2)).toEqual(parts)
      expect(output).toHaveLength(3)
      expect(output?.[2]).toMatchObject({ type: "tool", callID: "future", tool: "codex.futureResearchTool" })
      await NativeSync.apply(session, partial)
      expect(await NativeStore.history(session.id)).toEqual(before)

      value.items.push({ id: "later", type: "futureResearchTool", result: { finding: 43 } })
      await NativeSync.apply(session, partial)
      const after = await NativeStore.history(session.id)
      const appended = after.find((message) => message.info.id === assistant.info.id)?.parts
      expect(appended?.slice(0, 3)).toEqual(output)
      expect(appended).toHaveLength(4)
      expect(appended?.[3]).toMatchObject({ type: "tool", callID: "later" })
      await NativeSync.apply(session, partial)
      expect(await NativeStore.history(session.id)).toEqual(after)
    })
  })

  test.each(["empty", "unrelated"])("preserves accepted delivery when a complete snapshot is %s", async (mode) => {
    await scenario(async (session) => {
      const request = input(session, "Confirmed native request")
      NativeStore.add(request, false)
      NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread", [request.info.id])
      NativeStore.accept(session.id, request.info.id, "confirmed")
      await NativeSync.apply(session, snapshot([turn("confirmed", request.info.id)]))
      const before = await NativeStore.history(session.id)
      const marker = NativeStore.state(session.id)?.time_synced
      const missing = snapshot(mode === "empty" ? [] : [turn("unrelated")])

      expect(await NativeSync.apply(session, missing)).toMatchObject({
        state: "partial",
        error: expect.stringContaining("absent from this snapshot"),
      })
      const after = await NativeStore.history(session.id)
      expect(after).toEqual(expect.arrayContaining(before))
      expect(NativeStore.state(session.id)?.time_synced).toBe(marker)
      expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "accepted", turn_id: "confirmed" })
      expect(NativeStore.pending(session.id)).toEqual([])
      await NativeSync.apply(session, missing)
      expect(await NativeStore.history(session.id)).toEqual(after)
    })
  })

  test("reconciles an uncertain dispatch from a matching native client ID without replaying input", async () => {
    await scenario(async (session) => {
      const request = input(session, "Response was lost after dispatch")
      NativeStore.add(request, false)
      NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread", [request.info.id])
      NativeStore.uncertain(session.id, request.info.id)

      await NativeSync.apply(session, snapshot([turn("confirmed", request.info.id)]))
      expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "accepted", turn_id: "confirmed" })
      expect(NativeStore.pending(session.id)).toEqual([])
      expect(NativeStore.inputs(session.id)[0]?.state).toBe("consumed")
      const messages = await NativeStore.history(session.id)
      expect(messages).toHaveLength(2)
      expect(messages[0].info.id).toBe(request.info.id)
      expect(messages[0].parts).toEqual(expect.arrayContaining(request.parts))
      NativeStore.uncertain(session.id, request.info.id)
      await NativeSync.apply(session, snapshot([turn("confirmed", request.info.id)]))
      expect(NativeStore.dispatches(session.id)).toHaveLength(1)
      expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "accepted", turn_id: "confirmed" })
      expect(await NativeStore.history(session.id)).toEqual(messages)
    })
  })

  test.each(["empty", "unrelated"])("keeps uncertain input visible when native history is %s", async (mode) => {
    await scenario(async (session) => {
      const request = input(session, "No client ID match in history")
      NativeStore.add(request, false)
      NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread", [request.info.id])
      NativeStore.uncertain(session.id, request.info.id)

      const missing = snapshot(mode === "empty" ? [] : [turn("unrelated")])
      expect(await NativeSync.apply(session, missing)).toMatchObject({
        state: "partial",
        error: expect.stringContaining("will not be resent automatically"),
      })
      expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "uncertain", turn_id: null })
      expect(NativeStore.pending(session.id)).toEqual([])
      expect(
        (await NativeStore.history(session.id)).find((message) => message.info.id === request.info.id)?.parts,
      ).toEqual(request.parts)
      expect(NativeStore.state(session.id)?.time_synced).toBeNull()
      const before = await NativeStore.history(session.id)
      await NativeSync.apply(session, missing)
      expect(await NativeStore.history(session.id)).toEqual(before)
      expect(NativeStore.pending(session.id)).toEqual([])
    })
  })

  test("does not reconcile a client ID that occurs in multiple native turns", async () => {
    await scenario(async (session) => {
      const request = input(session, "Ambiguous delivery evidence")
      NativeStore.add(request, false)
      NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread", [request.info.id])
      NativeStore.uncertain(session.id, request.info.id)

      expect(
        await NativeSync.apply(session, snapshot([turn("first", request.info.id), turn("second", request.info.id)])),
      ).toMatchObject({ state: "partial" })
      expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "uncertain", turn_id: null })
      expect(NativeStore.pending(session.id)).toEqual([])
    })
  })

  test.each(["parts", "sync marker"])(
    "rolls back cache replacement and reconciliation if writing %s fails",
    async (mode) => {
      await scenario(async (session) => {
        const old = input(session, "Previously readable cache")
        await cache(old)
        const request = input(session, "Uncertain submission")
        NativeStore.add(request, false)
        NativeStore.begin(session.id, request.info.id, MessageID.ascending(), "thread", [request.info.id])
        NativeStore.uncertain(session.id, request.info.id)
        const before = await NativeStore.history(session.id)
        const sqlite = Database.attach(Instance.project.id).$client
        sqlite.exec(`CREATE TEMP TRIGGER reject_native_write BEFORE ${mode === "parts" ? "INSERT ON part" : "UPDATE ON native_state"}
        BEGIN SELECT RAISE(ABORT, 'native cache write failed'); END`)
        try {
          await expect(NativeSync.apply(session, snapshot([turn("confirmed", request.info.id)]))).rejects.toThrow(
            "native cache write failed",
          )
          expect(await NativeStore.history(session.id)).toEqual(before)
          expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "uncertain", turn_id: null })
          expect(NativeStore.state(session.id)?.time_synced).toBeNull()
        } finally {
          sqlite.exec("DROP TRIGGER reject_native_write")
        }
        await NativeSync.apply(session, snapshot([turn("confirmed", request.info.id)]))
        expect(await NativeStore.history(session.id)).toHaveLength(2)
        expect(NativeStore.dispatches(session.id)[0]).toMatchObject({ state: "accepted", turn_id: "confirmed" })
      })
    },
  )
})
