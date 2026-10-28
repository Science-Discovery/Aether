import { describe, expect, test } from "bun:test"
import path from "node:path"
import { NativeHistory } from "../../src/native/history"
import { NativeDisplay } from "../../src/native/display"
import { NativeInheritance } from "../../src/native/inheritance"
import { NativeQuestion } from "../../src/native/questions"
import { Protocol } from "../../src/native/protocol"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

const thread = { id: "thread", createdAt: 100, updatedAt: 110, status: { type: "notLoaded" }, model: "current-model" }
const opts = { sessionID: SessionID.make("ses_history"), scope: "home-one", cwd: process.cwd() }
const turn = (id = "turn"): NativeHistory.Turn => ({
  id,
  status: "completed",
  itemsView: "full",
  startedAt: 101,
  completedAt: 102,
  items: [
    {
      id: "user",
      type: "userMessage",
      clientId: "msg_original",
      content: [{ type: "text", text: "Research question" }],
    },
    { id: "answer", type: "agentMessage", text: "Research answer", phase: "final_answer" },
  ],
})
const snapshot = (turns = [turn()]): NativeHistory.Snapshot => ({ thread, turns, complete: true, issues: [] })
const metadata = (value = thread) => ({
  method: "thread/read",
  params: { threadId: "thread", includeTurns: false },
  result: { thread: value },
})
const page = (data: unknown[], nextCursor: string | null = null, cursor?: string) => ({
  method: "thread/turns/list",
  params: { threadId: "thread", itemsView: "full", sortDirection: "asc", ...(cursor ? { cursor } : {}) },
  result: { data, nextCursor },
})

test("history projects async questions and exact Desktop answers from a later completed turn", () => {
  const item = {
    id: "call_question",
    type: "agentMessage",
    text: "Style?",
    delivery: "async",
    questions: [{ title: "Style?", options: null }],
  }
  const first = { ...turn(), items: [turn().items[0], item] }
  const question = NativeQuestion.parse(item, { thread: thread.id, turn: first.id })!
  const second = {
    ...turn("reply"),
    items: [
      {
        id: "desktop-reply",
        type: "userMessage",
        content: [{ type: "text", text: NativeQuestion.reply(question, ["Short"]) }],
      },
      { id: "answer", type: "agentMessage", text: "Received" },
    ],
  }
  const card = (value: NativeHistory.Snapshot) =>
    NativeHistory.project(value, opts)
      .messages.flatMap((entry) => entry.parts)
      .filter((part) => part.type === "text")
      .find((part) => part.nativeQuestion)
  expect(card(snapshot([first]))?.nativeQuestion).toMatchObject({ state: "pending", questions: [{ title: "Style?" }] })
  expect(card(snapshot([first, second]))?.nativeQuestion).toMatchObject({ state: "answered", answers: ["Short"] })
  expect(card(snapshot([first, { ...second, status: "interrupted" }]))?.nativeQuestion?.state).toBe("pending")
})

async function read(steps: unknown[], options?: NativeHistory.Options) {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "responses.json")
  await Bun.write(file, JSON.stringify(steps))
  const client = Protocol.connect({
    executable: process.execPath,
    args: [path.join(import.meta.dir, "history-fixture.ts"), file],
  })
  try {
    const result = await NativeHistory.read(client, "thread", options)
    const inspected = await client.request<{ calls: string[]; remaining: number }>("inspect")
    expect(inspected.remaining).toBe(0)
    expect(
      inspected.calls.every((method) => ["thread/read", "thread/turns/list", "thread/items/list"].includes(method)),
    ).toBe(true)
    return result
  } finally {
    await client.close()
  }
}

describe("native history reading", () => {
  test("reads bounded ascending full turn pages without loading the thread", async () => {
    const result = await read([metadata(), page([turn("one")], "next"), page([turn("two")], null, "next"), metadata()])
    expect(result.complete).toBe(true)
    expect(result.turns.map((item) => item.id)).toEqual(["one", "two"])
    expect(NativeHistory.project(result, opts).messages).toHaveLength(4)
  })

  test("fills summary turns using item pages and checks their turn identity", async () => {
    const result = await read([
      metadata(),
      page([{ ...turn(), items: [], itemsView: "summary" }]),
      {
        method: "thread/items/list",
        params: { turnId: "turn", sortDirection: "asc" },
        result: { data: [{ turnId: "turn", item: turn().items[0] }], nextCursor: "items" },
      },
      {
        method: "thread/items/list",
        params: { turnId: "turn", cursor: "items" },
        result: { data: [{ turnId: "turn", item: turn().items[1] }], nextCursor: null },
      },
      metadata(),
    ])
    expect(result.complete).toBe(true)
    expect(result.turns[0].items).toEqual(turn().items)
    const wrong = await read([
      metadata(),
      page([{ ...turn(), itemsView: "notLoaded" }]),
      {
        method: "thread/items/list",
        result: { data: [{ turnId: "foreign", item: turn().items[0] }], nextCursor: null },
      },
    ])
    expect(wrong.complete).toBe(false)
    expect(wrong.issues[0].message).toContain("another turn")
  })

  test("does not interpret cross-process interrupted turns as a confirmed stop", async () => {
    const result = await read([
      metadata(),
      page([turn("done"), { ...turn("external"), status: "interrupted" }]),
      metadata(),
    ])
    expect(result.complete).toBe(false)
    expect(result.turns.map((value) => value.id)).toEqual(["done"])
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "unsettled", turn: "external" }))
    expect(NativeHistory.project(result, opts).complete).toBe(false)
  })

  test("fork inspection retains terminal history and the positions of unsettled suffixes", async () => {
    const values = [
      turn("done"),
      { ...turn("stopped"), status: "interrupted" },
      { ...turn("failed"), status: "failed" },
    ]
    const result = await read([metadata(), page(values), metadata()], { terminal: true })
    expect(result.complete).toBe(true)
    expect(result.turns).toEqual(values)
    const active = await read(
      [metadata(), page([...values, { ...turn("active"), status: "inProgress" }]), metadata()],
      { terminal: true },
    )
    expect(active.complete).toBe(false)
    expect(active.turns.map((turn) => turn.id)).toEqual(["done", "stopped", "failed", "active"])
    expect(active.issues).toEqual([expect.objectContaining({ code: "unsettled", turn: "active" })])
  })

  test("fork projection shows terminal fragments without inventing a successful tool result", () => {
    const value = {
      ...turn("stopped"),
      status: "interrupted",
      items: [
        ...turn().items,
        {
          id: "command",
          type: "commandExecution",
          status: "inProgress",
          command: "long-running work",
          aggregatedOutput: "partial output",
        },
      ],
    }
    expect(NativeHistory.project(snapshot([value]), opts).messages).toEqual([])
    const result = NativeHistory.project(snapshot([value]), { ...opts, terminal: true })
    expect(result.complete).toBe(true)
    expect(result.messages[1].info).toMatchObject({ role: "assistant", finish: "unknown" })
    const parts = result.messages[1].parts.toSorted((a, b) => a.id.localeCompare(b.id))
    expect(parts.some((part) => part.type === "tool")).toBe(false)
    expect(parts[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("partial output"),
      metadata: { native: { status: "interrupted", raw: value.items[2] } },
    })
    expect(parts).toHaveLength(2)
    expect(value.status).toBe("interrupted")
    expect(value.items[2].status).toBe("inProgress")
  })

  test("refuses complete snapshots when metadata changes or the local connection is active", async () => {
    const changed = await read([metadata(), page([turn()]), metadata({ ...thread, updatedAt: 111 })])
    expect(changed.complete).toBe(false)
    expect(changed.issues[0].code).toBe("changed")
    const active = { ...thread, status: { type: "active" } }
    const result = await read([metadata(active), page([turn()]), metadata(active)])
    expect(result.complete).toBe(false)
    expect(result.issues[0].code).toBe("unsettled")
  })

  test("unsupported methods and malformed replies preserve partial state", async () => {
    const unsupported = await read([metadata(), { method: "thread/turns/list", error: "Method not found" }])
    expect(unsupported.complete).toBe(false)
    expect(unsupported.thread?.id).toBe("thread")
    expect(unsupported.issues[0].code).toBe("unsupported")
    const invalid = await read([metadata(), { method: "thread/turns/list", result: { data: [turn()] } }])
    expect(invalid.complete).toBe(false)
    expect(invalid.turns).toEqual([])
  })

  test("rejects repeated cursors, duplicate IDs, and empty nonterminal pages", async () => {
    const repeated = await read([metadata(), page([turn("one")], "again"), page([turn("two")], "again", "again")])
    expect(repeated.complete).toBe(false)
    expect(repeated.issues[0].message).toContain("cursor")
    const duplicate = await read([metadata(), page([turn(), turn()])])
    expect(duplicate.complete).toBe(false)
    expect(duplicate.issues[0].message).toContain("turn")
    const items = await read([metadata(), page([{ ...turn(), items: [turn().items[0], turn().items[0]] }])])
    expect(items.complete).toBe(false)
    expect(items.issues[0].message).toContain("item")
    const empty = await read([metadata(), page([], "more")])
    expect(empty.complete).toBe(false)
  })

  test("enforces request, item and byte budgets instead of silently truncating", async () => {
    expect((await read([metadata(), page([turn()], "more")], { pages: 1 })).complete).toBe(false)
    expect((await read([metadata(), page([turn()])], { items: 1 })).complete).toBe(false)
    expect((await read([metadata()], { bytes: 1 })).complete).toBe(false)
  })

  test("rejects another thread and propagates caller cancellation", async () => {
    expect((await read([metadata({ ...thread, id: "foreign" })])).complete).toBe(false)
    const controller = new AbortController()
    controller.abort(new Error("test cancelled"))
    await expect(
      NativeHistory.read({ request: () => Promise.reject(new Error("must not call")) }, "thread", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("test cancelled")
  })
})

describe("native history projection", () => {
  test("imported deterministic identities retain observed metadata with or without a native client id", () => {
    for (const client of [true, false]) {
      const value = turn()
      if (!client) delete value.items[0].clientId
      const existing = NativeHistory.project(snapshot([value]), opts).messages
      const user = existing[0].info
      const assistant = existing[1].info
      if (user.role !== "user" || assistant.role !== "assistant") throw new Error("Unexpected projection")
      user.model.modelID = ModelID.make("observed-model")
      assistant.modelID = ModelID.make("observed-model")
      assistant.tokens = { total: 150, input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }
      assistant.nativeUsage = { input: 100, contextWindow: 1000, updatedAt: 1 }
      const result = NativeHistory.project(snapshot([value]), { ...opts, existing })
      expect(result.messages.map((row) => row.info)).toEqual(existing.map((row) => row.info))
    }
  })

  test("segments successive user items within one native turn and counts root usage only once", () => {
    const existing = NativeHistory.project(snapshot(), opts).messages
    const original = existing[0].info
    const receipt = existing[1].info
    if (original.role !== "user" || receipt.role !== "assistant") throw new Error("Unexpected projection")
    original.id = MessageID.make("msg_original")
    receipt.parentID = original.id
    receipt.id = MessageID.make("msg_root_assistant")
    receipt.tokens = { total: 150, input: 100, output: 50, reasoning: 20, cache: { read: 0, write: 0 } }
    receipt.nativeUsage = { input: 100, contextWindow: 1000, updatedAt: 1 }
    receipt.modelID = ModelID.make("observed-model")
    const value = turn()
    value.items.splice(
      1,
      0,
      { id: "before", type: "agentMessage", text: "Before the supplement" },
      { id: "supplement", type: "userMessage", content: [{ type: "text", text: "More context" }] },
    )
    const result = NativeHistory.project(snapshot([value]), { ...opts, existing, receipts: [receipt] })
    expect(result.messages.map((entry) => entry.info.role)).toEqual(["user", "assistant", "user", "assistant"])
    const [first, before, second, after] = result.messages
    expect(before.info).toMatchObject({ id: receipt.id, parentID: first.info.id, tokens: receipt.tokens })
    expect(after.info).toMatchObject({ id: NativeDisplay.id(second.info.id), parentID: second.info.id })
    if (after.info.role !== "assistant") throw new Error("Expected a display segment")
    expect(after.info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(after.info.nativeUsage).toBeUndefined()
    expect(before.parts).toContainEqual(expect.objectContaining({ text: "Before the supplement" }))
    expect(after.parts).toContainEqual(expect.objectContaining({ text: "Research answer" }))
    expect(new Set(result.links.map((link) => link.turn))).toEqual(new Set(["turn"]))
    expect(NativeInheritance.missing(result)).toBe(false)
    expect(
      NativeHistory.project(snapshot([value]), { ...opts, existing: result.messages, receipts: [receipt] }),
    ).toEqual(result)
  })

  test("produces schema-valid stable IDs with source and turn isolation", () => {
    const first = NativeHistory.project(snapshot(), opts)
    expect(first.complete).toBe(true)
    first.messages.forEach((row) => expect(MessageV2.WithParts.safeParse(row).success).toBe(true))
    expect(NativeHistory.project(snapshot(), opts)).toEqual(first)
    expect(NativeHistory.project(snapshot(), { ...opts, scope: "home-two" }).messages[0].info.id).not.toBe(
      first.messages[0].info.id,
    )
    expect(
      NativeHistory.project(snapshot(), { ...opts, sessionID: SessionID.make("ses_other") }).messages[0].info.id,
    ).not.toBe(first.messages[0].info.id)
    expect(NativeHistory.project(snapshot([turn("other")]), opts).messages[0].info.id).not.toBe(
      first.messages[0].info.id,
    )
    expect(first.messages[1].info).toMatchObject({ modelID: "unknown", parentID: first.messages[0].info.id })
    expect(first.links[0]).toMatchObject({ turn: "turn", item: "user", client: "msg_original" })
  })

  test("reuses matched local user and assistant IDs without inventing historical model telemetry", () => {
    const existing = NativeHistory.project(snapshot(), opts).messages
    const user = existing[0].info
    const assistant = existing[1].info
    if (user.role !== "user" || assistant.role !== "assistant") throw new Error("Unexpected projection")
    user.id = MessageID.make("msg_original")
    user.model.modelID = ModelID.make("previous-model")
    assistant.id = MessageID.make("msg_existing_assistant")
    assistant.parentID = user.id
    assistant.modelID = ModelID.make("previous-model")
    const result = NativeHistory.project(snapshot(), { ...opts, existing })
    expect(result.messages[0].info.id).toBe(user.id)
    expect(result.messages[1].info).toMatchObject({ id: assistant.id, parentID: user.id, modelID: "previous-model" })
    expect(
      NativeHistory.project(snapshot(), { ...opts, sessionID: SessionID.make("ses_other"), existing }).messages[0].info
        .id,
    ).not.toBe(user.id)
  })

  test("rebuilds assistant IDs from durable receipts after the display cache is cleared", () => {
    const existing = NativeHistory.project(snapshot(), opts).messages
    const user = existing[0].info
    const assistant = existing[1].info
    if (user.role !== "user" || assistant.role !== "assistant") throw new Error("Unexpected projection")
    user.id = MessageID.make("msg_original")
    assistant.parentID = user.id
    const receipt = {
      ...assistant,
      id: MessageID.make("msg_durable_assistant"),
      modelID: ModelID.make("persisted-model"),
    }
    const expected = NativeHistory.project(snapshot(), { ...opts, existing, receipts: [receipt] })
    const rebuilt = NativeHistory.project(snapshot(), { ...opts, existing: [existing[0]], receipts: [receipt] })
    expect(rebuilt).toEqual(expected)
    expect(rebuilt.messages[1].info).toMatchObject({ id: receipt.id, parentID: user.id, modelID: "persisted-model" })
    const foreign = { ...receipt, sessionID: SessionID.make("ses_foreign") }
    expect(
      NativeHistory.project(snapshot(), { ...opts, existing: [existing[0]], receipts: [foreign] }).messages[1].info.id,
    ).not.toBe(receipt.id)
  })

  test("renders the complete external user bubble while keeping its metadata anchor out of the body", () => {
    const value = turn()
    value.items[0].content = [
      { type: "text", text: "First question" },
      { type: "image", url: "data:image/png;base64,cGxvdA==" },
      { type: "text", text: "Second question" },
      { type: "text", text: "Third question" },
    ]
    const result = NativeHistory.project(snapshot([value]), opts)
    const parts = result.messages[0].parts.toSorted((left, right) => left.id.localeCompare(right.id))
    // UserMessageDisplay renders the first non-synthetic, non-steer text part.
    const visible = parts.filter((part) => part.type === "text" && !part.synthetic && !part.metadata?.steer)
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({ type: "text", text: "First question\n\nSecond question\n\nThird question" })
    expect(parts[0]).toMatchObject({
      type: "text",
      ignored: true,
      synthetic: true,
      metadata: { native: { raw: value.items[0] } },
    })
    expect(parts.filter((part) => part.type === "file")).toHaveLength(1)
    expect(result.complete).toBe(true)
  })

  test("keeps the original local user bubble visible when a lower-sorting history anchor is added", () => {
    const projected = NativeHistory.project(snapshot(), opts).messages[0]
    const original: MessageV2.TextPart = {
      id: PartID.make("prt_original"),
      messageID: projected.info.id,
      sessionID: opts.sessionID,
      type: "text",
      text: "Original local question",
    }
    const parts = [original, ...projected.parts.filter((part) => part.type === "text" && part.ignored)].toSorted(
      (left, right) => left.id.localeCompare(right.id),
    )
    expect(parts.find((part) => part.type === "text" && !part.synthetic && !part.metadata?.steer)).toMatchObject({
      text: "Original local question",
    })
  })

  test("keeps user image inputs, their original raw content and text in order", () => {
    const value = turn()
    value.items[0].content = [
      { type: "text", text: "Explain the plot" },
      { type: "image", url: "data:image/png;base64,aGVsbG8=" },
      { type: "localImage", path: path.join(process.cwd(), "plot.jpg") },
    ]
    const result = NativeHistory.project(snapshot([value]), opts)
    expect(result.complete).toBe(true)
    expect(result.messages[0].parts.filter((part) => part.type === "file").map((part) => part.mime)).toEqual([
      "image/png",
      "image/jpeg",
    ])
    const metadata = result.messages[0].parts[0]
    expect(metadata.type === "text" && metadata.metadata?.native.raw).toEqual(value.items[0])
  })

  test("stores one raw user payload rather than repeating it in every text part", () => {
    const value = turn()
    value.items[0].content = Array.from({ length: 20 }, (_, index) => ({ type: "text", text: `Context ${index}` }))
    const result = NativeHistory.project(snapshot([value]), opts)
    expect(result.complete).toBe(true)
    const parts = result.messages[0].parts.filter((part) => part.type === "text")
    expect(parts.filter((part) => part.metadata?.native.raw !== undefined)).toHaveLength(1)
  })

  test("shows unknown item and image file IDs without authorizing cache replacement", () => {
    const value = turn()
    value.items[0].content = [{ type: "image", fileId: "native-file" }]
    value.items.push({ id: "future", type: "futureResearchTool", result: { finding: 42 } })
    const result = NativeHistory.project(snapshot([value]), opts)
    expect(result.complete).toBe(false)
    expect(JSON.stringify(result.messages)).toContain("native-file")
    const part = result.messages[1].parts.at(-1)
    expect(part?.type).toBe("tool")
    expect(part?.type === "tool" && part.metadata?.native.raw).toEqual(value.items.at(-1))
    expect(part?.type === "tool" && part.tool).toBe("codex.futureResearchTool")
  })

  test("projects reasoning and command/file tools while retaining raw native evidence", () => {
    const value = turn()
    value.items.splice(
      1,
      0,
      { id: "reasoning", type: "reasoning", summary: ["Reasoning summary"], content: [] },
      {
        id: "command",
        type: "commandExecution",
        command: "echo research",
        cwd: opts.cwd,
        status: "completed",
        aggregatedOutput: "research",
        exitCode: 0,
      },
      { id: "changes", type: "fileChange", changes: [{ path: "paper.tex", diff: "-a\n+b" }], status: "failed" },
    )
    const result = NativeHistory.project(snapshot([value]), opts)
    expect(result.complete).toBe(true)
    expect(result.messages[1].parts.map((part) => part.type)).toEqual(["reasoning", "tool", "tool", "text"])
    expect(result.messages[1].parts[1]).toMatchObject({
      tool: "bash",
      state: { status: "completed", output: "research" },
    })
    expect(result.messages[1].parts[2]).toMatchObject({ tool: "codex.fileChange", state: { status: "error" } })
    result.messages.forEach((row) => expect(MessageV2.WithParts.safeParse(row).success).toBe(true))
  })

  test("retains native user content and assistant item order after database ID sorting", async () => {
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const value = turn()
        value.items[0].content = Array.from({ length: 12 }, (_, index) => ({ type: "text", text: `Context ${index}` }))
        value.items.splice(
          1,
          0,
          { id: "thinking", type: "reasoning", summary: ["First think"] },
          {
            id: "command",
            type: "commandExecution",
            command: "echo result",
            status: "completed",
            aggregatedOutput: "result",
          },
          { id: "comment", type: "agentMessage", text: "Then explain" },
        )
        const options = { ...opts, sessionID: session.id }
        const result = NativeHistory.project(snapshot([value]), options)
        expect(result.complete).toBe(true)
        for (const row of result.messages) {
          await Session.updateMessage(row.info)
          for (const part of row.parts.toReversed()) await Session.updatePart(part)
          const stored = await MessageV2.parts(row.info.id)
          expect(stored.map((part) => part.id)).toEqual(row.parts.map((part) => part.id))
          expect(row.parts.toSorted((left, right) => left.id.localeCompare(right.id)).map((part) => part.id)).toEqual(
            row.parts.map((part) => part.id),
          )
        }
        Database.detach(Instance.project.id)
        const user = await MessageV2.parts(result.messages[0].info.id)
        expect(user.flatMap((part) => (part.type === "text" && !part.ignored ? [part.text] : []))).toEqual([
          Array.from({ length: 12 }, (_, index) => `Context ${index}`).join("\n\n"),
        ])
        const assistant = await MessageV2.parts(result.messages[1].info.id)
        expect(assistant.map((part) => part.type)).toEqual(["reasoning", "tool", "text", "text"])
        expect(NativeHistory.project(snapshot([value]), options)).toEqual(result)
      },
    })
  })

  test("does not claim empty, orphaned, duplicate or unfinished items are complete history", () => {
    expect(NativeHistory.project(snapshot([{ ...turn(), items: [] }]), opts).complete).toBe(false)
    const orphan = NativeHistory.project(snapshot([{ ...turn(), items: [turn().items[1]] }]), opts)
    expect(orphan.complete).toBe(false)
    const ids = orphan.messages.flatMap((row) => row.parts.map((part) => part.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      NativeHistory.project(snapshot([{ ...turn(), items: [turn().items[0], turn().items[0]] }]), opts).complete,
    ).toBe(false)
    expect(
      NativeHistory.project(
        snapshot([
          { ...turn(), items: [...turn().items, { id: "ongoing", type: "commandExecution", status: "inProgress" }] },
        ]),
        opts,
      ).complete,
    ).toBe(false)
    const missing = NativeHistory.project(
      snapshot([
        {
          ...turn(),
          items: [
            ...turn().items,
            {
              id: "missing-output",
              type: "commandExecution",
              command: "echo x",
              status: "completed",
              aggregatedOutput: null,
            },
          ],
        },
      ]),
      opts,
    )
    expect(missing.complete).toBe(false)
    expect(missing.issues[0].message).toContain("command output")
  })
})
