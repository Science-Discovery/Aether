import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeFork } from "../../src/native/fork"
import { NativeHistory } from "../../src/native/history"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
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

test("native forks cut before or after a complete turn and preserve the original", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    const second = await send(session.id, "second")
    const before = await Session.get(session.id)
    const history = await NativeStore.history(session.id)
    const child = await Session.fork({ sessionID: session.id, messageID: second })
    expect(child.engine).toMatchObject({ type: "codex", model: "fixture", effort: "low", permission: "auto" })
    expect(child.engine!.thread).not.toBe(before.engine!.thread)
    expect(child.forkAfterUserMessageID).toBe(first)
    expect(child.treeID).toBe(before.treeID)
    expect(child.directory).toBe(before.directory)
    expect(NativeStore.inputs(child.id)).toHaveLength(0)
    expect((await NativeStore.history(child.id)).filter((entry) => entry.info.role === "user")).toHaveLength(1)
    expect(await Session.get(session.id)).toEqual(before)
    expect(await NativeStore.history(session.id)).toEqual(history)
    const request = (await calls(dir)).find((entry) => entry.method === "thread/fork")!
    expect(request.params).toMatchObject({
      threadId: before.engine!.thread,
      lastTurnId: `${before.engine!.thread}-turn-1`,
      excludeTurns: true,
      deferGoalContinuation: true,
      approvalsReviewer: "auto_review",
    })
    const full = await Session.fork({ sessionID: session.id, messageID: second, after: true })
    expect((await NativeStore.history(full.id)).filter((entry) => entry.info.role === "user")).toHaveLength(2)
    await send(child.id, "new branch")
    const starts = (await calls(dir)).filter((entry) => entry.method === "turn/start")
    expect(starts).toHaveLength(3)
    expect(starts[2].params.threadId).toBe(child.engine!.thread)
    expect(JSON.stringify(starts[2].params.input)).toContain("new branch")
    expect(JSON.stringify(starts[2].params.input)).not.toContain("first")
  })
})

test("editing the first question creates an empty native session without a fork RPC", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    await Session.setNativeMode({ sessionID: session.id, mode: "plan" })
    const child = await Session.fork({ sessionID: session.id, messageID: first })
    expect(child.engine).toMatchObject({
      type: "codex",
      model: "fixture",
      effort: "low",
      permission: "auto",
      mode: "plan",
    })
    expect(child.engine!.thread).toBeUndefined()
    expect(await NativeStore.history(child.id)).toEqual([])
    expect((await calls(dir)).some((entry) => entry.method === "thread/fork")).toBe(false)
  })
})

test("local busy and unconfirmed history reject before creating a branch", async () => {
  await scenario(async (session, dir) => {
    await send(session.id, "first")
    await SessionStatus.set(session.id, { type: "busy" })
    await expect(Session.fork({ sessionID: session.id })).rejects.toThrow("finish")
    await SessionStatus.set(session.id, { type: "idle" })
    await Bun.write(path.join(dir, "behavior"), "busy")
    await expect(Session.fork({ sessionID: session.id })).rejects.toThrow("incomplete")
    expect((await calls(dir)).some((entry) => entry.method === "thread/fork")).toBe(false)
    expect(await Session.children(session.id)).toEqual([])
  })
})

test("goal continuation and missing advertised safeguards fail without a fork RPC", async () => {
  await scenario(async (session, dir) => {
    await send(session.id, "first")
    await Bun.write(path.join(dir, "behavior"), "goal")
    await expect(Session.fork({ sessionID: session.id })).rejects.toThrow("has a goal")
    expect((await calls(dir)).some((entry) => entry.method === "thread/fork")).toBe(false)
  })
  await scenario(async (session, dir) => {
    await send(session.id, "first")
    await expect(Session.fork({ sessionID: session.id })).rejects.toThrow("does not advertise")
    expect(
      (await calls(dir)).some((entry) => entry.method === "thread/fork" || entry.method === "thread/goal/get"),
    ).toBe(false)
  }, true)
}, 15_000)

test("a goal inherited during the fork cannot arm an Aether branch", async () => {
  await scenario(async (session, dir) => {
    await send(session.id, "first")
    await Bun.write(path.join(dir, "behavior"), "goal-fork")
    await expect(Session.fork({ sessionID: session.id })).rejects.toThrow("has a goal")
    expect(await Session.children(session.id)).toEqual([])
    const requests = await calls(dir)
    expect(requests.filter((entry) => entry.method === "thread/fork")).toHaveLength(1)
    expect(requests.filter((entry) => entry.method === "thread/fork")[0].params.deferGoalContinuation).toBe(true)
    expect(requests.filter((entry) => entry.method === "turn/start")).toHaveLength(1)
  })
})

for (const behavior of ["reject", "drop", "extra"])
  test(`a ${behavior} response does not mutate the source or create an Aether branch`, async () => {
    await scenario(async (session, dir) => {
      const first = await send(session.id, "first")
      await send(session.id, "second")
      const before = await Session.get(session.id)
      const messages = await NativeStore.history(session.id)
      await Bun.write(path.join(dir, "behavior"), behavior)
      await expect(Session.fork({ sessionID: session.id, messageID: first, after: true })).rejects.toThrow()
      expect(await Session.get(session.id)).toEqual(before)
      expect(await NativeStore.history(session.id)).toEqual(messages)
      expect(await Session.children(session.id)).toEqual([])
      expect((await calls(dir)).filter((entry) => entry.method === "thread/fork")).toHaveLength(1)
    })
  })

test("same-turn follow-ups require an exact whole-turn boundary", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    const source = await Session.get(session.id)
    const file = path.join(dir, "fork-history.json")
    const history = (await Bun.file(file).json()) as Record<
      string,
      NativeHistory.Thread & { turns: NativeHistory.Turn[] }
    >
    const turn = history[source.engine!.thread!].turns[0]
    const client = MessageID.ascending()
    turn.items.push(
      { id: "follow-up", type: "userMessage", clientId: client, content: [{ type: "text", text: "follow-up" }] },
      { id: "follow-up-reply", type: "agentMessage", text: "continued" },
    )
    await Bun.write(file, JSON.stringify(history))
    await NativeSync.apply(source, {
      thread: history[source.engine!.thread!],
      turns: [turn],
      complete: true,
      issues: [],
    })
    const follow = (await NativeStore.history(session.id)).filter((entry) => entry.info.role === "user").at(-1)!.info.id
    await expect(Session.fork({ sessionID: session.id, messageID: first, after: true })).rejects.toThrow(
      "later follow-ups",
    )
    await expect(Session.fork({ sessionID: session.id, messageID: follow })).rejects.toThrow("in-turn follow-up")
    const child = await Session.fork({ sessionID: session.id, messageID: follow, after: true })
    expect((await NativeStore.history(child.id)).filter((entry) => entry.info.role === "user")).toHaveLength(2)
    expect((await calls(dir)).filter((entry) => entry.method === "thread/fork")).toHaveLength(1)
  })
})

test("forking through another instance keeps the owning directory and native attachment references", async () => {
  await scenario(async (session, dir) => {
    const image = "data:image/png;base64,aGVsbG8="
    await SessionPrompt.prompt({
      sessionID: session.id,
      parts: [
        { type: "text", text: "attached" },
        { type: "file", mime: "image/png", url: image },
      ],
    })
    const content = (await calls(dir)).find((entry) => entry.method === "turn/start")!.params.input as {
      type: string
      path?: string
    }[]
    const file = content.find((entry) => entry.type === "localImage")?.path
    expect(file).toBeDefined()
    const directory = path.join(dir, "sibling")
    await fs.mkdir(directory)
    try {
      const child = await Instance.provide({
        directory,
        project: Instance.project,
        worktree: Instance.worktree,
        fn: () => Session.fork({ sessionID: session.id }),
      })
      expect(child.directory).toBe(dir)
      expect(
        (await NativeStore.history(child.id))
          .flatMap((entry) => entry.parts)
          .some((part) => part.type === "file" && part.url === pathToFileURL(file!).href),
      ).toBe(true)
      expect(await Bun.file(file!).text()).toBe("hello")
      expect(child.forkParentSessionID).toBe(session.id)
    } finally {
      await Instance.disposeDirectory(directory)
    }
  })
})

test("capability checks follow required fork fields rather than the binary version", () => {
  const requests = {
    oneOf: ["thread/fork", "thread/goal/get"].map((method) => ({ properties: { method: { const: method } } })),
  }
  const shape = {
    required: ["threadId"],
    properties: {
      threadId: { type: "string" },
      lastTurnId: { type: ["string", "null"] },
      excludeTurns: { type: "boolean" },
      deferGoalContinuation: { type: "boolean" },
      approvalsReviewer: { enum: ["user", "auto_review"] },
    },
  }
  expect(NativeFork.supports(shape, requests)).toBe(true)
  expect(
    NativeFork.supports({ ...shape, properties: { ...shape.properties, deferGoalContinuation: {} } }, requests),
  ).toBe(false)
  expect(NativeFork.supports(shape, { oneOf: [] })).toBe(false)
})
