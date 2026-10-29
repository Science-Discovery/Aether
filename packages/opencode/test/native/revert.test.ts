import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeAnswers } from "../../src/native/answers"
import { NativeHistory } from "../../src/native/history"
import { NativeQueue } from "../../src/native/queue"
import { NativeRevert } from "../../src/native/revert"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (session: Session.Info, dir: string) => Promise<void>, legacy = false) {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "fork-fixture.ts")
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" ${legacy ? "--legacy " : ""}%*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' ${legacy ? "--legacy " : ""}"$@"\n`,
  )
  if (process.platform !== "win32") await fs.chmod(file, 0o755)
  await Bun.write(
    path.join(cfg.path, "aether.integrations.jsonc"),
    JSON.stringify({ native: { codex: { path: file } } }),
  )
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({
          engine: { type: "codex", model: "fixture", effort: "low", permission: "auto" },
        })
        await run(session, dir.path)
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

async function send(id: Session.Info["id"], text: string) {
  const result = await SessionPrompt.prompt({ sessionID: id, parts: [{ type: "text", text }] })
  if (result.info.role === "assistant" && result.info.error) throw new Error(JSON.stringify(result.info.error))
  return (await NativeStore.history(id)).filter((entry) => entry.info.role === "user").at(-1)!.info.id
}

async function calls(dir: string) {
  return (await Bun.file(path.join(dir, "fork-calls.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
}

async function alter(
  session: Session.Info,
  dir: string,
  fn: (thread: NativeHistory.Thread & { turns: NativeHistory.Turn[] }) => void,
) {
  const file = path.join(dir, "fork-history.json")
  const history = (await Bun.file(file).json()) as Record<
    string,
    NativeHistory.Thread & { turns: NativeHistory.Turn[] }
  >
  const thread = history[(await Session.get(session.id)).engine!.thread!]
  fn(thread)
  await Bun.write(file, JSON.stringify(history))
  return thread
}

test("reverting edits the same native thread, prunes delivery, and resumes only the retained history", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    const second = await send(session.id, "second")
    await send(session.id, "third")
    const before = await Session.get(session.id)
    const history = await NativeStore.history(session.id)
    await Bun.write(path.join(dir, "research.txt"), "Existing research stays on disk")
    const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID: second })
    expect(prepared).toMatchObject({
      sessionID: session.id,
      messageID: second,
      threadID: before.engine!.thread,
      turns: 2,
    })
    expect(await NativeRevert.status(session.id)).toBeNull()
    expect(await NativeStore.history(session.id)).toEqual(history)
    expect((await calls(dir)).some((entry) => entry.method === "thread/revert")).toBe(false)
    const result = await NativeRevert.commit({ sessionID: session.id, id: prepared.id })
    expect(result.state).toBe("applied")
    expect(result.session.id).toBe(session.id)
    expect(result.session.engine!.thread).toBe(before.engine!.thread)
    expect(NativeStore.inputs(session.id).map((entry) => entry.id)).toEqual([first])
    expect(
      (await NativeStore.history(session.id))
        .filter((entry) => entry.info.role === "user")
        .map((entry) => entry.info.id),
    ).toEqual([first])
    expect(await Bun.file(path.join(dir, "research.txt")).text()).toBe("Existing research stays on disk")
    expect((await NativeRevert.status(session.id, prepared.id))?.state).toBe("applied")
    expect((await NativeRevert.commit({ sessionID: session.id, id: prepared.id })).state).toBe("applied")
    expect((await calls(dir)).filter((entry) => entry.method === "thread/revert")).toHaveLength(1)
    await send(session.id, "edited second")
    const requests = await calls(dir)
    const starts = requests.filter((entry) => entry.method === "turn/start")
    expect(starts).toHaveLength(4)
    expect(starts[3].params.threadId).toBe(before.engine!.thread)
    expect(JSON.stringify(starts[3].params.input)).toContain("edited second")
    expect(JSON.stringify(starts[3].params.input)).not.toContain("third")
    const reverted = requests.findIndex((entry) => entry.method === "thread/revert")
    expect(requests.slice(reverted + 1).some((entry) => entry.method === "thread/resume")).toBe(true)
    expect(await Session.children(session.id)).toEqual([])
  })
}, 15_000)

test("the first question reverts to an empty existing thread", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID: first })
    const result = await NativeRevert.commit({ sessionID: session.id, id: prepared.id })
    expect(result.state).toBe("applied")
    expect(result.session.engine!.thread).toBe(prepared.threadID)
    expect(result.session.engine!.cursor).toBeUndefined()
    expect(await NativeStore.history(session.id)).toEqual([])
    expect(NativeStore.inputs(session.id)).toEqual([])
    await send(session.id, "replacement")
    expect((await calls(dir)).filter((entry) => entry.method === "thread/start")).toHaveLength(1)
  })
})

test.each(["failed", "rejected"])(
  "confirmed %s inputs do not permanently block later edits",
  async (kind) => {
    await scenario(async (session, dir) => {
      const first = await send(session.id, "first")
      const last = await send(session.id, "last")
      const current = await Session.get(session.id)
      const id = MessageID.ascending()
      if (kind === "failed") {
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          messageID: id,
          model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("missing-model") },
          parts: [{ type: "text", text: "Never delivered" }],
        })
        expect(result.info.role === "assistant" && !!result.info.error).toBe(true)
      }
      if (kind === "rejected") {
        const source = (await NativeStore.history(session.id)).find((entry) => entry.info.id === last)!
        NativeStore.steer(
          {
            info: { ...source.info, id },
            parts: [
              { type: "text", id: PartID.ascending(), sessionID: session.id, messageID: id, text: "Never delivered" },
            ],
          },
          MessageID.ascending(),
          current.engine!.thread!,
          NativeStore.dispatches(session.id).find((entry) => entry.id === last)!.turn_id!,
        )
        NativeStore.delivery(session.id, id, "rejected", "The expected turn ended")
      }
      expect(NativeStore.inputs(session.id).find((entry) => entry.id === id)?.state).toBe("failed")
      await NativeSync.refresh(session.id, true)
      for (const messageID of [last, first]) {
        const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID })
        const result = await NativeRevert.commit({ sessionID: session.id, id: prepared.id })
        expect(result.state).toBe("applied")
        expect(result.session.engine?.cursor).toBe(messageID === last ? first : undefined)
        expect(NativeStore.inputs(session.id).find((entry) => entry.id === id)?.state).toBe("failed")
        expect(NativeStore.pending(session.id)).toEqual([])
        expect((await NativeStore.history(session.id)).find((entry) => entry.info.id === id)?.parts).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text", text: "Never delivered" })]),
        )
      }
      await send(session.id, "replacement")
      const starts = (await calls(dir)).filter((entry) => entry.method === "turn/start")
      expect(starts).toHaveLength(3)
      expect(JSON.stringify(starts.at(-1)!.params.input)).not.toContain("Never delivered")
      expect(starts.at(-1)!.params.threadId).toBe(current.engine!.thread)
    })
  },
  15_000,
)

for (const behavior of ["drop-after", "error-after"])
  test(`a ${behavior} native result is reconciled without repeating the mutation`, async () => {
    await scenario(async (session, dir) => {
      await send(session.id, "first")
      const last = await send(session.id, "last")
      const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID: last })
      await Bun.write(path.join(dir, "behavior"), behavior)
      expect((await NativeRevert.commit({ sessionID: session.id, id: prepared.id })).state).toBe("applied")
      expect((await NativeRevert.commit({ sessionID: session.id, id: prepared.id })).state).toBe("applied")
      expect((await calls(dir)).filter((entry) => entry.method === "thread/revert")).toHaveLength(1)
      expect((await NativeStore.history(session.id)).filter((entry) => entry.info.role === "user")).toHaveLength(1)
    })
  })

test("uncertain delivery survives restart and gates sending, sync, forks, queue and answers", async () => {
  await scenario(async (session, dir) => {
    await send(session.id, "first")
    const last = await send(session.id, "last")
    const before = await NativeStore.history(session.id)
    const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID: last })
    await Bun.write(path.join(dir, "behavior"), "drop-before")
    expect((await NativeRevert.commit({ sessionID: session.id, id: prepared.id })).state).toBe("uncertain")
    await Instance.disposeDirectory(dir)
    await Instance.provide({
      directory: dir,
      fn: async () => {
        expect((await NativeRevert.status(session.id, prepared.id))?.state).toBe("uncertain")
        await expect(NativeRevert.guard(session.id)).rejects.toThrow("verification")
        await expect(Session.fork({ sessionID: session.id })).rejects.toThrow("verification")
        await expect(
          NativeQueue.enqueue({ sessionID: session.id, messageID: MessageID.ascending(), text: "later" }),
        ).rejects.toThrow("verification")
        await expect(
          NativeAnswers.reply({
            sessionID: session.id,
            threadID: prepared.threadID,
            itemID: "unknown",
            answers: ["yes"],
          }),
        ).rejects.toThrow("verification")
        const sync = await NativeSync.refresh(session.id, true)
        expect(sync.state).toBe("unavailable")
        await expect(send(session.id, "must not be sent")).rejects.toThrow("verification")
        expect(await NativeStore.history(session.id)).toEqual(before)
        expect((await NativeRevert.commit({ sessionID: session.id, id: prepared.id })).state).toBe("uncertain")
        expect((await calls(dir)).filter((entry) => entry.method === "thread/revert")).toHaveLength(1)
        await alter(session, dir, (thread) => {
          thread.turns.pop()
        })
        expect((await NativeRevert.commit({ sessionID: session.id, id: prepared.id })).state).toBe("applied")
        await NativeRevert.guard(session.id)
        expect((await calls(dir)).filter((entry) => entry.method === "thread/revert")).toHaveLength(1)
      },
    })
  })
}, 15_000)

for (const behavior of ["revert-reject", "resume-fail", "goal-resume"])
  test(`a confirmed ${behavior} leaves history editable for a fresh preparation`, async () => {
    await scenario(async (session, dir) => {
      const first = await send(session.id, "first")
      const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID: first })
      await Bun.write(path.join(dir, "behavior"), behavior)
      await expect(NativeRevert.commit({ sessionID: session.id, id: prepared.id })).rejects.toThrow()
      expect(await NativeRevert.status(session.id)).toBeNull()
      await NativeRevert.guard(session.id)
      await Bun.write(path.join(dir, "behavior"), "")
      const fresh = await NativeRevert.prepare({ sessionID: session.id, messageID: first })
      expect(fresh.id).not.toBe(prepared.id)
      expect((await NativeRevert.commit({ sessionID: session.id, id: fresh.id })).state).toBe("applied")
      expect((await calls(dir)).filter((entry) => entry.method === "thread/revert")).toHaveLength(
        behavior === "revert-reject" ? 2 : 1,
      )
    })
  })

test("a prepared snapshot changing before commit rejects without a native mutation", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID: first })
    await send(session.id, "new turn while confirming")
    await expect(NativeRevert.commit({ sessionID: session.id, id: prepared.id })).rejects.toThrow("changed")
    await NativeRevert.guard(session.id)
    expect((await calls(dir)).some((entry) => entry.method === "thread/revert")).toBe(false)
  })
})

test("unverified retained content stays blocked instead of deleting the local suffix", async () => {
  await scenario(async (session, dir) => {
    await send(session.id, "first")
    const last = await send(session.id, "last")
    const before = await NativeStore.history(session.id)
    const prepared = await NativeRevert.prepare({ sessionID: session.id, messageID: last })
    await Bun.write(path.join(dir, "behavior"), "revert-changed")
    expect((await NativeRevert.commit({ sessionID: session.id, id: prepared.id })).state).toBe("uncertain")
    expect(await NativeStore.history(session.id)).toEqual(before)
    await expect(NativeRevert.guard(session.id)).rejects.toThrow("verification")
  })
})

test("busy, queued, active goals and missing capabilities refuse before revert", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    await SessionStatus.set(session.id, { type: "busy" })
    await expect(NativeRevert.prepare({ sessionID: session.id, messageID: first })).rejects.toThrow("finish")
    await SessionStatus.set(session.id, { type: "idle" })
    const queued = MessageID.ascending()
    await NativeQueue.enqueue({ sessionID: session.id, messageID: queued, text: "pending" })
    await expect(NativeRevert.prepare({ sessionID: session.id, messageID: first })).rejects.toThrow("queued")
    await NativeQueue.remove(session.id, queued)
    await Bun.write(path.join(dir, "behavior"), "goal")
    await expect(NativeRevert.prepare({ sessionID: session.id, messageID: first })).rejects.toThrow("goal")
    expect((await calls(dir)).some((entry) => entry.method === "thread/revert")).toBe(false)
  })
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    await expect(NativeRevert.prepare({ sessionID: session.id, messageID: first })).rejects.toThrow("does not support")
    expect((await calls(dir)).some((entry) => entry.method === "thread/revert")).toBe(false)
  }, true)
}, 15_000)

test("in-turn follow-up messages cannot be used as a native turn boundary", async () => {
  await scenario(async (session, dir) => {
    await send(session.id, "first")
    const id = MessageID.ascending()
    await alter(session, dir, (thread) => {
      thread.turns[0].items.push({
        id: "steer",
        type: "userMessage",
        clientId: id,
        content: [{ type: "text", text: "follow-up" }],
      })
    })
    await NativeSync.refresh(session.id, true)
    const message = (await NativeStore.history(session.id)).find((entry) =>
      entry.parts.some((part) => part.type === "text" && part.text === "follow-up"),
    )!
    await expect(NativeRevert.prepare({ sessionID: session.id, messageID: message.info.id })).rejects.toThrow(
      "first question",
    )
    expect((await calls(dir)).some((entry) => entry.method === "thread/revert")).toBe(false)
  })
})

test("missing previously delivered native turns cannot be mistaken for a removable suffix", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    await send(session.id, "missing later turn")
    await alter(session, dir, (thread) => {
      thread.turns.pop()
    })
    await expect(NativeRevert.prepare({ sessionID: session.id, messageID: first })).rejects.toThrow("absent")
    expect((await calls(dir)).some((entry) => entry.method === "thread/revert")).toBe(false)
    expect(NativeStore.inputs(session.id)).toHaveLength(2)
  })
})
