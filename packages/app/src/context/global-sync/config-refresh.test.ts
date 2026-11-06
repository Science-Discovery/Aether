import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { createConfigRefresh } from "./config-refresh"

const deferred = () => {
  let resolve!: (value: Config) => void
  const promise = new Promise<Config>((done) => (resolve = done))
  return { promise, resolve }
}

describe("feature configuration refresh", () => {
  test("applies only the newest response", async () => {
    const first = deferred()
    const second = deferred()
    const applied: Config[] = []
    let calls = 0
    const refresh = createConfigRefresh({
      active: () => true,
      load: () => (++calls === 1 ? first.promise : second.promise),
      apply: (config) => applied.push(config),
    })
    const old = refresh()
    const next = refresh()
    second.resolve({ skills: { evolution_enabled: false } })
    await next
    first.resolve({ skills: { evolution_enabled: true } })
    await old
    expect(applied).toEqual([{ skills: { evolution_enabled: false } }])
  })

  test("does not apply results after its server owner is disposed", async () => {
    const request = deferred()
    let active = true
    const applied: Config[] = []
    const refresh = createConfigRefresh({
      active: () => active,
      load: () => request.promise,
      apply: (config) => applied.push(config),
    })
    const pending = refresh()
    active = false
    request.resolve({ skills: { evolution_enabled: true } })
    await pending
    expect(applied).toEqual([])
  })

  test("failed reads preserve the current configuration", async () => {
    const applied: Config[] = []
    const refresh = createConfigRefresh({
      active: () => true,
      load: async () => {
        throw new Error("offline")
      },
      apply: (config) => applied.push(config),
    })
    await expect(refresh()).rejects.toThrow("offline")
    expect(applied).toEqual([])
  })
})
