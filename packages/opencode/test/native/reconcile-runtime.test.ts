import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeHistory } from "../../src/native/history"
import { NativeRuntime } from "../../src/native/runtime"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (session: Session.Info, dir: string) => Promise<void>) {
  await using dir = await tmpdir({ git: true, config: { snapshot: false } })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "fork-fixture.ts")
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
        const session = await Session.create({
          engine: { type: "codex", model: "fixture", effort: "low", permission: "auto" },
        })
        await run(session, dir.path)
      },
    })
  } finally {
    await NativeRuntime.dispose(dir.path)
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
  fn(history[(await Session.get(session.id)).engine!.thread!])
  await Bun.write(file, JSON.stringify(history))
}

test("refreshing an external rollback evicts the resident process before the next turn without resending removed input", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    const second = await send(session.id, "second")
    await alter(session, dir, (thread) => {
      thread.turns = thread.turns.slice(0, 1)
      thread.updatedAt++
    })
    expect(await NativeSync.refresh(session.id, true)).toMatchObject({ state: "synced" })
    expect(
      (await NativeStore.history(session.id))
        .filter((entry) => entry.info.role === "user")
        .map((entry) => entry.info.id),
    ).toEqual([first])
    expect(NativeStore.dispatches(session.id, { retired: true }).find((entry) => entry.id === second)?.state).toBe(
      "retired",
    )
    const count = (await calls(dir)).length
    await send(session.id, "third")
    const requests = (await calls(dir)).slice(count)
    expect(requests.some((entry) => entry.method === "thread/resume")).toBe(true)
    expect(requests.filter((entry) => entry.method === "turn/start")).toHaveLength(1)
    expect(JSON.stringify(requests.find((entry) => entry.method === "turn/start")?.params.input)).not.toContain(
      "second",
    )
    expect(
      (await calls(dir)).some((entry) =>
        ["thread/revert", "thread/rollback", "thread/compact/start"].includes(entry.method),
      ),
    ).toBe(false)
  })
}, 30_000)

test("external compaction evicts once while preserving transcript and later process reuse", async () => {
  await scenario(async (session, dir) => {
    const first = await send(session.id, "first")
    await alter(session, dir, (thread) => {
      thread.turns.push({
        id: "compaction",
        status: "completed",
        itemsView: "full",
        items: [{ id: "compacted", type: "contextCompaction" }],
      })
      thread.updatedAt++
    })
    expect(await NativeSync.refresh(session.id, true)).toMatchObject({ state: "synced" })
    expect(
      (await NativeStore.history(session.id))
        .filter((entry) => entry.info.role === "user")
        .map((entry) => entry.info.id),
    ).toEqual([first])
    const count = (await calls(dir)).length
    await send(session.id, "second")
    expect((await calls(dir)).slice(count).some((entry) => entry.method === "thread/resume")).toBe(true)
    expect(await NativeSync.refresh(session.id, true)).toMatchObject({ state: "synced" })
    const repeated = (await calls(dir)).length
    await send(session.id, "third")
    expect((await calls(dir)).slice(repeated).some((entry) => entry.method === "thread/resume")).toBe(false)
  })
}, 30_000)

test.each(["interrupted", "failed"])(
  "repeated refresh of retained %s history preserves answers and the resident process",
  async (status) => {
    await scenario(async (session, dir) => {
      await send(session.id, "first")
      await send(session.id, "second")
      await send(session.id, "removed")
      await alter(session, dir, (thread) => {
        thread.turns = thread.turns.slice(0, 2)
        thread.turns[0].status = status
        thread.turns[1].items.push({
          id: "question",
          type: "agentMessage",
          text: "Choose a style",
          delivery: "async",
          questions: [{ title: "Style?", options: ["Short", "Detailed"] }],
        })
        thread.updatedAt++
      })
      expect(await NativeSync.refresh(session.id, true)).toMatchObject({ state: "synced" })
      await send(session.id, "after rollback")
      const card = (await NativeStore.history(session.id))
        .flatMap((entry) => entry.parts)
        .find((part) => part.type === "text" && part.nativeQuestion)
      if (card?.type !== "text" || !card.nativeQuestion) throw new Error("Expected the retained question card")
      const file = path.join(Global.Path.data, "native-answers", Instance.project.id, `${session.id}.json`)
      const receipt = [{ question: { ...card.nativeQuestion, state: "answered", answers: ["Short"] } }]
      await Bun.write(file, JSON.stringify(receipt))
      await NativeSync.refresh(session.id, true)
      await NativeSync.refresh(session.id, true)
      expect(await Bun.file(file).json()).toEqual(receipt)
      const count = (await calls(dir)).length
      await send(session.id, "still reusing")
      expect((await calls(dir)).slice(count).some((entry) => entry.method === "thread/resume")).toBe(false)
    })
  },
  30_000,
)
