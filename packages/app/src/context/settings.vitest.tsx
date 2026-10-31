import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AsyncStorage } from "@solid-primitives/storage"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({ storage: undefined as AsyncStorage | undefined }))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({ platform: "desktop", storage: () => state.storage! }),
}))

const disposals: (() => void)[] = []

async function mount(storage: AsyncStorage) {
  const module = await import("./settings")
  state.storage = storage
  const host = document.createElement("div")
  const ready = Promise.withResolvers<ReturnType<typeof module.useSettings>>()
  const Child = () => {
    const settings = module.useSettings()
    ready.resolve(settings)
    return <span>{String(settings.general.collapseLongUserMessages())}</span>
  }
  document.body.append(host)
  const dispose = render(
    () => (
      <module.SettingsProvider>
        <Child />
      </module.SettingsProvider>
    ),
    host,
  )
  const cleanup = () => {
    dispose()
    host.remove()
  }
  disposals.push(cleanup)
  return { host, ready: ready.promise }
}

function storage(values = new Map<string, string>()): AsyncStorage {
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value)
    },
    removeItem: async (key) => {
      values.delete(key)
    },
  }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
})

describe("long user message setting", () => {
  test("defaults to enabled independently of earlier reply folding", async () => {
    const item = await mount(storage())
    const settings = await item.ready
    expect(settings.general.collapseLongUserMessages()).toBe(true)
    settings.general.setAutoCollapse(false)
    expect(settings.general.collapseLongUserMessages()).toBe(true)
  })

  test("fills the new default when restoring older settings", async () => {
    const item = await mount(storage(new Map([["settings.v3", '{"general":{"autoCollapse":false}}']])))
    const settings = await item.ready
    expect(settings.general.collapseLongUserMessages()).toBe(true)
    expect(settings.general.autoCollapse()).toBe(false)
  })

  test("waits for persisted settings before exposing the saved disabled choice", async () => {
    const read = Promise.withResolvers<string | null>()
    const item = await mount({ ...storage(), getItem: () => read.promise })
    expect(item.host.textContent).toBe("")
    read.resolve('{"general":{"collapseLongUserMessages":false}}')
    const settings = await item.ready
    expect(settings.ready()).toBe(true)
    expect(settings.general.collapseLongUserMessages()).toBe(false)
    expect(item.host.textContent).toBe("false")
  })

  test("persists and restores explicit choices without changing reply folding", async () => {
    const values = new Map<string, string>()
    const backing = storage(values)
    const item = await mount(backing)
    const settings = await item.ready
    settings.general.setCollapseLongUserMessages(false)
    await vi.waitFor(() => {
      expect(JSON.parse(values.get("settings.v3") ?? "{}").general?.collapseLongUserMessages).toBe(false)
    })
    expect(settings.general.autoCollapse()).toBe(true)
    const restored = await (await mount(backing)).ready
    expect(restored.general.collapseLongUserMessages()).toBe(false)
    restored.general.setCollapseLongUserMessages(true)
    await vi.waitFor(() => {
      expect(JSON.parse(values.get("settings.v3") ?? "{}").general?.collapseLongUserMessages).toBe(true)
    })
  })
})
