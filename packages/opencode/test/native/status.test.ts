import { expect, test } from "bun:test"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { Codex } from "../../src/native/codex"
import { Native } from "../../src/native/schema"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { NativeRoutes } from "../../src/server/routes/native"
import { tmpdir } from "../fixture/fixture"

async function executable(dir: string) {
  const file = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex")
  const source = path.join(import.meta.dir, "session-fixture.ts")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\ncd /d "%~dp0"\r\n"${process.execPath}" "${source}" %*\r\n`
      : `#!/bin/sh\ncd ${quote(dir)} || exit 1\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`,
  )
  if (process.platform !== "win32") await chmod(file, 0o755)
  await Bun.write(path.join(dir, "scenario.json"), JSON.stringify({ mode: "normal" }))
  return file
}

async function starts(dir: string) {
  const text = await Bun.file(path.join(dir, "calls.jsonl"))
    .text()
    .catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string })
    .filter((item) => item.method === "initialize").length
}

test("status coalesces real subprocess probes, caches results and explicitly refreshes", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  Codex.invalidate()
  const first = Codex.status(file)
  expect(Codex.status(file)).toBe(first)
  expect(Codex.status(file, { refresh: true })).toBe(first)
  expect(await first).toMatchObject({ enabled: true, installed: true, connected: true, auth: "chatgpt" })
  await Codex.status(file)
  expect(await starts(dir.path)).toBe(1)
  await Codex.status(file, { refresh: true })
  expect(await starts(dir.path)).toBe(2)
  Codex.invalidate()
  await Codex.status(file)
  expect(await starts(dir.path)).toBe(3)
  Codex.invalidate()
})

test("disabled status launches nothing and invalidates a previous successful result", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  Codex.invalidate()
  expect(await Codex.status(file, { enabled: false })).toEqual({
    enabled: false,
    installed: false,
    connected: false,
    auth: "unknown",
    models: [],
  })
  expect(await starts(dir.path)).toBe(0)
  await Codex.status(file)
  await Codex.status(file, { enabled: false, refresh: true })
  expect(await starts(dir.path)).toBe(1)
  await Codex.status(file)
  expect(await starts(dir.path)).toBe(2)
  Codex.invalidate()
})

test("manual refresh repairs a cached discovery failure and path changes cannot reuse another catalog", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, process.platform === "win32" ? "codex.cmd" : "codex")
  Codex.invalidate()
  expect((await Codex.status(file)).installed).toBe(false)
  await executable(dir.path)
  expect((await Codex.status(file)).installed).toBe(false)
  expect((await Codex.status(file, { refresh: true })).connected).toBe(true)
  expect((await Codex.status(path.join(dir.path, "missing"))).installed).toBe(false)
  expect((await Codex.status(file)).connected).toBe(true)
  Codex.invalidate()
})

test("native settings validate limits and disabled creation preserves existing history", async () => {
  expect(Native.Config.parse({})).toEqual({})
  for (const limit of [-1, 17, 1.5]) expect(Native.Config.safeParse({ limit }).success).toBe(false)
  for (const limit of [0, 4, 16]) expect(Native.Config.safeParse({ limit }).success).toBe(true)
  await using dir = await tmpdir()
  await using cfg = await tmpdir()
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        await Config.updateGlobal({ native: { codex: { enabled: false, limit: 0 } } })
        const status = await NativeRoutes().request("/codex?refresh=false")
        expect(status.status).toBe(200)
        expect(await status.json()).toMatchObject({ enabled: false, connected: false })
        expect((await NativeRoutes().request("/codex?refresh=invalid")).status).toBe(400)
        await expect(Session.create({ engine: { type: "codex" } })).rejects.toThrow("NativeSessionUnsupported")
        expect((await Session.get(session.id)).engine?.type).toBe("codex")
        expect((await Session.create({})).engine).toBeUndefined()
        await Config.updateGlobal({ native: { codex: { enabled: true } } })
        expect((await Session.create({ engine: { type: "codex" } })).engine?.type).toBe("codex")
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
    Codex.invalidate()
  }
})
