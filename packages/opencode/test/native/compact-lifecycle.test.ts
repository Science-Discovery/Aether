import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeCompact } from "../../src/native/compact"
import { NativeStore } from "../../src/native/store"
import { NativeSync } from "../../src/native/sync"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { PartID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (session: Session.Info, dir: string) => Promise<void>) {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "compact-fixture.ts")
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
        const session = await Session.createNext({
          directory: Instance.directory,
          engine: { type: "codex", thread: "compact-thread", model: "fixture" },
        })
        await Bun.write(
          path.join(dir.path, "compact-history.json"),
          JSON.stringify({
            id: "compact-thread",
            createdAt: 100,
            updatedAt: 100,
            status: { type: "idle" },
            cwd: dir.path,
            turns: [
              {
                id: "initial",
                status: "completed",
                itemsView: "full",
                items: [
                  { id: "user", type: "userMessage", content: [{ type: "text", text: "research" }] },
                  { id: "assistant", type: "agentMessage", text: "Prior answer" },
                ],
              },
            ],
          }),
        )
        await run(session, dir.path)
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

async function count(dir: string) {
  const text = await Bun.file(path.join(dir, "compact-calls.jsonl"))
    .text()
    .catch(() => "")
  return text
    .split("\n")
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string })
    .filter((entry) => entry.method === "thread/compact/start").length
}

test("manual compaction stays busy after acknowledgement, then reconciles and never repeats an operation ID", async () => {
  await scenario(async (session, dir) => {
    await Bun.write(path.join(dir, "behavior"), "delayed")
    const input = { sessionID: session.id, id: crypto.randomUUID() }
    const pending = NativeCompact.start(input)
    void pending.catch(() => undefined)
    for (let index = 0; index < 200 && !(await count(dir)); index++) await Bun.sleep(10)
    expect(await count(dir)).toBe(1)
    expect((await SessionStatus.get(session.id)).type).toBe("busy")
    expect((await NativeCompact.status(session.id))?.state).toBe("pending")
    expect((await NativeCompact.start(input)).state).toBe("pending")
    await expect(NativeCompact.guard(session.id)).rejects.toThrow("compaction")
    await Bun.write(path.join(dir, "continue"), "yes")
    expect((await pending).state).toBe("complete")
    expect((await SessionStatus.get(session.id)).type).toBe("idle")
    expect((await NativeCompact.start(input)).state).toBe("complete")
    expect(await count(dir)).toBe(1)
    expect((await NativeCompact.start({ sessionID: session.id, id: crypto.randomUUID() })).state).toBe("complete")
    expect((await NativeCompact.start(input)).state).toBe("complete")
    expect(await count(dir)).toBe(2)
    const history = await NativeStore.history(session.id)
    expect(history.findLast((entry) => entry.info.role === "assistant")?.info).toMatchObject({
      nativeUsage: { input: 100, contextWindow: 10000 },
    })
    expect(
      history.some((entry) =>
        entry.parts.some((part) => part.type === "tool" && part.tool === "codex.contextCompaction"),
      ),
    ).toBe(true)
    await NativeCompact.guard(session.id)
  })
}, 15_000)

test("a lost completion is verified by reading history rather than compacting again", async () => {
  await scenario(async (session, dir) => {
    await Bun.write(path.join(dir, "behavior"), "lost")
    const input = { sessionID: session.id, id: crypto.randomUUID() }
    expect((await NativeCompact.start(input)).state).toBe("uncertain")
    expect((await NativeCompact.start(input)).state).toBe("uncertain")
    expect((await NativeCompact.status(session.id, true))?.state).toBe("complete")
    expect(await count(dir)).toBe(1)
    await NativeCompact.guard(session.id)
  })
}, 15_000)

test("closed unchanged compaction can be checked and released without retrying, unsupported versions fail clearly", async () => {
  await scenario(async (session, dir) => {
    await Bun.write(path.join(dir, "behavior"), "ack-disconnect")
    expect((await NativeCompact.start({ sessionID: session.id, id: crypto.randomUUID() })).state).toBe("uncertain")
    await expect(NativeCompact.start({ sessionID: session.id, id: crypto.randomUUID() })).rejects.toThrow("compaction")
    expect((await NativeCompact.status(session.id, true))?.state).toBe("failed")
    await NativeCompact.guard(session.id)
    expect(await count(dir)).toBe(1)
    await Bun.write(path.join(dir, "behavior"), "unsupported")
    expect(await NativeCompact.start({ sessionID: session.id, id: crypto.randomUUID() })).toMatchObject({
      state: "failed",
      error: expect.stringContaining("Update Codex"),
    })
    await NativeCompact.guard(session.id)
    expect((await SessionStatus.get(session.id)).type).toBe("idle")
  })
}, 15_000)

test("a durable pending receipt after service loss remains guarded and cannot be dispatched again", async () => {
  await scenario(async (session, dir) => {
    const input = { sessionID: session.id, id: crypto.randomUUID() }
    const thread = (await Bun.file(path.join(dir, "compact-history.json")).json()) as { turns: unknown[] }
    await Bun.write(
      path.join(Global.Path.data, "native-compactions", Instance.project.id, `${session.id}.json`),
      JSON.stringify({
        ...input,
        threadID: "compact-thread",
        state: "pending",
        home: path.join(dir, "codex-home"),
        history: thread.turns,
        updated: Date.now(),
      }),
    )
    expect((await NativeCompact.status(session.id))?.state).toBe("uncertain")
    await expect(NativeCompact.guard(session.id)).rejects.toThrow("compaction")
    expect((await NativeCompact.start(input)).state).toBe("uncertain")
    expect((await NativeCompact.status(session.id, true))?.state).toBe("uncertain")
    expect(await count(dir)).toBe(0)
  })
}, 15_000)

test("stopping compaction waits for the owned process and retains a checkable receipt", async () => {
  await scenario(async (session, dir) => {
    await Bun.write(path.join(dir, "behavior"), "delayed")
    const pending = NativeCompact.start({ sessionID: session.id, id: crypto.randomUUID() })
    void pending.catch(() => undefined)
    for (let index = 0; index < 200 && !(await count(dir)); index++) await Bun.sleep(10)
    expect(await count(dir)).toBe(1)
    await NativeCompact.cancel(session.id)
    expect((await pending).state).toBe("uncertain")
    expect((await SessionStatus.get(session.id)).type).toBe("idle")
    expect((await NativeCompact.status(session.id, true))?.state).toBe("failed")
    expect(await count(dir)).toBe(1)
  })
}, 15_000)

test("compacted context usage survives history refresh over an earlier execution receipt", async () => {
  await scenario(async (session) => {
    expect((await NativeSync.refresh(session.id, true)).state).toBe("synced")
    const history = await NativeStore.history(session.id)
    const user = history.find((entry) => entry.info.role === "user")!
    const reply = history.find((entry) => entry.info.role === "assistant")!
    if (reply.info.role !== "assistant") throw new Error("The fixture needs an assistant reply")
    const original = { ...reply.info, nativeUsage: { input: 9000, contextWindow: 10000, updatedAt: 1 } }
    NativeStore.add(
      {
        info: user.info,
        parts: [
          { type: "text", id: PartID.ascending(), messageID: user.info.id, sessionID: session.id, text: "research" },
        ],
      },
      false,
    )
    NativeStore.begin(session.id, user.info.id, original.id, "compact-thread", [user.info.id])
    NativeStore.accept(session.id, user.info.id, "initial")
    NativeStore.receipt(original)
    await Session.updateMessage(original)
    const result = await NativeCompact.start({ sessionID: session.id, id: crypto.randomUUID() })
    expect(result.error).toBeUndefined()
    expect(result.state).toBe("complete")
    expect(
      (await NativeStore.history(session.id)).findLast((entry) => entry.info.role === "assistant")?.info,
    ).toMatchObject({ nativeUsage: { input: 100 } })
    expect((await NativeSync.refresh(session.id, true)).state).toBe("synced")
    expect(
      (await NativeStore.history(session.id)).findLast((entry) => entry.info.role === "assistant")?.info,
    ).toMatchObject({ nativeUsage: { input: 100, contextWindow: 10000 } })
    expect(NativeStore.dispatches(session.id)[0].assistant?.nativeUsage?.input).toBe(100)
  })
}, 15_000)
