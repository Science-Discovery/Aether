import { afterEach, describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderEvent } from "../../src/provider/event"
import { ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

const id = ProviderID.anthropic

function connected(dir: string) {
  return Instance.provide({ directory: dir, fn: () => Provider.connected() })
}

function provider(dir: string, value = id) {
  return Instance.provide({ directory: dir, fn: () => Provider.getProvider(value) })
}

describe.serial("provider state updates", () => {
  afterEach(async () => {
    await Auth.remove(id)
    await Instance.disposeAll()
  })

  test("auth changes invalidate every instance and only publish visibility changes", async () => {
    await Auth.remove(id)
    await using one = await tmpdir()
    await using two = await tmpdir()
    const events: unknown[] = []
    const listener = (event: { payload: { type: string } }) => {
      if (event.payload.type === "provider.updated") events.push(event)
    }
    GlobalBus.on("event", listener)

    try {
      expect(await connected(one.path)).not.toContain(id)
      expect(await connected(two.path)).not.toContain(id)

      await Auth.set(id, { type: "api", key: "old" })
      expect(events).toHaveLength(1)
      expect(await connected(one.path)).toContain(id)
      expect(await connected(two.path)).toContain(id)
      expect((await provider(one.path))?.key).toBe("old")

      await Auth.set(id, { type: "api", key: "new" })
      expect(events).toHaveLength(1)
      expect((await provider(one.path))?.key).toBe("new")
      expect((await provider(two.path))?.key).toBe("new")

      await Auth.set(id, {
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      })
      expect(events).toHaveLength(2)

      await Auth.set(id, {
        type: "oauth",
        access: "refreshed",
        refresh: "refresh",
        expires: Date.now() + 120_000,
      })
      expect(events).toHaveLength(2)

      await Auth.remove(id)
      expect(events).toHaveLength(3)
      expect(await connected(one.path)).not.toContain(id)
      expect(await connected(two.path)).not.toContain(id)

      await Auth.remove(id)
      expect(events).toHaveLength(3)
    } finally {
      GlobalBus.off("event", listener)
    }
  })

  test("global provider config changes invalidate state without disposing instances", async () => {
    await Auth.remove(id)
    await Auth.set(id, { type: "api", key: "test" })
    await using cfg = await tmpdir()
    await using one = await tmpdir()
    await using two = await tmpdir()
    const prev = Global.Path.config
    const events: unknown[] = []
    const listener = (event: { payload: { type: string } }) => {
      if (event.payload.type === "provider.updated") events.push(event)
    }
    ;(Global.Path as { config: string }).config = cfg.path
    Config.global.reset()
    GlobalBus.on("event", listener)

    try {
      expect(await connected(one.path)).toContain(id)
      expect(await connected(two.path)).toContain(id)

      await Config.updateGlobal({ disabled_providers: [id] })
      expect(await connected(one.path)).not.toContain(id)
      expect(await connected(two.path)).not.toContain(id)

      await Config.updateGlobal({ disabled_providers: [] })
      expect(await connected(one.path)).toContain(id)
      expect(await connected(two.path)).toContain(id)

      await Config.updateGlobal({ enabled_providers: ["openai"] })
      expect(await connected(one.path)).not.toContain(id)

      await Config.updateGlobal({ enabled_providers: [id] })
      expect(await connected(one.path)).toContain(id)

      const model = Object.keys((await provider(one.path))!.models)[0]
      await Config.updateGlobal({ disabled_models: [`${id}/${model}`] })
      expect((await provider(one.path))!.models[model].disabled).toBe(true)
      expect((await provider(two.path))!.models[model].disabled).toBe(true)

      await Config.updateGlobal({
        enabled_providers: [id, "regression"],
        provider: {
          regression: {
            name: "Regression",
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.example.com/v1",
            models: {
              model: {
                name: "Model",
                tool_call: true,
                limit: { context: 4_000, output: 1_000 },
              },
            },
            options: { apiKey: "test" },
          },
        },
      })
      const custom = ProviderID.make("regression")
      expect(await connected(one.path)).toContain(custom)
      expect(await connected(two.path)).toContain(custom)

      await Config.updateGlobal({ provider_remove: [custom] })
      expect(await connected(one.path)).not.toContain(custom)
      expect(await connected(two.path)).not.toContain(custom)
      expect(Instance.has(one.path)).toBe(true)
      expect(Instance.has(two.path)).toBe(true)
      expect(events).toHaveLength(7)
    } finally {
      GlobalBus.off("event", listener)
      ;(Global.Path as { config: string }).config = prev
      Config.global.reset()
      Provider.reset()
    }
  })

  test("event listener failures do not fail persisted auth changes", async () => {
    const local = ProviderEvent.onUpdated(() => {
      throw new Error("local failure")
    })
    const remote = () => {
      throw new Error("bus failure")
    }
    GlobalBus.on("event", remote)

    try {
      await Auth.set(id, { type: "api", key: "persisted" })
      expect(await Auth.get(id)).toEqual({ type: "api", key: "persisted" })
    } finally {
      local()
      GlobalBus.off("event", remote)
    }
  })
})
