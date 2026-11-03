import { expect, test } from "bun:test"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeUsage } from "../../src/native/usage"
import { tmpdir } from "../fixture/fixture"

const available = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000 } } }

async function scenario(run: (dir: string, file: string) => Promise<void>) {
  await using tmp = await tmpdir()
  const prior = Global.Path.config
  const home = process.env.CODEX_HOME
  Global.Path.config = tmp.path
  process.env.CODEX_HOME = tmp.path
  Config.global.reset()
  NativeUsage.invalidate()
  try {
    const file = path.join(tmp.path, process.platform === "win32" ? "codex.cmd" : "codex")
    const source = path.join(import.meta.dir, "usage-fixture.ts")
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await Bun.write(
      file,
      process.platform === "win32"
        ? `@echo off\r\ncd /d "%~dp0"\r\n"${process.execPath}" "${source}" %*\r\n`
        : `#!/bin/sh\ncd ${quote(tmp.path)} || exit 1\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`,
    )
    if (process.platform !== "win32") await chmod(file, 0o755)
    await Bun.write(
      path.join(tmp.path, "aether.integrations.jsonc"),
      JSON.stringify({ native: { codex: { path: file } } }),
    )
    await Bun.write(path.join(tmp.path, "response.json"), JSON.stringify({ result: available }))
    await run(tmp.path, file)
  } finally {
    Global.Path.config = prior
    if (home === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = home
    Config.global.reset()
    NativeUsage.invalidate()
  }
}

async function methods(dir: string) {
  return (
    await Bun.file(path.join(dir, "calls.jsonl"))
      .text()
      .catch(() => "")
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method: string }).method)
}

test("quota parsing prefers named buckets and does not invent missing windows or reset times", () => {
  const result = NativeUsage.parse({
    ...available,
    rateLimitsByLimitId: {
      extra: {
        limitName: "Extra",
        primary: null,
        secondary: { usedPercent: 55, resetsAt: null, windowDurationMins: null },
      },
      codex: { primary: { usedPercent: 0 } },
    },
  })
  expect(result.state).toBe("available")
  expect(result.limits).toEqual([
    {
      id: "extra",
      name: "Extra",
      primary: undefined,
      secondary: { usedPercent: 55, resetsAt: undefined, windowDurationMins: undefined },
    },
    {
      id: "codex",
      name: undefined,
      primary: { usedPercent: 0, resetsAt: undefined, windowDurationMins: undefined },
      secondary: undefined,
    },
  ])
})

test("legacy quota remains supported, while empty or malformed snapshots are unknown rather than zero", () => {
  expect(NativeUsage.parse(available)).toMatchObject({
    state: "available",
    limits: [{ id: "codex", primary: { usedPercent: 25 } }],
  })
  for (const value of [
    null,
    {},
    { rateLimits: { primary: null } },
    { rateLimits: { primary: { usedPercent: "0" } } },
    { ...available, rateLimitsByLimitId: {} },
  ]) {
    expect(NativeUsage.parse(value)).toMatchObject({ state: "unavailable", limits: [] })
  }
})

test("quota reads coalesce and cache a real protocol fixture, and only manual refresh repeats the query", async () => {
  await scenario(async (dir) => {
    const results = await Promise.all([NativeUsage.read(), NativeUsage.read(), NativeUsage.read({ refresh: true })])
    expect(results.every((result) => result.state === "available")).toBe(true)
    await NativeUsage.read()
    expect((await methods(dir)).filter((method) => method === "account/rateLimits/read")).toHaveLength(1)
    await NativeUsage.read({ refresh: true })
    expect((await methods(dir)).filter((method) => method === "account/rateLimits/read")).toHaveLength(2)
    expect(
      (await methods(dir)).every((method) => ["initialize", "initialized", "account/rateLimits/read"].includes(method)),
    ).toBe(true)
  })
})

test("disabled quota launches nothing and cannot reuse a prior snapshot", async () => {
  await scenario(async (dir, file) => {
    const settings = path.join(dir, "aether.integrations.jsonc")
    await Bun.write(settings, JSON.stringify({ native: { codex: { path: file, enabled: false } } }))
    Config.global.reset()
    expect(await NativeUsage.read({ refresh: true })).toEqual({ enabled: false, state: "disabled", limits: [] })
    expect(await methods(dir)).toEqual([])
    await Bun.write(settings, JSON.stringify({ native: { codex: { path: file } } }))
    Config.global.reset()
    expect((await NativeUsage.read()).state).toBe("available")
    await Bun.write(settings, JSON.stringify({ native: { codex: { path: file, enabled: false } } }))
    Config.global.reset()
    expect((await NativeUsage.read()).state).toBe("disabled")
    expect((await methods(dir)).filter((method) => method === "account/rateLimits/read")).toHaveLength(1)
  })
})

test("unsupported quota responses are cached as unknown and path changes never reuse another executable's result", async () => {
  await scenario(async (dir) => {
    await Bun.write(
      path.join(dir, "response.json"),
      JSON.stringify({ error: { code: -32601, message: "Unsupported" } }),
    )
    expect((await NativeUsage.read()).state).toBe("unavailable")
    await NativeUsage.read()
    expect((await methods(dir)).filter((method) => method === "account/rateLimits/read")).toHaveLength(1)
    await Bun.write(path.join(dir, "response.json"), JSON.stringify({ result: available }))
    expect((await NativeUsage.read({ refresh: true })).state).toBe("available")
    await Bun.write(
      path.join(dir, "aether.integrations.jsonc"),
      JSON.stringify({ native: { codex: { path: path.join(dir, "missing") } } }),
    )
    Config.global.reset()
    expect((await NativeUsage.read()).state).toBe("unavailable")
  })
})
