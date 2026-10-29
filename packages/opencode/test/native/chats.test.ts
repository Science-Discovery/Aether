import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeChats } from "../../src/native/chats"
import { NativeStore } from "../../src/native/store"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

function thread(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    cwd,
    name: `Chat ${id}`,
    createdAt: 100,
    updatedAt: 200,
    source: "vscode",
    ephemeral: false,
    status: { type: "notLoaded" },
    model: "fixture",
    reasoningEffort: "low",
    turns: [
      {
        id: `${id}-turn`,
        status: "completed",
        itemsView: "full",
        startedAt: 100,
        completedAt: 110,
        items: [
          { id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: "A native question" }] },
          { id: `${id}-answer`, type: "agentMessage", text: "A native answer", phase: "final_answer" },
        ],
      },
    ],
    ...extra,
  }
}

async function scenario(run: (dir: string) => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "chats-fixture.ts")
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
  await Bun.write(
    path.join(dir.path, "chats.json"),
    JSON.stringify({ one: thread("one", dir.path), two: thread("two", dir.path), three: thread("three", dir.path) }),
  )
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({ directory: dir.path, fn: () => run(dir.path) })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

test("native chat listing pages and searches only current project interactive chats", async () => {
  await scenario(async (dir) => {
    const page = await NativeChats.list()
    expect(page.chats.map((item) => item.id)).toEqual(["one", "two"])
    expect((await NativeChats.list({ cursor: page.cursor, scope: page.scope })).chats.map((item) => item.id)).toEqual([
      "three",
    ])
    expect((await NativeChats.list({ search: "three" })).chats.map((item) => item.id)).toEqual(["three"])
    await Bun.write(
      path.join(dir, "chats.json"),
      JSON.stringify({
        foreign: thread("foreign", path.dirname(dir)),
        child: thread("child", dir, {
          source: { subAgent: { thread_spawn: { parent_thread_id: "one" } } },
          parentThreadId: "one",
        }),
      }),
    )
    expect((await NativeChats.list()).chats).toEqual([])
    const calls = (await Bun.file(path.join(dir, "calls.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    expect(
      calls
        .filter((call) => call.method === "thread/list")
        .every((call) => Array.isArray(call.params.cwd) && call.params.cwd.includes(dir)),
    ).toBe(true)
  })
})

test("concurrent linking shares one Aether session and never resumes or modifies the native thread", async () => {
  await scenario(async (dir) => {
    const original = await Bun.file(path.join(dir, "chats.json")).text()
    const page = await NativeChats.list()
    const [first, second] = await Promise.all([
      NativeChats.attach({ threadID: "one", scope: page.scope }),
      NativeChats.attach({ threadID: "one", scope: page.scope }),
    ])
    expect(first.id).toBe(second.id)
    expect(first.engine).toMatchObject({ thread: "one", model: "fixture", effort: "low", permission: "auto" })
    expect(NativeStore.state(first.id)?.home).toBe(dir)
    expect((await NativeStore.history(first.id)).map((item) => item.info.role)).toEqual(["user", "assistant"])
    expect([...Session.list()].length).toBe(1)
    expect((await NativeChats.list()).chats.find((item) => item.id === "one")?.sessionID).toBe(first.id)
    expect(await Bun.file(path.join(dir, "chats.json")).text()).toBe(original)
    const calls = (await Bun.file(path.join(dir, "calls.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string })
    expect(
      calls.every((call) =>
        ["initialize", "thread/list", "thread/read", "thread/turns/list", "thread/goal/get"].includes(call.method),
      ),
    ).toBe(true)
  })
})

test("linking rejects changed homes, foreign directories, active threads and incomplete projections", async () => {
  await scenario(async (dir) => {
    const page = await NativeChats.list()
    await Bun.write(path.join(dir, "home"), "another-home")
    await expect(NativeChats.attach({ threadID: "one", scope: page.scope })).rejects.toThrow("home or project changed")
    await Bun.write(path.join(dir, "home"), dir)
    for (const extra of [
      { cwd: path.dirname(dir) },
      { status: { type: "active" } },
      { ephemeral: true },
      { goal: { status: "active" } },
      { turns: [{ id: "bad", status: "completed", items: [{ id: "bad", type: "newUnsupportedItem" }] }] },
    ]) {
      await Bun.write(path.join(dir, "chats.json"), JSON.stringify({ one: thread("one", dir, extra) }))
      await expect(NativeChats.attach({ threadID: "one", scope: page.scope })).rejects.toThrow()
      expect([...Session.list()]).toHaveLength(0)
    }
  })
})

test("legacy unbound links reserve their native identity including child Aether sessions", async () => {
  await scenario(async () => {
    const parent = await Session.create({})
    const legacy = await Session.createNext({
      directory: Instance.directory,
      parentID: parent.id,
      engine: { type: "codex", thread: "one" },
    })
    const page = await NativeChats.list()
    await expect(NativeChats.attach({ threadID: "one", scope: page.scope })).rejects.toThrow("home is not confirmed")
    expect([...Session.list()].map((item) => item.id)).toContain(legacy.id)
    expect([...Session.list()]).toHaveLength(2)
  })
})

test("internal child navigation verifies ancestry and public chat attachment excludes children", async () => {
  await scenario(async (dir) => {
    await Bun.write(
      path.join(dir, "chats.json"),
      JSON.stringify({
        one: thread("one", dir),
        child: thread("child", dir, {
          source: { subAgent: { thread_spawn: { parent_thread_id: "one" } } },
          parentThreadId: "one",
        }),
      }),
    )
    const page = await NativeChats.list()
    await expect(NativeChats.attach({ threadID: "child", scope: page.scope })).rejects.toThrow("interactive")
    await expect(NativeChats.child("child", "wrong", dir)).rejects.toThrow()
    await expect(NativeChats.child("child", "one", "wrong-home")).rejects.toThrow("home or project changed")
    const child = await NativeChats.child("child", "one", dir)
    expect(child.engine?.thread).toBe("child")
    expect((await NativeChats.child("child", "one", dir)).id).toBe(child.id)
    expect(await NativeStore.history(child.id)).toHaveLength(2)
    await Bun.write(
      path.join(dir, "chats.json"),
      JSON.stringify({
        one: thread("one", dir),
        child: thread("child", dir, {
          source: { subAgent: { thread_spawn: { parent_thread_id: "another-parent" } } },
          parentThreadId: "one",
        }),
      }),
    )
    await expect(NativeChats.child("child", "one", dir)).rejects.toThrow("conflicting parent")
  })
})
