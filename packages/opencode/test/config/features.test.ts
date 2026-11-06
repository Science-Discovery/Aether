import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { GlobalBus } from "../../src/bus/global"
import { Instance } from "../../src/project/instance"
import { ConfigReader } from "../../src/skill-evolution/config-reader"
import { features } from "../fixture/features"
import { tmpdir } from "../fixture/fixture"

async function managed(config: Config.Info) {
  const dir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
  if (!dir) throw new Error("Managed config tests require an isolated directory")
  const file = path.join(dir, "aether.json")
  const before = await Bun.file(file)
    .text()
    .catch(() => undefined)
  await Bun.write(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }))
  Config.global.reset()
  Config.state.reset()
  return {
    file,
    async [Symbol.asyncDispose]() {
      if (before === undefined) await fs.rm(file, { force: true })
      if (before !== undefined) await Bun.write(file, before)
      Config.global.reset()
      Config.state.reset()
    },
  }
}

describe("server-global feature masters", () => {
  for (const enabled of [undefined, false, true]) {
    test(`requires global explicit true (${enabled})`, async () => {
      await using global = await features({ skills: { evolution_enabled: enabled }, knowledge: { enabled } })
      expect(await Config.enabled("evolution")).toBe(enabled === true)
      expect(await Config.enabled("knowledge")).toBe(enabled === true)
      expect(await ConfigReader.isEvolutionEnabled()).toBe(enabled === true)
    })
  }

  test("project masters cannot override the server", async () => {
    await using global = await features()
    await using dir = await tmpdir({
      config: { skills: { evolution_enabled: true }, knowledge: { enabled: true } },
    })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.skills?.evolution_enabled).toBe(false)
        expect(config.knowledge?.enabled).toBe(false)
        expect(await ConfigReader.isEvolutionEnabled()).toBe(false)
        await Config.updateGlobal({ skills: { evolution_enabled: true }, knowledge: { enabled: true } })
        expect((await Config.get()).skills?.evolution_enabled).toBe(true)
        expect((await Config.get()).knowledge?.enabled).toBe(true)
        await Config.updateGlobal({ skills: { evolution_enabled: false }, knowledge: { enabled: false } })
        expect((await Config.get()).skills?.evolution_enabled).toBe(false)
        expect((await Config.get()).knowledge?.enabled).toBe(false)
      },
    })
  })

  test("global true survives a project-level false", async () => {
    await using global = await features({ skills: { evolution_enabled: true }, knowledge: { enabled: true } })
    await using dir = await tmpdir({
      config: { skills: { evolution_enabled: false }, knowledge: { enabled: false } },
    })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.skills?.evolution_enabled).toBe(true)
        expect(config.knowledge?.enabled).toBe(true)
      },
    })
  })

  test("parallel updates preserve both masters and emit only empty config events", async () => {
    await using global = await features()
    await using dir = await tmpdir()
    const state = Instance.state(() => ({}))
    const events: unknown[] = []
    const listener = (event: { directory?: string; payload: { type: string } }) => {
      if (event.payload.type === Config.Updated.type || event.payload.type === "server.instance.disposed")
        events.push(event)
    }
    GlobalBus.on("event", listener)
    try {
      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          const before = state()
          await Promise.all([
            Config.updateGlobal({ skills: { evolution_enabled: true } }),
            Config.updateGlobal({ knowledge: { enabled: true } }),
          ])
          expect(await Config.enabled("evolution")).toBe(true)
          expect(await Config.enabled("knowledge")).toBe(true)
          expect(state()).toBe(before)
          expect(events).toEqual([
            { directory: "global", payload: { type: "global.config.updated", properties: {} } },
            { directory: "global", payload: { type: "global.config.updated", properties: {} } },
          ])
          await Config.updateGlobal({ model: "test/model" })
          expect(events).toHaveLength(2)
        },
      })
    } finally {
      GlobalBus.off("event", listener)
    }
  })

  test("invalid global config fails closed without update events", async () => {
    await using global = await features()
    await Bun.write(path.join(global.path, "aether.json"), "{broken")
    Config.global.reset()
    expect(await ConfigReader.isEvolutionEnabled()).toBe(false)
    await expect(Config.enabled("knowledge")).rejects.toThrow()
    const events: unknown[] = []
    const listener = (event: { payload: { type: string } }) => {
      if (event.payload.type === Config.Updated.type) events.push(event)
    }
    GlobalBus.on("event", listener)
    try {
      await expect(Config.updateGlobal({ knowledge: { enabled: true } })).rejects.toThrow()
      expect(events).toEqual([])
    } finally {
      GlobalBus.off("event", listener)
    }
  })

  for (const enabled of [false, true]) {
    test(`managed masters override both global and project choices (${enabled})`, async () => {
      await using global = await features({ skills: { evolution_enabled: !enabled }, knowledge: { enabled: !enabled } })
      await using policy = await managed({ skills: { evolution_enabled: enabled }, knowledge: { enabled } })
      await using dir = await tmpdir({
        config: { skills: { evolution_enabled: !enabled }, knowledge: { enabled: !enabled } },
      })
      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          for (const config of [await Config.get(), await Config.getGlobal()]) {
            expect(config.skills?.evolution_enabled).toBe(enabled)
            expect(config.knowledge?.enabled).toBe(enabled)
          }
          expect(await Config.enabled("evolution")).toBe(enabled)
          expect(await Config.enabled("knowledge")).toBe(enabled)
          expect(await ConfigReader.isEvolutionEnabled()).toBe(enabled)
          await Config.updateGlobal({ knowledge: { enabled: !enabled } })
          expect((await Config.getGlobal()).knowledge?.enabled).toBe(enabled)
          expect((await Config.get()).knowledge?.enabled).toBe(enabled)
          expect(await Bun.file(path.join(global.path, "aether.json")).json()).toMatchObject({
            skills: { evolution_enabled: !enabled },
            knowledge: { enabled: !enabled },
          })
        },
      })
    })
  }

  test("managed opt-in enables an otherwise unconfigured server", async () => {
    await using global = await features({ $schema: "https://opencode.ai/config.json" })
    await using policy = await managed({ skills: { evolution_enabled: true }, knowledge: { enabled: true } })
    expect(await Config.enabled("evolution")).toBe(true)
    expect(await Config.enabled("knowledge")).toBe(true)
    expect((await Config.getGlobal()).knowledge?.enabled).toBe(true)
    expect(await Bun.file(path.join(global.path, "aether.json")).json()).toEqual({
      $schema: "https://opencode.ai/config.json",
    })
  })

  test("unrelated managed settings keep unconfigured masters off", async () => {
    await using global = await features()
    await using policy = await managed({ model: "managed/model" })
    expect(await Config.enabled("evolution")).toBe(false)
    expect(await Config.enabled("knowledge")).toBe(false)
    const config = await Config.getGlobal()
    expect(config.skills).toBeUndefined()
    expect(config.knowledge).toBeUndefined()
    expect(config.model).toBeUndefined()
  })

  test("managed masters are cached until the global configuration is reset", async () => {
    await using global = await features()
    await using policy = await managed({ knowledge: { enabled: false } })
    expect(await Config.enabled("knowledge")).toBe(false)
    await Bun.write(policy.file, JSON.stringify({ knowledge: { enabled: true } }))
    expect(await Config.enabled("knowledge")).toBe(false)
    await Config.updateGlobal({ knowledge: { enabled: false } })
    expect(await Config.enabled("knowledge")).toBe(true)
    expect((await Config.getGlobal()).knowledge?.enabled).toBe(true)
    expect(await Bun.file(path.join(global.path, "aether.json")).json()).toMatchObject({
      knowledge: { enabled: false },
    })
  })
})
