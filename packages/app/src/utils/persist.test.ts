import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"

type PersistTestingType = typeof import("./persist").PersistTesting
type PersistType = typeof import("./persist").Persist

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    if (key.startsWith("opencode.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("opencode.throw")) throw new Error("storage set failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("opencode.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

let persistTesting: PersistTestingType
let persisted: typeof import("./persist").persisted
let persist: PersistType
let setPersistScope: typeof import("./persist").setPersistScope

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./persist")
  persistTesting = mod.PersistTesting
  persisted = mod.persisted
  persist = mod.Persist
  setPersistScope = mod.setPersistScope
})

beforeEach(() => {
  setPersistScope(undefined)
  storage.clear()
  storage.events.length = 0
  storage.calls.get = 0
  storage.calls.set = 0
  storage.calls.remove = 0
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
})

describe("persist localStorage resilience", () => {
  test("does not cache values as persisted when quota write and eviction fail", () => {
    const storageApi = persistTesting.localStorageWithPrefix("opencode.quota.scope")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("opencode.quota.scope:value")).toBeNull()
    expect(storageApi.getItem("value")).toBeNull()
  })

  test("disables only the failing scope when storage throws", () => {
    const bad = persistTesting.localStorageWithPrefix("opencode.throw.scope")
    bad.setItem("value", '{"value":1}')

    const before = storage.calls.set
    bad.setItem("value", '{"value":2}')
    expect(storage.calls.set).toBe(before)
    expect(bad.getItem("value")).toBeNull()

    const healthy = persistTesting.localStorageWithPrefix("opencode.safe.scope")
    healthy.setItem("value", '{"value":3}')
    expect(storage.getItem("opencode.safe.scope:value")).toBe('{"value":3}')
  })

  test("failing fallback scope does not poison direct storage scope", () => {
    const broken = persistTesting.localStorageWithPrefix("opencode.throw.scope2")
    broken.setItem("value", '{"value":1}')

    const direct = persistTesting.localStorageDirect()
    direct.setItem("direct-value", '{"value":5}')

    expect(storage.getItem("direct-value")).toBe('{"value":5}')
  })

  test("normalizer rejects malformed JSON payloads", () => {
    const result = persistTesting.normalize({ value: "ok" }, '{"value":"\\x"}')
    expect(result).toBeUndefined()
  })

  test("sanitizes before serialization without mutating the live store", () => {
    const [store, setStore] = createStore({
      prompt: [] as Array<{ type: string; content?: string; dataUrl?: string }>,
    })
    const [state, setState] = persisted(
      {
        key: "sanitize-before-serialize",
        sanitize: (value) => {
          if (!value || typeof value !== "object" || !("prompt" in value) || !Array.isArray(value.prompt)) return value
          return {
            ...value,
            prompt: value.prompt.filter((part) => !(part && typeof part === "object" && "dataUrl" in part)),
          }
        },
      },
      [store, setStore],
    )

    setState("prompt", [
      { type: "image", dataUrl: "data:large" },
      { type: "text", content: "ok" },
    ])

    expect(state.prompt).toHaveLength(2)
    expect(state.prompt[0]).toMatchObject({ type: "image", dataUrl: "data:large" })
    expect(storage.getItem("sanitize-before-serialize")).toBe('{"prompt":[{"type":"text","content":"ok"}]}')
  })

  test("workspace storage sanitizes Windows filename characters", () => {
    const result = persistTesting.workspaceStorage("C:\\Users\\foo")

    expect(result).toStartWith("opencode.workspace.")
    expect(result.endsWith(".dat")).toBeTrue()
    expect(/[:\\/]/.test(result)).toBeFalse()
  })
})

describe("server scope", () => {
  test("unscoped targets keep their original keys", () => {
    setPersistScope(undefined)

    expect(persist.serverGlobal("layout.page").key).toBe("layout.page")
    expect(persist.workspace("/repo", "terminal").storage).toBe(persistTesting.workspaceStorage("/repo"))
    expect(persist.session("/repo", "ses_1", "terminal").storage).toBe(persistTesting.workspaceStorage("/repo"))
  })

  test("scoped global keys gain a server suffix", () => {
    setPersistScope("abc")

    expect(persist.serverGlobal("layout.page").key).toBe("layout.page\nserver:abc")
    expect(persist.global("layout.page").key).toBe("layout.page")
  })

  test("scoped workspace and session storage are isolated per server", () => {
    setPersistScope("abc")

    const scoped = persistTesting.workspaceStorage("/repo\nserver:abc")
    expect(persist.workspace("/repo", "terminal").storage).toBe(scoped)
    expect(persist.session("/repo", "ses_1", "terminal").storage).toBe(scoped)
    expect(scoped).not.toBe(persistTesting.workspaceStorage("/repo"))
  })

  test("scoped stores skip legacy migration", () => {
    setPersistScope("abc")

    expect(persist.serverGlobal("permission", ["permission.v3"]).legacy).toBeUndefined()
    expect(persist.workspace("/repo", "terminal", ["/repo/terminal.v1"]).legacy).toBeUndefined()
    expect(persist.session("/repo", "ses_1", "comments", ["/repo/comments.v1"]).legacy).toBeUndefined()
  })

  test("unscoped stores keep legacy keys", () => {
    expect(persist.serverGlobal("permission", ["permission.v3"]).legacy).toEqual(["permission.v3"])
    expect(persist.workspace("/repo", "terminal", ["/repo/terminal.v1"]).legacy).toEqual(["/repo/terminal.v1"])
  })

  test("persisted reads and writes through the scoped key", () => {
    setPersistScope("abc")
    const [store, setStore] = createStore({ value: 0 })
    const [state, setState] = persisted(persist.serverGlobal("scope-roundtrip"), [store, setStore])

    setState("value", 7)

    expect(state.value).toBe(7)
    expect(storage.getItem("opencode.global.dat:scope-roundtrip\nserver:abc")).toBe('{"value":7}')
    expect(storage.getItem("opencode.global.dat:scope-roundtrip")).toBeNull()
  })
})
