import { expect, test } from "bun:test"
import { NativeEvents } from "../../src/native/events"
import { NativeStore } from "../../src/native/store"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

async function scenario(
  run: (value: {
    session: Session.Info
    assistant: MessageV2.Assistant
    events: ReturnType<typeof NativeEvents.create>
  }) => Promise<void>,
) {
  await using dir = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        const user: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "codex",
          model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("fixture") },
        }
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          sessionID: session.id,
          parentID: user.id,
          role: "assistant",
          time: { created: Date.now() },
          modelID: user.model.modelID,
          providerID: user.model.providerID,
          agent: "codex",
          mode: "codex",
          path: { cwd: dir.path, root: dir.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        await Session.updateMessage(user)
        await Session.updateMessage(assistant)
        NativeStore.add({ info: user, parts: [] }, false)
        NativeStore.begin(session.id, user.id, assistant.id, "thread", [user.id])
        NativeStore.accept(session.id, user.id, "turn")
        const events = NativeEvents.create(assistant)
        events.state.active = true
        events.state.thread = "thread"
        events.state.turn = "turn"
        await run({ session, assistant, events })
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
}

function review(id: string, status = "inProgress") {
  return {
    threadId: "thread",
    turnId: "turn",
    reviewId: id,
    targetItemId: "command",
    startedAtMs: 100,
    ...(status === "inProgress" ? {} : { completedAtMs: 200, decisionSource: "agent" }),
    review: { status, riskLevel: "low", userAuthorization: "high", rationale: "Synthetic approval evidence" },
    action: { type: "command", source: "shell", command: "echo fixture", cwd: "/fixture" },
  }
}

test("automatic approval has its own stable identity, persists transitions, and never completes the reviewed tool", async () => {
  await scenario(async ({ session, assistant, events }) => {
    await events.notification("item/started", {
      threadId: "thread",
      turnId: "turn",
      item: {
        id: "command",
        type: "commandExecution",
        command: "echo fixture",
        cwd: "/fixture",
        status: "inProgress",
      },
    })
    await events.notification("item/autoApprovalReview/started", review("first"))
    const before = NativeStore.dispatches(session.id)[0].reviews[0]
    expect(before).toMatchObject({
      tool: "codex.autoApprovalReview",
      callID: "review:first",
      state: { status: "running", time: { start: 100 } },
    })
    await events.notification("item/autoApprovalReview/completed", review("first", "approved"))
    await events.notification("item/autoApprovalReview/completed", review("first", "approved"))
    await events.notification("item/autoApprovalReview/started", review("second"))
    await events.notification("item/autoApprovalReview/completed", review("second", "denied"))
    const parts = (await MessageV2.parts(assistant.id)).filter((part) => part.type === "tool")
    expect(parts).toHaveLength(3)
    expect(parts.find((part) => part.callID === "command")?.state.status).toBe("running")
    expect(parts.find((part) => part.callID === "review:first")).toMatchObject({
      id: before.id,
      state: {
        status: "completed",
        time: { start: 100, end: 200 },
        output: expect.stringContaining("Synthetic approval evidence"),
      },
    })
    expect(parts.find((part) => part.callID === "review:second")?.state.status).toBe("error")
    expect(NativeStore.dispatches(session.id)[0].reviews).toHaveLength(2)
    expect(NativeStore.dispatches(session.id)[0].reviews.find((part) => part.callID === "review:first")).toEqual(
      parts.find((part) => part.callID === "review:first"),
    )
  })
})

test("only an explicit approved review becomes successful; terminal unknown and negative statuses remain visible errors", async () => {
  await scenario(async ({ session, assistant, events }) => {
    for (const status of ["denied", "timedOut", "aborted", "futureStatus", ""]) {
      const value = {
        ...review(status || "empty", status),
        targetItemId: null,
        action: {
          type: "networkAccess",
          target: "api.example.test",
          host: "api.example.test",
          protocol: "https",
          port: 443,
        },
      }
      await events.notification("item/autoApprovalReview/completed", value)
    }
    const parts = (await MessageV2.parts(assistant.id)).filter((part) => part.type === "tool")
    expect(parts).toHaveLength(5)
    expect(parts.every((part) => part.state.status === "error")).toBe(true)
    expect(parts.every((part) => part.state.input.targetItemId === null)).toBe(true)
    expect(NativeStore.dispatches(session.id)[0].reviews).toHaveLength(5)
  })
})

test("unrelated and malformed approval notifications cannot create evidence for the current turn", async () => {
  await scenario(async ({ session, assistant, events }) => {
    await events.notification("item/autoApprovalReview/completed", {
      ...review("other", "approved"),
      threadId: "other",
    })
    await events.notification("item/autoApprovalReview/completed", { ...review("other", "approved"), turnId: "other" })
    await events.notification("item/autoApprovalReview/completed", { ...review("", "approved") })
    await events.notification("item/autoApprovalReview/completed", { ...review("broken", "approved"), review: null })
    await events.notification("autoApprovalReview/strictReviewRequired", {
      threadId: "thread",
      turnId: "turn",
      startedAtMs: 100,
    })
    expect(await MessageV2.parts(assistant.id)).toEqual([])
    expect(NativeStore.dispatches(session.id)[0].reviews).toEqual([])
  })
})

test("ending the turn persists unresolved reviews as errors and rejects late approval evidence", async () => {
  await scenario(async ({ session, assistant, events }) => {
    await events.notification("item/autoApprovalReview/started", review("unfinished"))
    await events.finish({ status: "interrupted", error: "Synthetic disconnect" })
    const parts = (await MessageV2.parts(assistant.id)).filter((part) => part.type === "tool")
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      tool: "codex.autoApprovalReview",
      state: { status: "error", error: "Synthetic disconnect" },
      metadata: { native: { raw: { reviewId: "unfinished" } } },
    })
    expect(NativeStore.dispatches(session.id)[0].reviews).toEqual(parts)
    await events.notification("item/autoApprovalReview/completed", review("unfinished", "approved"))
    expect(await MessageV2.parts(assistant.id)).toEqual(parts)
    expect(NativeStore.dispatches(session.id)[0].reviews).toEqual(parts)
  })
})

test("native usage persists last input context independently of cumulative turn token accounting", async () => {
  await scenario(async ({ assistant, events }) => {
    const usage = (input: number, output: number) => ({
      inputTokens: input,
      outputTokens: output,
      reasoningOutputTokens: 20,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      totalTokens: input + output,
    })
    await events.notification("thread/tokenUsage/updated", {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: { last: usage(100, 30), total: usage(1000, 300), modelContextWindow: 4000 },
    })
    await events.notification("thread/tokenUsage/updated", {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: { last: usage(150, 40), total: usage(1150, 340), modelContextWindow: 4000 },
    })
    expect(assistant.nativeUsage).toMatchObject({ input: 150, total: 190, contextWindow: 4000 })
    expect(assistant.tokens.total).toBe(320)
    expect((await MessageV2.get({ sessionID: assistant.sessionID, messageID: assistant.id })).info).toMatchObject({
      nativeUsage: { input: 150, total: 190, contextWindow: 4000 },
    })
    await events.notification("thread/tokenUsage/updated", {
      threadId: "other",
      turnId: "turn",
      tokenUsage: { last: usage(999, 20), total: usage(999, 20), modelContextWindow: 1000 },
    })
    expect(assistant.nativeUsage?.input).toBe(150)
    await events.notification("thread/tokenUsage/updated", {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: { last: usage(25, 20), total: usage(1175, 360), modelContextWindow: null },
    })
    expect(assistant.nativeUsage?.input).toBe(25)
    expect(assistant.nativeUsage?.contextWindow).toBeUndefined()
  })
})
