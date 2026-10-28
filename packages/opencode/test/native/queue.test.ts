import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { NativeSession } from "../../src/native/session"
import { NativeQueue } from "../../src/native/queue"
import { NativeStore } from "../../src/native/store"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (session: Session.Info, dir: string) => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "queue-fixture.ts")
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`,
  )
  if (process.platform !== "win32") await fs.chmod(file, 0o755)
  await Bun.write(path.join(cfg.path, "aether.json"), JSON.stringify({ native: { codex: { path: file } } }))
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex", permission: "user" } })
        await run(session, dir.path)
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

async function until(fn: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("Queue condition was not reached")
}

async function empty(id: Session.Info["id"]) {
  await until(async () => {
    const queue = await NativeQueue.list(id)
    if (queue.items.some((item) => item.state === "failed" || item.state === "uncertain"))
      throw new Error(JSON.stringify(queue))
    return queue.items.length === 0
  })
}

test("idle queue persists, deduplicates and requires explicit resume", async () => {
  await scenario(async (session, dir) => {
    const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "queued" }
    expect((await NativeQueue.enqueue(input)).paused).toBe(true)
    expect((await NativeQueue.enqueue(input)).items).toHaveLength(1)
    await expect(NativeQueue.enqueue({ ...input, text: "different" })).rejects.toThrow("different input")
    expect(await Bun.file(path.join(dir, "turn-1.json")).exists()).toBe(false)
    await NativeQueue.resume(session.id)
    await empty(session.id)
    expect(NativeStore.inputs(session.id).filter((entry) => entry.id === input.messageID)).toHaveLength(1)
    await expect(NativeQueue.enqueue(input)).rejects.toThrow("already been submitted")
  })
})

test("successful native turn drains queued text exactly once", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    await until(async () => !!NativeSession.active(session.id)?.turnID)
    const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "second" }
    expect((await NativeQueue.enqueue(input)).paused).toBe(false)
    await NativeQueue.enqueue(input)
    await Bun.write(path.join(dir, "release"), "yes")
    await work
    await empty(session.id)
    expect((await Bun.file(path.join(dir, "turn-2.json")).json()).input).toBe("second")
    expect(await Bun.file(path.join(dir, "turn-3.json")).exists()).toBe(false)
  })
})

test("stop pauses pending input and does not start another turn", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    await until(async () => !!NativeSession.active(session.id)?.turnID)
    const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "second" }
    await NativeQueue.enqueue(input)
    await SessionPrompt.cancel(session.id)
    await work
    const queue = await NativeQueue.list(session.id)
    expect(queue.paused).toBe(true)
    expect(queue.items[0].state).toBe("pending")
    expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
    expect((await NativeQueue.remove(session.id, input.messageID)).items).toHaveLength(0)
  })
})

test("failure retains the failed entry and pauses later queued input", async () => {
  await scenario(async (session, dir) => {
    await NativeQueue.enqueue({ sessionID: session.id, messageID: MessageID.ascending(), text: "fail" })
    await NativeQueue.enqueue({ sessionID: session.id, messageID: MessageID.ascending(), text: "later" })
    await NativeQueue.resume(session.id)
    await until(async () => (await NativeQueue.list(session.id)).items[0]?.state === "failed")
    const queue = await NativeQueue.list(session.id)
    expect(queue.paused).toBe(true)
    expect(queue.items[1].state).toBe("pending")
    await expect(NativeQueue.resume(session.id)).rejects.toThrow("unresolved")
    expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
  })
})

test("resuming a paused queue during an active turn waits and drains once", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    await until(async () => !!NativeSession.active(session.id)?.turnID)
    await NativeQueue.enqueue({ sessionID: session.id, messageID: MessageID.ascending(), text: "second" })
    await NativeQueue.pause(session.id)
    await NativeQueue.resume(session.id)
    await NativeQueue.resume(session.id)
    expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
    await Bun.write(path.join(dir, "release"), "yes")
    await work
    await empty(session.id)
    expect((await Bun.file(path.join(dir, "turn-2.json")).json()).input).toBe("second")
    expect(await Bun.file(path.join(dir, "turn-3.json")).exists()).toBe(false)
  })
})

test("a new manual task can queue normally after an earlier stopped task", async () => {
  await scenario(async (session, dir) => {
    const first = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    await until(async () => !!NativeSession.active(session.id)?.turnID)
    await SessionPrompt.cancel(session.id)
    await first
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    await until(async () => !!NativeSession.active(session.id)?.turnID)
    const queued = await NativeQueue.enqueue({
      sessionID: session.id,
      messageID: MessageID.ascending(),
      text: "second",
    })
    expect(queued.paused).toBe(false)
    await Bun.write(path.join(dir, "release"), "yes")
    await work
    await empty(session.id)
    expect((await Bun.file(path.join(dir, "turn-2.json")).json()).input).toBe("second")
  })
})

test("disabled Codex rejects queue creation and resume without starting a process", async () => {
  await scenario(async (session, dir) => {
    await NativeQueue.enqueue({ sessionID: session.id, messageID: MessageID.ascending(), text: "pending" })
    await Config.updateGlobal({ native: { codex: { enabled: false } } })
    await expect(NativeQueue.resume(session.id)).rejects.toThrow("disabled")
    await expect(
      NativeQueue.enqueue({ sessionID: session.id, messageID: MessageID.ascending(), text: "later" }),
    ).rejects.toThrow("disabled")
    expect((await NativeQueue.list(session.id)).items).toHaveLength(1)
    expect(await Bun.file(path.join(dir, "turn-1.json")).exists()).toBe(false)
  })
})

test("recovered dispatch becomes uncertain and is never replayed automatically", async () => {
  await scenario(async (session, dir) => {
    const file = path.join(Global.Path.data, "native-queue", Instance.project.id, `${session.id}.json`)
    await Bun.write(
      file,
      JSON.stringify({
        owner: "previous-process",
        paused: false,
        items: [{ id: MessageID.ascending(), text: "possibly sent", state: "dispatching", created: Date.now() }],
      }),
    )
    const queue = await NativeQueue.list(session.id)
    expect(queue.paused).toBe(true)
    expect(queue.items[0].state).toBe("uncertain")
    await expect(NativeQueue.resume(session.id)).rejects.toThrow("unresolved")
    expect(await Bun.file(path.join(dir, "turn-1.json")).exists()).toBe(false)
  })
})

test("sending a queued message now uses its original ID once and removes it before automatic continuation", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    try {
      await until(async () => !!NativeSession.active(session.id)?.turnID)
      const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "send now" }
      await NativeQueue.enqueue(input)
      const request = {
        sessionID: session.id,
        messageID: input.messageID,
        turnID: NativeSession.active(session.id)!.turnID!,
      }
      const results = await Promise.all([NativeQueue.send(request), NativeQueue.send(request)])
      expect(results.map((result) => result.delivery.status)).toEqual(["accepted", "accepted"])
      expect(results[0].queue.items).toEqual([])
      expect((await NativeQueue.send(request)).delivery.status).toBe("accepted")
      expect(NativeStore.inputs(session.id).filter((item) => item.id === input.messageID)).toHaveLength(1)
      expect(await Bun.file(path.join(dir, `steer-${input.messageID}.json`)).json()).toMatchObject({
        clientUserMessageId: input.messageID,
        expectedTurnId: request.turnID,
      })
      const calls = await Promise.all(
        (await fs.readdir(dir))
          .filter((file) => /^call-\d+\.json$/.test(file))
          .map((file) => Bun.file(path.join(dir, file)).json()),
      )
      expect(calls.filter((call) => call.method === "turn/steer")).toHaveLength(1)
      await Bun.write(path.join(dir, "release"), "yes")
      await work
      expect((await NativeQueue.list(session.id)).items).toEqual([])
      expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
    } finally {
      await SessionPrompt.cancel(session.id)
      await work
    }
  })
})

test("an explicitly rejected queued steer remains failed and cannot be automatically sent as a new turn", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    try {
      await until(async () => !!NativeSession.active(session.id)?.turnID)
      const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "reject" }
      await NativeQueue.enqueue(input)
      const request = {
        sessionID: session.id,
        messageID: input.messageID,
        turnID: NativeSession.active(session.id)!.turnID!,
      }
      const result = await NativeQueue.send(request)
      expect(result.delivery).toMatchObject({ status: "rejected", error: "The expected turn ended" })
      expect(result.queue).toMatchObject({ paused: true, items: [{ id: input.messageID, state: "failed" }] })
      expect((await NativeQueue.send(request)).delivery).toEqual(result.delivery)
      await expect(NativeQueue.resume(session.id)).rejects.toThrow("unresolved")
      await Bun.write(path.join(dir, "release"), "yes")
      await work
      expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
    } finally {
      await SessionPrompt.cancel(session.id)
      await work
    }
  })
})

test("a stale turn pauses unsubmitted queued input until explicitly reviewed and resumed", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    try {
      await until(async () => !!NativeSession.active(session.id)?.turnID)
      const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "later" }
      await NativeQueue.enqueue(input)
      const result = await NativeQueue.send({
        sessionID: session.id,
        messageID: input.messageID,
        turnID: "finished-turn",
      })
      expect(result.delivery.status).toBe("rejected")
      expect(result.queue).toMatchObject({ paused: true, items: [{ id: input.messageID, state: "pending" }] })
      expect(NativeStore.inputs(session.id).some((item) => item.id === input.messageID)).toBe(false)
      await Bun.write(path.join(dir, "release"), "yes")
      await work
      expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
      await NativeQueue.resume(session.id)
      await empty(session.id)
      expect((await Bun.file(path.join(dir, "turn-2.json")).json()).input).toBe("later")
    } finally {
      await SessionPrompt.cancel(session.id)
      await work
    }
  })
})

test("a queued steer with an unknown delivery stays reviewable and is not replayed", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    try {
      await until(async () => !!NativeSession.active(session.id)?.turnID)
      const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "disconnect" }
      await NativeQueue.enqueue(input)
      const request = {
        sessionID: session.id,
        messageID: input.messageID,
        turnID: NativeSession.active(session.id)!.turnID!,
      }
      const result = await NativeQueue.send(request)
      expect(result.delivery.status).toBe("uncertain")
      expect(result.queue).toMatchObject({ paused: true, items: [{ id: input.messageID, state: "uncertain" }] })
      await work
      expect((await NativeQueue.send(request)).delivery.status).toBe("uncertain")
      await expect(NativeQueue.resume(session.id)).rejects.toThrow("unresolved")
      expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
    } finally {
      await SessionPrompt.cancel(session.id)
      await work
    }
  })
})

test("queued steering reserves delivery without blocking cancellation or allowing removal", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "wait" }] })
    try {
      await until(async () => !!NativeSession.active(session.id)?.turnID)
      const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "hold-steer" }
      await NativeQueue.enqueue(input)
      const sending = NativeQueue.send({
        sessionID: session.id,
        messageID: input.messageID,
        turnID: NativeSession.active(session.id)!.turnID!,
      })
      await until(() => Bun.file(path.join(dir, `steer-${input.messageID}.json`)).exists())
      expect((await NativeQueue.list(session.id)).items[0].state).toBe("dispatching")
      await expect(NativeQueue.remove(session.id, input.messageID)).rejects.toThrow("already being sent")
      await SessionPrompt.cancel(session.id)
      await work
      expect((await sending).delivery.status).toBe("uncertain")
      expect((await NativeQueue.list(session.id)).paused).toBe(true)
      expect(await Bun.file(path.join(dir, "turn-2.json")).exists()).toBe(false)
    } finally {
      await SessionPrompt.cancel(session.id)
      await work
    }
  })
})

test("a queue entry already claimed for a normal turn cannot also be steered", async () => {
  await scenario(async (session, dir) => {
    const input = { sessionID: session.id, messageID: MessageID.ascending(), text: "wait" }
    await NativeQueue.enqueue(input)
    await NativeQueue.resume(session.id)
    try {
      await until(async () => !!NativeSession.active(session.id)?.turnID)
      const result = await NativeQueue.send({
        sessionID: session.id,
        messageID: input.messageID,
        turnID: NativeSession.active(session.id)!.turnID!,
      })
      expect(result.delivery.status).toBe("rejected")
      expect(await Bun.file(path.join(dir, `steer-${input.messageID}.json`)).exists()).toBe(false)
      expect(NativeStore.inputs(session.id).filter((item) => item.id === input.messageID)).toHaveLength(1)
    } finally {
      await SessionPrompt.cancel(session.id)
    }
  })
})
