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

async function touch(file: string, time: number) {
  await fs.utimes(file, time / 1000, time / 1000)
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

  test("does not copy legacy database sidecars when the target database already exists", async () => {
    await fs.mkdir(Persist.legacy.data, { recursive: true })
    await fs.mkdir(Persist.current.data, { recursive: true })
    await Bun.write(path.join(Persist.legacy.data, "aether-local.db"), "legacy-db")
    await Bun.write(path.join(Persist.legacy.data, "aether-local.db-wal"), "legacy-wal")
    await Bun.write(path.join(Persist.legacy.data, "aether-local.db-shm"), "legacy-shm")
    await Bun.write(path.join(Persist.current.data, "aether-local.db"), "current-db")

    await ensureUser()

    expect(await Bun.file(path.join(Persist.current.data, "aether-local.db")).text()).toBe("current-db")
    expect(await Bun.file(path.join(Persist.current.data, "aether-local.db-wal")).exists()).toBeFalse()
    expect(await Bun.file(path.join(Persist.current.data, "aether-local.db-shm")).exists()).toBeFalse()
  })

  test("copies only aether databases when legacy aether files already exist", async () => {
    await fs.mkdir(Persist.legacy.data, { recursive: true })
    await Bun.write(path.join(Persist.legacy.data, "aether-local.db"), "new-db")
    await Bun.write(path.join(Persist.legacy.data, "aether-local.db-wal"), "new-wal")
    await Bun.write(path.join(Persist.legacy.data, "opencode-prod.db"), "old-db")

    await ensureUser()

    expect(await Bun.file(path.join(Persist.current.data, "aether-local.db")).text()).toBe("new-db")
    expect(await Bun.file(path.join(Persist.current.data, "aether-local.db-wal")).text()).toBe("new-wal")
    expect(await Bun.file(path.join(Persist.current.data, "aether-prod.db")).exists()).toBeFalse()
    expect(await Bun.file(path.join(Persist.current.data, "opencode-prod.db")).exists()).toBeFalse()
    expect(await Bun.file(path.join(Persist.legacy.data, "aether-local.db")).text()).toBe("new-db")
    expect(await Bun.file(path.join(Persist.legacy.data, "opencode-prod.db")).text()).toBe("old-db")
  })

  test("seeds aether prod from the latest legacy opencode database without copying opencode names", async () => {
    await fs.mkdir(Persist.legacy.data, { recursive: true })
    const old = path.join(Persist.legacy.data, "opencode-dev.db")
    const next = path.join(Persist.legacy.data, "opencode-beta.db")
    await Bun.write(old, "old-db")
    await Bun.write(next, "next-db")
    await Bun.write(`${next}-wal`, "next-wal")
    await Bun.write(`${next}-shm`, "next-shm")
    await touch(old, 1000)
    await touch(next, 2000)

    await ensureUser()

    expect(await Bun.file(path.join(Persist.current.data, "aether-prod.db")).text()).toBe("next-db")
    expect(await Bun.file(path.join(Persist.current.data, "aether-prod.db-wal")).text()).toBe("next-wal")
    expect(await Bun.file(path.join(Persist.current.data, "aether-prod.db-shm")).text()).toBe("next-shm")
    expect(await Bun.file(path.join(Persist.current.data, "opencode-dev.db")).exists()).toBeFalse()
    expect(await Bun.file(path.join(Persist.current.data, "opencode-beta.db")).exists()).toBeFalse()
    expect(await Bun.file(old).text()).toBe("old-db")
    expect(await Bun.file(next).text()).toBe("next-db")
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
