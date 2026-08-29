import { beforeEach, describe, expect, test, vi } from "vitest"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { Platform } from "@/context/platform"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"

const state = vi.hoisted(() => ({
  storage: undefined as AsyncStorage | undefined,
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "desktop",
    storage: () => state.storage!,
  }),
}))

import { persisted, removePersisted } from "./persist"

function clean(value: unknown) {
  if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) {
    return { entries: [] }
  }
  return {
    entries: value.entries.flatMap((entry): { content: string }[] => {
      if (!entry || typeof entry !== "object" || !("content" in entry)) return []
      if (typeof entry.content !== "string") return []
      return [{ content: entry.content }]
    }),
  }
}

function mount(storage: AsyncStorage, key: string) {
  state.storage = storage
  return createRoot((dispose) => {
    const [store, setStore] = createStore({ entries: [] as { content: string }[] })
    const [value, set, , ready] = persisted({ key, migrate: clean, sanitize: clean }, [store, setStore])
    return { value, set, ready, dispose }
  })
}

function desktop(storage: AsyncStorage): Platform {
  return {
    platform: "desktop",
    storage: () => storage,
    openLink: () => undefined,
    restart: async () => undefined,
    back: () => undefined,
    forward: () => undefined,
    notify: async () => undefined,
  }
}

beforeEach(() => {
  state.storage = undefined
})

describe("persist async storage", () => {
  test("migration does not overwrite a newer value while reading", async () => {
    const read = Promise.withResolvers<string | null>()
    const saved = Promise.withResolvers<void>()
    const values = new Map<string, string>()
    const storage: AsyncStorage = {
      getItem: () => read.promise,
      setItem: async (key, value) => {
        values.set(key, value)
        if (value.includes("new")) saved.resolve()
      },
      removeItem: async (key) => {
        values.delete(key)
      },
    }
    const item = mount(storage, "async-read-race")

    item.set("entries", [{ content: "new" }])
    read.resolve('{"entries":[{"content":"old","dataUrl":"data:large"}]}')
    await Promise.all([item.ready.promise, saved.promise])

    expect(item.value.entries).toEqual([{ content: "new" }])
    expect(JSON.parse(values.get("async-read-race")!)).toEqual({ entries: [{ content: "new" }] })
    item.dispose()
  })

  test("migration preserves a newer value when its write is already pending", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const saved = Promise.withResolvers<void>()
    const calls = { value: 0 }
    const values = new Map<string, string>()
    const storage: AsyncStorage = {
      getItem: async () => '{"entries":[{"content":"old","dataUrl":"data:large"}]}',
      setItem: async (key, value) => {
        calls.value += 1
        if (calls.value === 1) {
          started.resolve()
          await release.promise
        }
        values.set(key, value)
        if (value.includes("new")) saved.resolve()
      },
      removeItem: async (key) => {
        values.delete(key)
      },
    }
    const item = mount(storage, "async-write-race")

    await started.promise
    item.set("entries", [{ content: "new" }])
    release.resolve()
    await Promise.all([item.ready.promise, saved.promise])

    expect(item.value.entries).toEqual([{ content: "new" }])
    expect(JSON.parse(values.get("async-write-race")!)).toEqual({ entries: [{ content: "new" }] })
    item.dispose()
  })

  test("an unmounted instance does not overwrite a newer instance", async () => {
    const read = Promise.withResolvers<string | null>()
    const saved = Promise.withResolvers<void>()
    const values = new Map<string, string>()
    const calls = { value: 0 }
    const storage: AsyncStorage = {
      getItem: async () => {
        calls.value += 1
        if (calls.value === 1) return read.promise
        return values.get("async-remount-race") ?? null
      },
      setItem: async (key, value) => {
        values.set(key, value)
        if (value.includes("new")) saved.resolve()
      },
      removeItem: async (key) => {
        values.delete(key)
      },
    }
    const old = mount(storage, "async-remount-race")
    old.dispose()
    const item = mount(storage, "async-remount-race")

    item.set("entries", [{ content: "new" }])
    read.resolve('{"entries":[{"content":"old","dataUrl":"data:large"}]}')
    await Promise.all([old.ready.promise, item.ready.promise, saved.promise])

    expect(item.value.entries).toEqual([{ content: "new" }])
    expect(JSON.parse(values.get("async-remount-race")!)).toEqual({ entries: [{ content: "new" }] })
    item.dispose()
  })

  test("remove does not let a pending migration restore the value", async () => {
    const key = "async-remove-race"
    const raw = '{"entries":[{"content":"old","dataUrl":"data:large"}]}'
    const read = Promise.withResolvers<string | null>()
    const values = new Map([[key, raw]])
    const saved: string[] = []
    const storage: AsyncStorage = {
      getItem: () => read.promise,
      setItem: async (key, value) => {
        saved.push(value)
        values.set(key, value)
      },
      removeItem: async (key) => {
        values.delete(key)
      },
    }
    const item = mount(storage, key)

    await removePersisted({ key }, desktop(storage))
    read.resolve(raw)
    await item.ready.promise

    expect(values.has(key)).toBe(false)
    expect(saved).toEqual([])
    item.dispose()
  })
})
