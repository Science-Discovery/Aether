import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeAnswers } from "../../src/native/answers"
import { NativeQuestion } from "../../src/native/questions"
import { NativeSession } from "../../src/native/session"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import type { NativeHistory } from "../../src/native/history"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SyncEvent } from "../../src/sync"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (session: Session.Info, dir: string) => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "answers-fixture.ts")
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`,
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
        const session = await Session.create({ engine: { type: "codex", permission: "user" } })
        try {
          await run(session, dir.path)
        } finally {
          await SessionPrompt.cancel(session.id)
          await NativeAnswers.clear(session.id)
        }
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("The answer delivery state did not settle")
}

async function question(id: Session.Info["id"]): Promise<NativeQuestion.Info> {
  const messages = await NativeStore.history(id)
  const part = messages.flatMap((entry) => entry.parts).find((part) => part.type === "text" && part.nativeQuestion)
  if (part?.type !== "text" || !part.nativeQuestion) throw new Error("The native question card was not persisted")
  return part.nativeQuestion
}

async function ask(session: Session.Info, text = "ask") {
  await SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text }] })
  return question(session.id)
}

async function calls(dir: string) {
  return (await Bun.file(path.join(dir, "calls.jsonl")).text())
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          method: string
          params: {
            threadId?: string
            expectedTurnId?: string
            clientUserMessageId?: string
            input?: { type: string; text?: string; text_elements?: unknown[] }[]
          }
        },
    )
}

function input(id: Session.Info["id"], card: NativeQuestion.Info, answers = ["Brief", "No further notes"]) {
  return { sessionID: id, itemID: card.item, threadID: card.thread, answers }
}

async function settled(
  id: Session.Info["id"],
  card: NativeQuestion.Info,
  state: NativeQuestion.Info["state"] = "answered",
) {
  await until(async () => (await NativeAnswers.decorate(id, card)).state === state)
  await until(async () => (await SessionStatus.get(id)).type === "idle")
  await until(async () => (await question(id)).state === state)
}

test("idle answers start one turn in the original thread with the Desktop reply marker", async () => {
  await scenario(async (session, dir) => {
    const card = await ask(session)
    expect(card.questions).toEqual([
      { title: "Choose a style", options: ["Brief", "Detailed"] },
      { title: "Any notes?" },
    ])
    const request = input(session.id, card)
    expect((await NativeAnswers.reply(request)).state).toBe("sending")
    await settled(session.id, card)
    const records = await calls(dir)
    const sent = records.filter((entry) => entry.method === "turn/start")
    expect(sent).toHaveLength(2)
    expect(sent[1].params.threadId).toBe(card.thread)
    expect(sent[1].params.input).toEqual([
      {
        type: "text",
        text: `<send_user_message_question_reply>\n${JSON.stringify([
          {
            questionItemId: JSON.stringify(["request_user_input_async", card.item, 0]),
            question: "Choose a style",
            answer: "Brief",
          },
          {
            questionItemId: JSON.stringify(["request_user_input_async", card.item, 1]),
            question: "Any notes?",
            answer: "No further notes",
          },
        ])}\n</send_user_message_question_reply>\n`,
        text_elements: [],
      },
    ])
    expect(records.filter((entry) => entry.method === "thread/start")).toHaveLength(1)
    expect(await question(session.id)).toMatchObject({ state: "answered", answers: request.answers })
  })
})

test("concurrent identical answers and later retries preserve one delivery identity", async () => {
  await scenario(async (session, dir) => {
    const card = await ask(session)
    const request = input(session.id, card)
    await Promise.all([NativeAnswers.reply(request), NativeAnswers.reply(request), NativeAnswers.reply(request)])
    await settled(session.id, card)
    const before = NativeStore.inputs(session.id)
    expect((await NativeAnswers.reply(request)).state).toBe("answered")
    expect(NativeStore.inputs(session.id)).toEqual(before)
    expect(before).toHaveLength(2)
    expect((await calls(dir)).filter((entry) => entry.method === "turn/start")).toHaveLength(2)
    await expect(NativeAnswers.reply({ ...request, answers: ["Detailed", "Changed answer"] })).rejects.toThrow(
      "already has a submitted answer",
    )
  })
})

test("an active answer steers the existing turn instead of starting another turn", async () => {
  await scenario(async (session, dir) => {
    const work = SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "ask-active" }] })
    try {
      await until(
        async () =>
          !!NativeSession.active(session.id)?.turnID &&
          (await NativeStore.history(session.id)).some((entry) =>
            entry.parts.some((part) => part.type === "text" && part.nativeQuestion),
          ),
      )
      const card = await question(session.id)
      const turn = NativeSession.active(session.id)!.turnID!
      await NativeAnswers.reply(input(session.id, card))
      await until(async () => (await NativeAnswers.decorate(session.id, card)).state === "answered")
      const sent = (await calls(dir)).filter((entry) => entry.method === "turn/steer")
      expect(sent).toHaveLength(1)
      expect(sent[0].params).toMatchObject({ threadId: card.thread, expectedTurnId: turn })
      expect(sent[0].params.input?.[0].text).toContain(
        JSON.stringify(["request_user_input_async", card.item, 0]).replaceAll('"', '\\"'),
      )
      expect((await calls(dir)).filter((entry) => entry.method === "turn/start")).toHaveLength(1)
      await Bun.write(path.join(dir, "release"), "yes")
      await work
    } finally {
      await SessionPrompt.cancel(session.id)
      await work
    }
  })
})

test("a lost native receipt stays uncertain and is never automatically replayed", async () => {
  await scenario(async (session, dir) => {
    const card = await ask(session)
    await Bun.write(path.join(dir, "behavior"), "drop")
    const request = input(session.id, card)
    await NativeAnswers.reply(request)
    await settled(session.id, card, "uncertain")
    const before = NativeStore.inputs(session.id)
    expect((await NativeAnswers.reply(request)).state).toBe("uncertain")
    expect(NativeStore.inputs(session.id)).toEqual(before)
    expect((await calls(dir)).filter((entry) => entry.method === "turn/start")).toHaveLength(2)
  })
})

test("a recorded pre-dispatch failure can retry with its original unsent message ID", async () => {
  await scenario(async (session, dir) => {
    const card = await ask(session)
    const request = input(session.id, card)
    const message = MessageID.ascending()
    // A prior process failed before creating any native input or dispatch row.
    await Bun.write(
      path.join(Global.Path.data, "native-answers", Instance.project.id, `${session.id}.json`),
      JSON.stringify([
        { question: { ...card, state: "failed", answers: request.answers, error: "Stopped before dispatch" }, message },
      ]),
    )
    expect(NativeStore.inputs(session.id).some((entry) => entry.id === message)).toBe(false)
    expect((await NativeAnswers.reply(request)).state).toBe("sending")
    await settled(session.id, card)
    const sent = (await calls(dir)).filter((entry) => entry.method === "turn/start")
    expect(sent[1].params.clientUserMessageId).toBe(message)
    expect(NativeStore.inputs(session.id).filter((entry) => entry.id === message)).toHaveLength(1)
  })
})

test("stopping while the answer is published prevents its later dispatch", async () => {
  await scenario(async (session, dir) => {
    const card = await ask(session)
    const stopped = Promise.withResolvers<void>()
    const unsubscribe = SyncEvent.subscribeAll(({ def, event }) => {
      if (def.type !== MessageV2.Event.PartUpdated.type) return
      const value = MessageV2.Event.PartUpdated.schema.parse(event.data)
      if (
        value.sessionID !== session.id ||
        value.part.type !== "text" ||
        value.part.nativeQuestion?.state !== "sending"
      )
        return
      unsubscribe()
      void SessionPrompt.cancel(session.id).then(stopped.resolve, stopped.reject)
    })
    try {
      await NativeAnswers.reply(input(session.id, card))
      await stopped.promise
      await settled(session.id, card, "failed")
      expect(NativeStore.inputs(session.id)).toHaveLength(1)
      expect((await calls(dir)).filter((entry) => entry.method === "turn/start")).toHaveLength(1)
      expect(await question(session.id)).toMatchObject({ state: "failed" })
    } finally {
      unsubscribe()
    }
  })
})

for (const context of ["owner", "sibling"])
  test(`removing from the ${context} directory closes answers and rejects concurrent reservations`, async () => {
    await scenario(async (session, dir) => {
      const directory = context === "owner" ? dir : path.join(dir, "sibling")
      if (directory !== dir) {
        await fs.mkdir(directory)
        await Instance.provide({
          directory,
          project: Instance.project,
          worktree: Instance.worktree,
          fn: async () => expect(Instance.project.id).toBe(session.projectID),
        })
      }
      const card = await ask(session)
      const request = input(session.id, card)
      const file = path.join(Global.Path.data, "native-answers", Instance.project.id, `${session.id}.json`)
      const removed = Promise.withResolvers<void>()
      const late = Promise.withResolvers<{ question?: NativeQuestion.Info; error?: unknown }>()
      const unsubscribe = SyncEvent.subscribeAll(({ def, event }) => {
        if (def.type !== MessageV2.Event.PartUpdated.type) return
        const value = MessageV2.Event.PartUpdated.schema.parse(event.data)
        if (
          value.sessionID !== session.id ||
          value.part.type !== "text" ||
          value.part.nativeQuestion?.state !== "sending"
        )
          return
        unsubscribe()
        void Instance.provide({ directory, fn: () => Session.remove(session.id) }).then(removed.resolve, removed.reject)
        void NativeAnswers.reply(request).then(
          (question) => late.resolve({ question }),
          (error: unknown) => late.resolve({ error }),
        )
      })
      try {
        await NativeAnswers.reply(request)
        await removed.promise
        expect((await late.promise).error).toBeDefined()
        await expect(Session.getGlobal(session.id)).rejects.toThrow("NotFoundError")
        expect((await calls(dir)).filter((entry) => entry.method === "turn/start")).toHaveLength(1)
        expect(await Bun.file(file).exists()).toBe(false)
        // A history refresh that was already in flight cannot recreate receipts.
        await NativeAnswers.decorate(session.id, { ...card, state: "answered", answers: request.answers })
        expect(await Bun.file(file).exists()).toBe(false)
      } finally {
        unsubscribe()
        if (directory !== dir) await Instance.disposeDirectory(directory)
      }
    })
  })

test("wrong thread, missing item, wrong count and oversized answers never create native input", async () => {
  await scenario(async (session, dir) => {
    const card = await ask(session, "ask-four")
    const request = input(session.id, card, ["a", "b", "c", "d"])
    await expect(NativeAnswers.reply({ ...request, threadID: "another-thread" })).rejects.toThrow("does not belong")
    await expect(NativeAnswers.reply({ ...request, itemID: "missing" })).rejects.toThrow("no longer available")
    await expect(NativeAnswers.reply({ ...request, answers: ["only one"] })).rejects.toThrow("every question")
    await expect(NativeAnswers.reply({ ...request, answers: ["x".repeat(100_001), "b", "c", "d"] })).rejects.toThrow()
    await expect(NativeAnswers.reply({ ...request, answers: Array(4).fill("中".repeat(100_000)) })).rejects.toThrow(
      "too long",
    )
    expect(NativeStore.inputs(session.id)).toHaveLength(1)
    expect((await calls(dir)).filter((entry) => entry.method === "turn/start")).toHaveLength(1)
  })
})

test("answered cards survive cache reconstruction and reopening their owning instance", async () => {
  await scenario(async (session, dir) => {
    const card = await ask(session)
    const request = input(session.id, card)
    await NativeAnswers.reply(request)
    await settled(session.id, card)
    const saved = (await Bun.file(path.join(dir, "history.json")).json()) as Pick<
      NativeHistory.Snapshot,
      "thread" | "turns"
    >
    for (const entry of await NativeStore.history(session.id))
      await Session.removeMessage({ sessionID: session.id, messageID: entry.info.id })
    await NativeSync.apply(await Session.get(session.id), { ...saved, complete: true, issues: [] })
    expect(await question(session.id)).toMatchObject({ state: "answered", answers: request.answers })
    await Instance.disposeDirectory(dir)
    await Instance.provide({
      directory: dir,
      fn: async () => {
        expect(await NativeAnswers.decorate(session.id, { ...card, state: "pending" })).toMatchObject({
          state: "answered",
          answers: request.answers,
        })
        expect((await NativeAnswers.reply(request)).state).toBe("answered")
        expect((await calls(dir)).filter((entry) => entry.method === "turn/start")).toHaveLength(2)
      },
    })
  })
})
