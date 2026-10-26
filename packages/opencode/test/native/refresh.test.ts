import { expect, test } from "bun:test"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { NativeLock } from "../../src/native/lock"
import { NativeSession } from "../../src/native/session"
import { NativeSync } from "../../src/native/sync"
import { Session } from "../../src/session"
import { NativeStore } from "../../src/native/store"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

test("reads saved turns through a separate app-server without resuming or sending, and respects local execution", async () => {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "session-fixture.ts")
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`,
  )
  if (process.platform !== "win32") await chmod(file, 0o755)
  await Bun.write(path.join(dir.path, "scenario.json"), JSON.stringify({ mode: "history" }))
  await Bun.write(path.join(cfg.path, "aether.json"), JSON.stringify({ native: { codex: { path: file } } }))
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        const result = await NativeSession.prompt(
          { sessionID: session.id, parts: [{ type: "text", text: "Original input" }] },
          session,
          new AbortController().signal,
        )
        const saved = await Session.get(session.id)
        expect(saved.engine?.thread).toBeTruthy()
        expect((await NativeSync.refresh(session.id, true)).state).toBe("synced")
        const first = await NativeStore.history(session.id)
        if (result.info.role !== "assistant") throw new Error("Expected a native reply")
        expect(first.map((entry) => entry.info.id)).toEqual([result.info.parentID, result.info.id])
        expect(first[1].parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
          "Native response",
        ])

        const journal = await Bun.file(path.join(dir.path, "native-history.json")).json()
        const thread = journal[saved.engine!.thread!]
        thread.updatedAt += 1
        thread.turns.push({
          id: "external-turn",
          status: "completed",
          startedAt: thread.updatedAt,
          completedAt: thread.updatedAt,
          itemsView: "full",
          items: [
            { id: "external-user", type: "userMessage", content: [{ type: "text", text: "Sent from another client" }] },
            { id: "external-assistant", type: "agentMessage", text: "External saved response" },
          ],
        })
        await Bun.write(path.join(dir.path, "native-history.json"), JSON.stringify(journal))
        const response = await Server.Default().request(
          `http://localhost/native/codex/${session.id}/history?refresh=true&directory=${encodeURIComponent(dir.path)}`,
          { method: "POST" },
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ state: "synced", messages: 4 })
        const messages = await NativeStore.history(session.id)
        expect(messages).toHaveLength(4)
        expect(messages[3].parts.some((part) => part.type === "text" && part.text === "External saved response")).toBe(
          true,
        )
        await NativeLock.run(session.id, async () =>
          expect((await NativeSync.refresh(session.id, true)).state).toBe("busy"),
        )
        await Config.updateGlobal({ native: { codex: { enabled: false } } })
        expect((await NativeSync.refresh(session.id, true)).state).toBe("disabled")
        expect(await NativeStore.history(session.id)).toEqual(messages)
        const calls = (await Bun.file(path.join(dir.path, "calls.jsonl")).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; method?: string })
        expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(0)
        expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(1)
        expect(
          new Set(calls.filter((call) => call.method === "initialize").map((call) => call.pid)).size,
        ).toBeGreaterThan(1)
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
})
