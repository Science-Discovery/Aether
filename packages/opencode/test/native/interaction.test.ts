import { expect, test } from "bun:test"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeInteraction } from "../../src/native/interaction"
import { NativeSession } from "../../src/native/session"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import type { Native } from "../../src/native/schema"
import type { NativeHistory } from "../../src/native/history"
import { Protocol } from "../../src/native/protocol"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const fixture = path.join(import.meta.dir, "interaction-fixture.ts")
async function scenario(mode: string, run: (session: Session.Info, dir: string) => Promise<void>, start?: string) {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" "${dir.path}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' '${dir.path.replaceAll("'", "'\\''")}' "$@"\n`,
  )
  if (process.platform !== "win32") await chmod(file, 0o755)
  await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode, start }))
  await Bun.write(path.join(cfg.path, "aether.json"), JSON.stringify({ native: { codex: { path: file } } }))
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex", permission: "user" } })
        await NativeStore.migrate(session)
        await Session.setEngine({ sessionID: session.id, engine: { ...session.engine!, thread: "thread" } })
        await run(await Session.get(session.id), dir.path)
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

async function calls(dir: string) {
  return (await Bun.file(path.join(dir, "calls.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
}

async function setup(session: Session.Info, dir: string) {
  const user: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    time: { created: 100 },
    agent: "codex",
    model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("native-model") },
  }
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    parentID: user.id,
    sessionID: session.id,
    role: "assistant",
    time: { created: 101 },
    agent: "codex",
    mode: "codex",
    providerID: user.model.providerID,
    modelID: user.model.modelID,
    variant: "high",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  NativeStore.add(
    {
      info: user,
      parts: [
        { id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "Original question" },
      ],
    },
    false,
  )
  NativeStore.begin(session.id, user.id, assistant.id, "thread", [user.id])
  NativeStore.accept(session.id, user.id, "turn")
  NativeStore.receipt(assistant)
  await Session.updateMessage(user)
  await Session.updateMessage(assistant)
  const client = Protocol.connect({ executable: process.execPath, args: [fixture, dir], cwd: dir })
  const controller = new AbortController()
  const state = { ended: false }
  const control = NativeInteraction.open({
    session,
    assistant,
    signal: controller.signal,
    ended: () => state.ended,
    mode: "default",
  })
  control.ready(client, "thread", "turn", true)
  return {
    user,
    assistant,
    client,
    control,
    controller,
    state,
    close: async () => {
      await client.close()
      await control.close()
    },
  }
}

function snapshot(client: MessageID, steer: MessageID): NativeHistory.Snapshot {
  return {
    thread: { id: "thread", createdAt: 1, updatedAt: 2, status: { type: "notLoaded" } },
    complete: true,
    issues: [],
    turns: [
      {
        id: "turn",
        status: "completed",
        itemsView: "full",
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            id: "input",
            type: "userMessage",
            clientId: client,
            content: [{ type: "text", text: "Original question" }],
          },
          { id: "thinking", type: "reasoning", summary: ["Initial thought"], content: [] },
          { id: "before", type: "agentMessage", text: "Partial answer before steering" },
          {
            id: "steer",
            type: "userMessage",
            clientId: steer,
            content: [{ type: "text", text: "Additional instruction" }],
          },
          { id: "answer", type: "agentMessage", text: "Final answer", phase: "final_answer" },
        ],
      },
    ],
  }
}

test("steering reuses its owning client and rebuilds separate display segments without duplicates", async () => {
  await scenario("accept", async (session, dir) => {
    const run = await setup(session, dir)
    const input = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      turnID: "turn",
      text: "Additional instruction",
    }
    try {
      expect(NativeSession.active(session.id)).toMatchObject({ phase: "running", turnID: "turn", steer: true })
      expect(await NativeSession.steer(input)).toMatchObject({ status: "accepted" })
      expect(await NativeSession.steer(input)).toMatchObject({ status: "accepted" })
      expect(NativeStore.pending(session.id)).toEqual([])
      expect((await calls(dir)).filter((call) => call.method === "turn/steer")).toEqual(
        [
          {
            method: "turn/steer",
            params: expect.objectContaining({
              threadId: "thread",
              expectedTurnId: "turn",
              clientUserMessageId: input.messageID,
            }),
          },
        ].map((entry) => expect.objectContaining(entry)),
      )
      run.state.ended = true
      await run.control.close()
      expect(await NativeSession.steer(input)).toMatchObject({ status: "accepted" })
      for (const message of await NativeStore.history(session.id))
        await Session.removeMessage({ sessionID: session.id, messageID: message.info.id })
      expect(await NativeSync.apply(session, snapshot(run.user.id, input.messageID))).toMatchObject({ state: "synced" })
      const messages = await NativeStore.history(session.id)
      expect(messages).toHaveLength(4)
      expect(messages.filter((entry) => entry.info.role === "assistant").map((entry) => entry.info)).toEqual([
        expect.objectContaining({ id: run.assistant.id, parentID: run.user.id }),
        expect.objectContaining({ id: `${input.messageID}_codex`, parentID: input.messageID }),
      ])
      expect(messages.find((entry) => entry.info.id === input.messageID)?.parts).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: input.text,
          metadata: expect.objectContaining({ nativeSteer: expect.objectContaining({ status: "accepted" }) }),
        }),
      )
      await NativeSync.apply(session, snapshot(run.user.id, input.messageID))
      expect(await NativeStore.history(session.id)).toEqual(messages)
    } finally {
      await run.close()
    }
  })
})

test("steering validates full attachment identity on retries and preserves selected source data", async () => {
  await scenario("accept", async (session, dir) => {
    const run = await setup(session, dir)
    const input = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      turnID: "turn",
      text: "Summary",
      parts: [
        { type: "text" as const, text: "Question", metadata: { citation: "page 2" } },
        { type: "file" as const, mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" },
      ] satisfies [Native.Part, Native.Part],
    }
    try {
      expect((await NativeSession.steer(input)).status).toBe("accepted")
      expect((await NativeSession.steer(input)).status).toBe("accepted")
      expect(
        (
          await NativeSession.steer({
            ...input,
            parts: [input.parts[0], { ...input.parts[1], url: "data:image/png;base64,b3RoZXI=" }],
          })
        ).status,
      ).toBe("rejected")
      expect(
        (
          await NativeSession.steer({
            ...input,
            parts: [{ ...input.parts[0], metadata: { citation: "page 3" } }, input.parts[1]],
          })
        ).status,
      ).toBe("rejected")
      expect((await calls(dir)).filter((call) => call.method === "turn/steer")).toHaveLength(1)
      const stored = NativeStore.inputs(session.id).find((entry) => entry.id === input.messageID)!
      expect(stored.data.parts).toContainEqual(expect.objectContaining({ type: "file", url: input.parts[1].url }))
      expect(stored.data.parts).toContainEqual(
        expect.objectContaining({ type: "text", metadata: expect.objectContaining({ citation: "page 2" }) }),
      )
    } finally {
      await run.close()
    }
  })
})

test("stale, unsupported and foreign turns are rejected before storing or sending input", async () => {
  await scenario("accept", async (session, dir) => {
    const run = await setup(session, dir)
    try {
      const input = { sessionID: session.id, messageID: MessageID.ascending(), turnID: "other", text: "No" }
      expect(await NativeSession.steer(input)).toMatchObject({ status: "rejected" })
      run.control.ready(run.client, "thread", "turn", false)
      expect(await NativeSession.steer({ ...input, turnID: "turn" })).toMatchObject({ status: "rejected" })
      await run.control.close()
      expect(await NativeSession.steer({ ...input, turnID: "turn" })).toMatchObject({ status: "rejected" })
      expect(NativeStore.inputs(session.id)).toHaveLength(1)
    } finally {
      await run.close()
    }
  })
})

test("explicit RPC rejection is durable and cannot become a pending next-turn input", async () => {
  await scenario("reject", async (session, dir) => {
    const run = await setup(session, dir)
    const input = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      turnID: "turn",
      text: "Additional instruction",
    }
    try {
      expect(await NativeSession.steer(input)).toMatchObject({ status: "rejected", error: "The expected turn ended" })
      expect(await NativeSession.steer(input)).toMatchObject({ status: "rejected", error: "The expected turn ended" })
      expect(NativeStore.inputs(session.id).find((entry) => entry.id === input.messageID)?.state).toBe("failed")
      expect(NativeStore.pending(session.id)).toEqual([])
      expect((await calls(dir)).filter((call) => call.method === "turn/steer")).toHaveLength(1)
    } finally {
      await run.close()
    }
  })
})

test("ambiguous acceptance is never resent and partial history confirms only its native client identity", async () => {
  await scenario("wrong", async (session, dir) => {
    const run = await setup(session, dir)
    const input = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      turnID: "turn",
      text: "Additional instruction",
    }
    try {
      expect(await NativeSession.steer(input)).toMatchObject({ status: "uncertain" })
      expect(await NativeSession.steer(input)).toMatchObject({ status: "uncertain" })
      const partial = snapshot(run.user.id, input.messageID)
      partial.complete = false
      partial.issues.push({ code: "unrepresented", message: "Fixture partial history" })
      expect(await NativeSync.apply(session, partial)).toMatchObject({ state: "partial" })
      expect(NativeStore.dispatches(session.id).find((entry) => entry.id === input.messageID)?.state).toBe("accepted")
      const messages = await NativeStore.history(session.id)
      expect(messages.find((entry) => entry.info.id === input.messageID)?.parts).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: input.text,
          metadata: expect.objectContaining({ nativeSteer: expect.objectContaining({ status: "accepted" }) }),
        }),
      )
      await NativeSync.apply(session, partial)
      expect(await NativeStore.history(session.id)).toEqual(messages)
      expect((await calls(dir)).filter((call) => call.method === "turn/steer")).toHaveLength(1)
    } finally {
      await run.close()
    }
  })
})

test("cancelling a turn marks dispatched steering uncertain and rejects queued input before dispatch", async () => {
  await scenario("hold", async (session, dir) => {
    const run = await setup(session, dir)
    try {
      const input = {
        sessionID: session.id,
        messageID: MessageID.ascending(),
        turnID: "turn",
        text: "Additional instruction",
      }
      const first = NativeSession.steer(input)
      for (let i = 0; i < 100 && (await run.client.request<number>("count")) === 0; i++) await Bun.sleep(10)
      const second = NativeSession.steer({ ...input, messageID: MessageID.ascending(), text: "Queued" })
      run.controller.abort()
      const closing = run.control.close()
      expect(NativeSession.active(session.id)).toMatchObject({ phase: "stopping", steer: false })
      await run.client.request("release")
      expect(await first).toMatchObject({ status: "uncertain" })
      expect(await second).toMatchObject({ status: "rejected" })
      await closing
      expect(NativeSession.active(session.id)).toBeUndefined()
      expect((await calls(dir)).filter((call) => call.method === "turn/steer")).toHaveLength(1)
    } finally {
      await run.close()
    }
  })
})

test("accepted steering absent from partial history is rebuilt from immutable input", async () => {
  await scenario("accept", async (session, dir) => {
    const run = await setup(session, dir)
    const input = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      turnID: "turn",
      text: "Additional instruction",
    }
    try {
      expect(await NativeSession.steer(input)).toMatchObject({ status: "accepted" })
      for (const message of await NativeStore.history(session.id))
        await Session.removeMessage({ sessionID: session.id, messageID: message.info.id })
      const partial = snapshot(run.user.id, input.messageID)
      partial.turns[0].items = partial.turns[0].items.filter((item) => item.id !== "steer")
      expect(await NativeSync.apply(session, partial)).toMatchObject({ state: "partial" })
      expect((await NativeStore.history(session.id)).filter((entry) => entry.info.id === input.messageID)).toHaveLength(
        1,
      )
      expect(NativeStore.pending(session.id)).toEqual([])
    } finally {
      await run.close()
    }
  })
})

test("a disconnected steer is durable and waiting status belongs to the active owner", async () => {
  await scenario("exit", async (session, dir) => {
    const run = await setup(session, dir)
    const input = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      turnID: "turn",
      text: "Additional instruction",
    }
    const wait = Promise.withResolvers<void>()
    const waiting = run.control.wait(() => wait.promise)
    try {
      expect(NativeSession.active(session.id)).toMatchObject({ phase: "waiting", steer: true })
      expect(await NativeSession.steer(input)).toMatchObject({ status: "uncertain" })
      await run.control.close()
      expect(await NativeSession.steer(input)).toMatchObject({ status: "uncertain" })
      expect((await calls(dir)).filter((call) => call.method === "turn/steer")).toHaveLength(1)
      expect(NativeStore.pending(session.id)).toEqual([])
    } finally {
      wait.resolve()
      await waiting
      await run.close()
    }
  })
})

test("native session sends native collaboration presets and explicitly restores default mode", async () => {
  await scenario(
    "accept",
    async (session, dir) => {
      for (const mode of ["plan", "default"] as const) {
        await Session.setNativeMode({ sessionID: session.id, mode })
        const result = await NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text: mode }] },
          session,
          new AbortController().signal,
        )
        expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
        expect((await Session.get(session.id)).engine).toMatchObject({ mode, collaboration: mode })
      }
      const sent = (await calls(dir)).filter((call) => call.method === "turn/start")
      expect(sent.map((call) => call.params.collaborationMode)).toEqual(
        ["plan", "default"].map((mode) => ({
          mode,
          settings: { model: "native-model", reasoning_effort: "high", developer_instructions: null },
        })),
      )
    },
    "complete",
  )
})

test("native session exposes its live turn and steers through the existing execution lease", async () => {
  await scenario(
    "accept",
    async (session, dir) => {
      const controller = new AbortController()
      const running = NativeSession.prompt(
        { sessionID: session.id, parts: [{ type: "text", text: "Original question" }] },
        session,
        controller.signal,
      )
      try {
        for (let i = 0; i < 150 && !NativeSession.active(session.id)?.turnID; i++) await Bun.sleep(10)
        const active = NativeSession.active(session.id)
        expect(active).toMatchObject({ phase: "running", steer: true, turnID: "turn-1" })
        const input = {
          sessionID: session.id,
          messageID: MessageID.ascending(),
          turnID: active!.turnID!,
          text: "Additional instruction",
        }
        expect(await NativeSession.steer(input)).toMatchObject({ status: "accepted" })
        const reply = await running
        expect(reply.info).toMatchObject({ role: "assistant", finish: "stop" })
        expect(NativeSession.active(session.id)).toBeUndefined()
        expect(await NativeSession.steer(input)).toMatchObject({ status: "accepted" })
        const records = await calls(dir)
        expect(records.filter((entry) => entry.method === "initialize")).toHaveLength(1)
        expect(records.filter((entry) => entry.method === "turn/start")).toHaveLength(1)
        expect(records.filter((entry) => entry.method === "turn/steer")).toHaveLength(1)
        const messages = await NativeStore.history(session.id)
        const replies = messages.filter((entry) => entry.info.role === "assistant")
        expect(replies).toHaveLength(2)
        expect(replies[0].parts).toContainEqual(expect.objectContaining({ text: "Partial answer before steering" }))
        expect(replies[1].info).toMatchObject({ parentID: input.messageID })
        expect(replies[1].parts).toContainEqual(expect.objectContaining({ text: "Native answer" }))
      } finally {
        controller.abort()
        await running
      }
    },
    "steer",
  )
})

test("an unconfirmed switch out of native plan mode retains its safe fallback state", async () => {
  await scenario("drop", async (session) => {
    await Session.setEngine({
      sessionID: session.id,
      engine: { ...session.engine!, mode: "default", collaboration: "plan" },
    })
    const reply = await NativeSession.prompt(
      { sessionID: session.id, parts: [{ type: "text", text: "Execute now" }] },
      session,
      new AbortController().signal,
    )
    expect(reply.info).toMatchObject({ role: "assistant", finish: "error" })
    expect((await Session.get(session.id)).engine).toMatchObject({ mode: "default", collaboration: "plan" })
  })
})
