import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { NativeSkills } from "../../src/native/skills"
import { NativeRuntime } from "../../src/native/runtime"
import { NativeStore } from "../../src/native/store"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

async function scenario(run: (dir: string, cfg: string, file: string) => Promise<void>) {
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
    await Instance.provide({ directory: dir.path, fn: () => run(dir.path, cfg.path, file) })
  } finally {
    await NativeRuntime.dispose(dir.path)
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}

const skill = { name: "research", path: "skill://fixture/research", description: "Research", enabled: true }
async function calls(dir: string) {
  return (await Bun.file(path.join(dir, "fork-calls.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
}

test("native skills only advertise enabled valid entries for the requested cwd without losing duplicate names", () => {
  const cwd = process.cwd()
  const result = NativeSkills.parse(
    {
      data: [
        {
          cwd,
          skills: [
            skill,
            skill,
            {
              ...skill,
              path: "/another/SKILL.md",
              interface: { displayName: "Research helper", shortDescription: "A helper" },
            },
            { ...skill, name: "disabled", enabled: false },
            { ...skill, path: null },
          ],
          errors: [{ path: "/broken/SKILL.md", message: "Missing name" }],
        },
        { cwd: path.dirname(cwd), skills: [skill], errors: [] },
      ],
    },
    cwd,
  )
  expect(result.state).toBe("ready")
  expect(result.skills).toHaveLength(2)
  expect(result.skills[1]).toMatchObject({ displayName: "Research helper", description: "A helper" })
  expect(result.errors).toHaveLength(2)
  expect(() => NativeSkills.parse({ data: [] }, cwd)).toThrow("unique")
  expect(
    NativeSkills.parse({ data: [{ cwd: path.join(cwd, "."), skills: [skill], errors: [] }] }, cwd).skills,
  ).toHaveLength(1)
  if (process.platform === "win32")
    expect(
      NativeSkills.parse({ data: [{ cwd: cwd.toUpperCase(), skills: [skill], errors: [] }] }, cwd).skills,
    ).toHaveLength(1)
})

test("native skill catalog uses a project cache, refreshes from disk, and respects disabled or changed configuration", async () => {
  await scenario(async (dir, cfg, file) => {
    await Bun.write(path.join(dir, "skills.json"), JSON.stringify([skill]))
    expect((await NativeSkills.read()).skills).toHaveLength(1)
    await Bun.write(path.join(dir, "skills.json"), JSON.stringify([]))
    expect((await NativeSkills.read()).skills).toHaveLength(1)
    expect((await calls(dir)).filter((call) => call.method === "skills/list")).toHaveLength(1)
    expect((await NativeSkills.read({ refresh: true })).skills).toEqual([])
    expect((await calls(dir)).filter((call) => call.method === "skills/list")).toHaveLength(2)
    expect((await calls(dir)).filter((call) => call.method === "skills/list")[0].params).toEqual({
      cwds: [dir],
      forceReload: true,
    })
    await Bun.write(
      path.join(cfg, "aether.integrations.jsonc"),
      JSON.stringify({ native: { codex: { path: file, enabled: false } } }),
    )
    Config.global.reset()
    expect((await NativeSkills.read()).state).toBe("disabled")
    expect((await calls(dir)).filter((call) => call.method === "skills/list")).toHaveLength(2)
    await Bun.write(
      path.join(cfg, "aether.integrations.jsonc"),
      JSON.stringify({ native: { codex: { path: path.join(cfg, "missing.exe") } } }),
    )
    Config.global.reset()
    expect(await NativeSkills.read()).toMatchObject({ state: "unavailable", skills: [], error: expect.any(String) })
  })
}, 30_000)

test("native skill catalog reports protocol errors without presenting a false empty success", async () => {
  await scenario(async (dir) => {
    await Bun.write(path.join(dir, "skills.json"), JSON.stringify("unavailable"))
    expect(await NativeSkills.read()).toMatchObject({
      state: "unavailable",
      skills: [],
      error: "Skills catalog is unavailable",
    })
  })
}, 30_000)

test("native skill sends preserve explicit identity and validate again on the execution connection", async () => {
  await scenario(async (dir) => {
    await Bun.write(path.join(dir, "skills.json"), JSON.stringify([skill]))
    const session = await Session.create({ engine: { type: "codex", model: "fixture", permission: "user" } })
    const parts = [
      { type: "text" as const, text: "$research Summarize this paper" },
      {
        type: "text" as const,
        text: "$research",
        ignored: true,
        metadata: { nativeSkill: { name: skill.name, path: skill.path } },
      },
    ]
    const first = await SessionPrompt.prompt({ sessionID: session.id, parts })
    expect(first.info.role === "assistant" && first.info.error).toBeFalsy()
    const sent = (await calls(dir)).find((call) => call.method === "turn/start")!
    expect(sent.params.input).toEqual([
      { type: "text", text: parts[0].text, text_elements: [] },
      { type: "skill", name: skill.name, path: skill.path },
    ])
    const history = await NativeStore.history(session.id)
    expect(
      history.some((message) => message.parts.some((part) => part.type === "text" && part.metadata?.nativeSkill)),
    ).toBe(true)
    await Bun.write(path.join(dir, "skills.json"), JSON.stringify([{ ...skill, enabled: false }]))
    const second = await SessionPrompt.prompt({ sessionID: session.id, parts })
    expect(second.info.role === "assistant" && second.info.error).toBeTruthy()
    expect((await calls(dir)).filter((call) => call.method === "turn/start")).toHaveLength(1)
    expect((await calls(dir)).filter((call) => call.method === "skills/list")).toHaveLength(2)
    expect(NativeStore.pending(session.id)).toEqual([])
    const third = await SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "Continue" }] })
    expect(third.info.role === "assistant" && third.info.error).toBeFalsy()
    expect((await calls(dir)).filter((call) => call.method === "turn/start")).toHaveLength(2)
  })
}, 30_000)

test("native skills cannot persist as deferred context that blocks later messages", async () => {
  await scenario(async (dir) => {
    const session = await Session.create({ engine: { type: "codex", model: "fixture", permission: "user" } })
    await expect(
      SessionPrompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: [
          {
            type: "text",
            text: "$research",
            ignored: true,
            metadata: { nativeSkill: { name: skill.name, path: skill.path } },
          },
        ],
      }),
    ).rejects.toThrow("not as deferred research context")
    expect(NativeStore.pending(session.id)).toEqual([])
    expect(await NativeStore.history(session.id)).toEqual([])
    expect(await Bun.file(path.join(dir, "fork-calls.jsonl")).exists()).toBe(false)
    const result = await SessionPrompt.prompt({ sessionID: session.id, parts: [{ type: "text", text: "Continue" }] })
    expect(result.info.role === "assistant" && result.info.error).toBeFalsy()
  })
}, 30_000)
