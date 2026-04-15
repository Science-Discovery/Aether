import { beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Persist, legacyPlatformDir, platformDir } from "../../src/persist/naming"
import { ensureProject, ensureUser, reset } from "../../src/persist/migrate"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

async function clean(dir: string) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

describe("persist.migrate", () => {
  beforeEach(async () => {
    reset()
    await Promise.all([
      clean(Persist.current.data),
      clean(Persist.current.config),
      clean(Persist.current.state),
      clean(Persist.current.cache),
      clean(Persist.legacy.data),
      clean(Persist.legacy.config),
      clean(Persist.legacy.state),
      clean(legacyPlatformDir("wechat")),
      clean(platformDir("wechat")),
      clean(legacyPlatformDir("feishu")),
      clean(platformDir("feishu")),
      clean(legacyPlatformDir("wechat-bridge")),
      clean(platformDir("wechat-bridge")),
    ])
    await Global.ensureDirs()
  })

  test("copies legacy user files into new roots without touching legacy", async () => {
    await fs.mkdir(Persist.legacy.data, { recursive: true })
    await fs.mkdir(Persist.legacy.config, { recursive: true })
    await fs.mkdir(Persist.legacy.state, { recursive: true })
    await fs.mkdir(legacyPlatformDir("wechat"), { recursive: true })
    await Bun.write(path.join(Persist.legacy.data, "auth.json"), JSON.stringify({ token: "old" }))
    await Bun.write(path.join(Persist.legacy.config, "config.json"), JSON.stringify({ model: "x/y" }))
    await Bun.write(path.join(Persist.legacy.config, "opencode.jsonc"), JSON.stringify({ provider: { openai: { options: { baseURL: "https://old.example.com/v1" } } } }))
    await Bun.write(path.join(Persist.legacy.state, "model.json"), JSON.stringify({ value: "old-model" }))
    await Bun.write(path.join(legacyPlatformDir("wechat"), "session.json"), JSON.stringify({ connected: true }))

    await ensureUser()

    expect(await Bun.file(path.join(Persist.current.data, "auth.json")).json()).toEqual({ token: "old" })
    expect(await Bun.file(path.join(Persist.current.config, "config.json")).json()).toEqual({ model: "x/y" })
    expect(await Bun.file(path.join(Persist.current.config, "aether.jsonc")).json()).toEqual({
      provider: { openai: { options: { baseURL: "https://old.example.com/v1" } } },
    })
    expect(await Bun.file(path.join(Persist.current.state, "model.json")).json()).toEqual({ value: "old-model" })
    expect(await Bun.file(path.join(platformDir("wechat"), "session.json")).json()).toEqual({ connected: true })
    expect(await Bun.file(path.join(Persist.legacy.data, "auth.json")).json()).toEqual({ token: "old" })
  })

  test("does not overwrite files that already exist in the new path", async () => {
    await fs.mkdir(Persist.legacy.data, { recursive: true })
    await Bun.write(path.join(Persist.legacy.data, "auth.json"), JSON.stringify({ token: "old" }))
    await Bun.write(path.join(Persist.current.data, "auth.json"), JSON.stringify({ token: "new" }))

    await ensureUser()

    expect(await Bun.file(path.join(Persist.current.data, "auth.json")).json()).toEqual({ token: "new" })
  })

  test("copies project skills from .opencode to .aether once", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const skill = path.join(dir, ".opencode", "skills", "demo")
        await fs.mkdir(skill, { recursive: true })
        await Bun.write(path.join(skill, "SKILL.md"), "# demo")
      },
    })

    await ensureProject(tmp.path, tmp.path)

    expect(await Bun.file(path.join(tmp.path, ".aether", "skills", "demo", "SKILL.md")).text()).toBe("# demo")
    expect(await Bun.file(path.join(tmp.path, ".opencode", "skills", "demo", "SKILL.md")).text()).toBe("# demo")
  })
})
