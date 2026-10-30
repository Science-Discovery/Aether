import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createComponent, createRoot, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { NativeEngine } from "@/utils/native"
import { EngineSelect, NativeModels } from "@/components/native-controls"
import { createNative } from "./native"

const mocks = vi.hoisted(() => ({
  calls: 0,
  fail: false,
  auth: "chatgpt",
  legacy: false,
  enabled: true,
  error: undefined as string | undefined,
  queries: [] as boolean[],
  wait: undefined as Promise<void> | undefined,
  auto: true,
  plan: true,
  updates: [] as { sessionID: string; engine: NativeEngine }[],
  save: undefined as Promise<void> | undefined,
  reject: false,
  ignored: false,
  sse: true,
  updated: 200,
}))
let controls: ReturnType<typeof createNative>
const [state, setState] = createStore<{
  id?: string
  path: string
  ready: boolean
  server: string
  enabled?: boolean
  sessions: Record<string, { engine?: NativeEngine; time?: { updated: number } } | undefined>
}>({ path: "", server: "http://localhost:1234", ready: true, sessions: {} })

vi.mock("@solidjs/router", () => ({ useParams: () => state }))
vi.mock("./local", () => ({ useLocal: () => ({ native: controls }) }))
vi.mock("./language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/native-history", () => ({ NativeHistoryControl: () => null }))
vi.mock("./sync", () => ({
  useSync: () => ({
    session: {
      get: (id: string) =>
        state.sessions[id] && { ...state.sessions[id], time: state.sessions[id]?.time ?? { updated: 100 } },
    },
    set: (
      _key: string,
      match: (item: { id: string }) => boolean,
      value: { engine: NativeEngine; time: { updated: number } },
    ) => {
      for (const id of Object.keys(state.sessions)) {
        if (match({ id })) setState("sessions", id, value)
      }
    },
  }),
}))
vi.mock("./global-sync", () => ({
  useGlobalSync: () => ({
    get ready() {
      return state.ready
    },
    data: {
      get config() {
        return { native: { codex: { path: state.path, enabled: state.enabled } } }
      },
    },
  }),
}))
vi.mock("./sdk", () => ({
  useSDK: () => ({
    get url() {
      return state.server
    },
    directory: "/project",
    client: {
      session: {
        update: async (input: { sessionID: string; engine: NativeEngine }) => {
          const server = state.server
          const original = { ...state.sessions[input.sessionID]?.engine }
          mocks.updates.push(input)
          await mocks.save
          if (mocks.reject) throw new Error("Save failed")
          if (mocks.ignored) return { data: { engine: original } }
          const engine = { ...original, ...input.engine }
          if (state.server === server && mocks.sse)
            setState("sessions", input.sessionID, {
              engine,
              time: { updated: mocks.updated },
            })
          return { data: { engine, time: { updated: mocks.updated } } }
        },
      },
      native: {
        status: async (input?: { refresh?: boolean }) => {
          mocks.calls++
          mocks.queries.push(input?.refresh ?? false)
          await mocks.wait
          if (mocks.fail) throw new Error("disconnected")
          return {
            data: {
              enabled: mocks.legacy ? undefined : mocks.enabled,
              installed: true,
              connected: true,
              auth: mocks.auth,
              error: mocks.error,
              permissions: { auto: mocks.auto },
              capabilities: { plan: mocks.plan, steer: true },
              models: [
                { id: "one", name: "One", default: true, efforts: ["low", "high"], effort: "low" },
                { id: "two", name: "Two", default: false, efforts: ["medium"], effort: "medium" },
              ],
            },
          }
        },
      },
    },
  }),
}))

let dispose: VoidFunction
const mount = () =>
  createRoot((cleanup) => {
    dispose = cleanup
    return createNative()
  })

beforeEach(() => {
  setState({ id: undefined, path: "", server: "http://localhost:1234", ready: true, enabled: undefined, sessions: {} })
  mocks.calls = 0
  mocks.fail = false
  mocks.auth = "chatgpt"
  mocks.legacy = false
  mocks.enabled = true
  mocks.error = undefined
  mocks.queries = []
  mocks.wait = undefined
  mocks.auto = true
  mocks.plan = true
  mocks.updates = []
  mocks.save = undefined
  mocks.reject = false
  mocks.ignored = false
  mocks.sse = true
  mocks.updated = 200
})
afterEach(() => {
  dispose?.()
  vi.useRealTimers()
})

describe("native session controls", () => {
  test("defaults to execution and persists native plan mode independently of permissions and model drafts", async () => {
    const native = mount()
    native.select("codex")
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    expect(native.mode()).toBe("default")
    await native.setMode("plan")
    native.setModel("two")
    await native.setPermission("user")
    expect(native.selection()).toMatchObject({ mode: "plan", model: "two", permission: "user" })
    expect(mocks.updates).toEqual([])
    setState({ id: "saved", sessions: { saved: { engine: { type: "codex", model: "one", permission: "auto" } } } })
    mocks.sse = false
    native.setModel("two")
    await native.setMode("plan")
    expect(mocks.updates).toEqual([{ sessionID: "saved", engine: { type: "codex", mode: "plan" } }])
    expect(native.selection()).toMatchObject({ model: "two", mode: "plan", permission: "auto" })
    setState("sessions", "saved", "engine", "mode", "default")
    expect(native.selection()).toMatchObject({ model: "two", mode: "default", permission: "auto" })
  })

  test("keeps the saved mode when an older server ignores a mode update", async () => {
    setState({ id: "old", sessions: { old: { engine: { type: "codex", model: "one" } } } })
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    mocks.ignored = true
    await native.setMode("plan")
    expect(native.mode()).toBe("default")
    expect(native.permissionError()).toContain("did not confirm")
  })

  test("new drafts use automatic approval while legacy sessions retain user approval across model changes", async () => {
    const native = mount()
    native.select("codex")
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    expect(native.permission()).toBe("auto")
    await native.setPermission("full")
    native.setEffort("high")
    expect(native.selection()).toMatchObject({ permission: "full", effort: "high" })
    native.setModel("two")
    expect(native.selection()).toMatchObject({ permission: "full", model: "two" })
    expect(mocks.updates).toEqual([])
    setState({ id: "older", sessions: { older: { engine: { type: "codex", model: "one" } } } })
    expect(native.permission()).toBe("user")
    native.setModel("two")
    expect(native.selection()).toMatchObject({ permission: "user", model: "two" })
  })

  test("saves permissions for the original session without overwriting another session or a draft", async () => {
    setState({
      id: "source",
      sessions: {
        source: { engine: { type: "codex", model: "one" } },
        target: { engine: { type: "codex", model: "two", permission: "user" } },
      },
    })
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    native.setEffort("high")
    const pending = Promise.withResolvers<void>()
    mocks.save = pending.promise
    const saving = native.setPermission("full")
    expect(native.saving()).toBe(true)
    expect(native.selection()).toBeUndefined()
    expect(native.permission()).toBe("user")
    setState("id", "target")
    expect(native.permission()).toBe("user")
    expect(native.saving()).toBe(false)
    setState("id", undefined)
    native.select("codex")
    expect(native.permission()).toBe("auto")
    pending.resolve()
    await saving
    expect(native.permission()).toBe("auto")
    setState("id", "target")
    expect(native.permission()).toBe("user")
    setState("id", "source")
    expect(native.selection()).toMatchObject({ permission: "full", effort: "high" })
    expect(mocks.updates).toEqual([{ sessionID: "source", engine: { type: "codex", permission: "full" } }])
    expect(state.sessions.source?.engine?.permission).toBe("full")
  })

  test("a failed save keeps the previous permission and can be retried", async () => {
    setState({ id: "retry", sessions: { retry: { engine: { type: "codex", model: "one", permission: "user" } } } })
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    mocks.reject = true
    await native.setPermission("full")
    expect(native.permission()).toBe("user")
    expect(native.permissionError()).toBe("Save failed")
    expect(native.saving()).toBe(false)
    mocks.reject = false
    await native.setPermission("auto")
    expect(native.permission()).toBe("auto")
    expect(native.permissionError()).toBeUndefined()
  })

  test("a response from the previous server cannot change a same-id session on the current server", async () => {
    setState({ id: "cloned", sessions: { cloned: { engine: { type: "codex", model: "one", permission: "user" } } } })
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    const pending = Promise.withResolvers<void>()
    mocks.save = pending.promise
    const saving = native.setPermission("full")
    setState("server", "http://another-server:1234")
    expect(native.saving()).toBe(false)
    expect(native.permission()).toBe("user")
    native.setModel("two")
    pending.resolve()
    await saving
    expect(native.permission()).toBe("user")
    expect(native.model()?.id).toBe("two")
    setState("server", "http://localhost:1234")
    // Until this server's saved metadata arrives, an old request response must
    // not become another authority for persisted permissions.
    expect(native.permission()).toBe("user")
    setState("sessions", "cloned", "engine", "permission", "full")
    expect(native.permission()).toBe("full")
  })

  test("saved permission updates override model drafts without replacing their unsent model or effort", async () => {
    setState({ id: "remote", sessions: { remote: { engine: { type: "codex", model: "one", permission: "auto" } } } })
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    native.setModel("two")
    native.setEffort("medium")
    setState("sessions", "remote", "engine", "permission", "full")
    expect(native.permission()).toBe("full")
    expect(native.selection()).toMatchObject({ model: "two", effort: "medium", permission: "full" })
    setState("sessions", "remote", "engine", "permission", undefined)
    expect(native.permission()).toBe("user")
    expect(native.selection()).toMatchObject({ model: "two", effort: "medium", permission: "user" })
  })

  test("a confirmed save updates session metadata when SSE is absent", async () => {
    setState({
      id: "delayed",
      sessions: { delayed: { engine: { type: "codex", model: "one", permission: "user" }, time: { updated: 100 } } },
    })
    mocks.sse = false
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    native.setModel("two")
    await native.setPermission("full")
    expect(native.permission()).toBe("full")
    expect(state.sessions.delayed?.engine).toMatchObject({ model: "one", permission: "full" })
    expect(native.model()?.id).toBe("two")
    expect(state.sessions.delayed?.time?.updated).toBe(200)
  })

  test("an old save response cannot overwrite a newer permission event", async () => {
    setState({
      id: "newer",
      sessions: { newer: { engine: { type: "codex", model: "one", permission: "auto" }, time: { updated: 100 } } },
    })
    mocks.sse = false
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    const pending = Promise.withResolvers<void>()
    mocks.save = pending.promise
    const saving = native.setPermission("full")
    setState("sessions", "newer", {
      engine: { type: "codex", model: "two", permission: "user" },
      time: { updated: 300 },
    })
    pending.resolve()
    await saving
    expect(native.permission()).toBe("user")
    expect(native.model()?.id).toBe("two")
    expect(state.sessions.newer?.time?.updated).toBe(300)
  })

  test("an older server ignoring the permission field cannot appear to have saved full access", async () => {
    setState({ id: "unsupported", sessions: { unsupported: { engine: { type: "codex", model: "one" } } } })
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    mocks.ignored = true
    await native.setPermission("full")
    expect(native.permission()).toBe("user")
    expect(native.permissionError()).toContain("did not confirm")
    expect(native.selection()?.permission).toBe("user")
  })

  test("permission controls expose three modes and show unverified automatic approval without a silent fallback", async () => {
    mocks.auto = false
    const host = document.createElement("div")
    document.body.append(host)
    const cleanup = render(() => {
      controls = createNative()
      controls.select("codex")
      return createComponent(NativeModels, {})
    }, host)
    dispose = () => {
      cleanup()
      host.remove()
    }
    await vi.waitFor(() => expect(controls.ready()).toBe(true))
    expect(controls.permission()).toBe("auto")
    expect(host.textContent).toContain("native.permission.unavailable")
    const trigger = host.querySelector("[data-action=prompt-native-permission]")!
    expect(trigger.textContent).toBe("native.permission.auto")
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Promise.resolve()
    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")]
    for (const mode of ["user", "auto", "full"]) {
      expect(options.some((option) => option.textContent?.startsWith(`native.permission.${mode}`))).toBe(true)
    }
    options
      .find((option) => option.textContent?.startsWith("native.permission.user"))!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    expect(controls.permission()).toBe("user")
    expect(host.textContent).not.toContain("native.permission.unavailable")
    expect(mocks.updates).toEqual([])
  })

  test("accepts legacy discovery without enabled but honors an explicit disabled response", async () => {
    mocks.legacy = true
    const native = mount()
    native.select("codex")
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    expect(native.status()?.enabled).toBe(true)
    expect(native.selection()?.model).toBe("one")
    mocks.legacy = false
    mocks.enabled = false
    await native.refresh()
    expect(native.ready()).toBe(false)
    expect(native.status()?.enabled).toBe(false)
  })

  test("keeps a usable selection after TTL expiry and a transient refresh failure", async () => {
    vi.useFakeTimers()
    const native = mount()
    native.select("codex")
    await vi.advanceTimersByTimeAsync(0)
    expect(native.ready()).toBe(true)
    const pending = Promise.withResolvers<void>()
    mocks.wait = pending.promise
    mocks.fail = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.calls).toBe(2)
    expect(native.loading()).toBe(true)
    expect(native.ready()).toBe(true)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(native.loading()).toBe(false)
    expect(native.error()).toBeInstanceOf(Error)
    expect(native.ready()).toBe(true)
    expect(native.selection()).toEqual({ type: "codex", model: "one", effort: "low", permission: "auto" })
    mocks.fail = false
    mocks.auth = "missing"
    await native.refresh()
    expect(native.ready()).toBe(false)
    mocks.auth = "chatgpt"
    mocks.error = "Account discovery failed"
    await native.refresh()
    expect(native.ready()).toBe(false)
    mocks.error = undefined
    await native.refresh()
    expect(native.ready()).toBe(true)
    native.setModel("removed")
    expect(native.ready()).toBe(false)
  })

  test("prefetches once and switching engines or models does not repeat discovery", async () => {
    const native = mount()
    await vi.waitFor(() => expect(native.status()?.connected).toBe(true))
    expect(native.engine()).toBeUndefined()
    native.select("codex")
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    expect(native.selection()).toEqual({ type: "codex", model: "one", effort: "low", permission: "auto" })
    native.setEffort("high")
    expect(native.selection()?.effort).toBe("high")
    native.setModel("two")
    expect(native.selection()).toEqual({ type: "codex", model: "two", effort: "medium", permission: "auto" })
    expect(mocks.calls).toBe(1)
    native.select("aether")
    expect(native.engine()).toBeUndefined()
    native.select("codex")
    expect(native.engine()?.type).toBe("codex")
    expect(native.ready()).toBe(true)
    expect(mocks.calls).toBe(1)
    setState("path", "/other/codex")
    await vi.waitFor(() => expect(mocks.calls).toBe(2))
  })

  test("waits for session metadata and locks the engine for both existing session kinds", async () => {
    setState("id", "existing")
    const native = mount()
    expect(native.known()).toBe(false)
    native.select("codex")
    expect(native.engine()).toBeUndefined()
    setState("sessions", "existing", { engine: { type: "codex", model: "two", effort: "medium" } })
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    expect(native.selection()?.model).toBe("two")
    native.select("aether")
    expect(native.engine()?.type).toBe("codex")
    setState("sessions", "legacy", {})
    setState("id", "legacy")
    expect(native.known()).toBe(true)
    native.select("codex")
    expect(native.engine()).toBeUndefined()
  })

  test("preserves a saved effort when model controls mount before discovery finishes", async () => {
    const pending = Promise.withResolvers<void>()
    mocks.wait = pending.promise
    setState({ id: "existing", sessions: { existing: { engine: { type: "codex", model: "one", effort: "high" } } } })
    const host = document.createElement("div")
    document.body.append(host)
    const cleanup = render(() => {
      controls = createNative()
      return createComponent(NativeModels, {})
    }, host)
    dispose = () => {
      cleanup()
      host.remove()
    }
    expect(host.querySelector("[data-action=prompt-model-variant]")).toBeNull()
    pending.resolve()
    await vi.waitFor(() => expect(controls.ready()).toBe(true))
    expect(controls.selection()?.effort).toBe("high")
    expect(host.querySelector("[data-action=prompt-model-variant]")?.textContent).toBe("high")
    controls.setModel("two")
    expect(controls.selection()?.effort).toBe("medium")
  })

  test("can switch a new conversation away from and back to Codex with a cached catalog", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const cleanup = render(() => {
      controls = createNative()
      return [
        createComponent(EngineSelect, {}),
        createComponent(Show, {
          get when() {
            return !!controls.engine()
          },
          get children() {
            return createComponent(NativeModels, {})
          },
        }),
      ]
    }, host)
    dispose = () => {
      cleanup()
      host.remove()
    }
    await vi.waitFor(() => expect(controls.status()?.connected).toBe(true))
    const choose = async (label: string) => {
      host
        .querySelector("[data-action=prompt-engine]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
      await Promise.resolve()
      const item = [...document.querySelectorAll<HTMLElement>("[role=option]")].find(
        (item) => item.textContent === label,
      )
      expect(item).toBeDefined()
      item!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
      expect(host.querySelector("[data-action=prompt-engine]")?.textContent).toBe(label)
    }
    await choose("Codex")
    expect(controls.ready()).toBe(true)
    const pending = Promise.withResolvers<void>()
    mocks.wait = pending.promise
    const refresh = controls.refresh()
    await choose("Aether")
    expect(controls.engine()).toBeUndefined()
    await choose("Codex")
    expect(controls.engine()?.type).toBe("codex")
    expect(controls.loading()).toBe(true)
    pending.resolve()
    await refresh
    expect(controls.ready()).toBe(true)
    expect(mocks.calls).toBe(2)
  })

  test("keeps model choices isolated between sessions", async () => {
    setState("sessions", {
      a: { engine: { type: "codex", model: "one" } },
      b: { engine: { type: "codex", model: "one" } },
    })
    setState("id", "a")
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    native.setModel("two")
    setState("id", "b")
    expect(native.model()?.id).toBe("one")
    setState("id", "a")
    expect(native.model()?.id).toBe("two")
    expect(mocks.calls).toBe(1)
  })

  test("requires an account, retains failed discovery, and can retry", async () => {
    mocks.fail = true
    const native = mount()
    native.select("codex")
    await vi.waitFor(() => expect(native.error()).toBeInstanceOf(Error))
    expect(native.ready()).toBe(false)
    mocks.fail = false
    mocks.auth = "missing"
    await native.refresh()
    expect(native.ready()).toBe(false)
    mocks.auth = "chatgpt"
    await native.refresh()
    expect(native.ready()).toBe(true)
    expect(mocks.queries).toEqual([false, true, true])
    native.setModel("removed")
    expect(native.ready()).toBe(false)
  })

  test("waits for global configuration and makes no requests while disabled", async () => {
    setState({ ready: false, enabled: undefined })
    const native = mount()
    expect(mocks.calls).toBe(0)
    setState({ enabled: false, ready: true })
    await Promise.resolve()
    native.select("codex")
    await native.refresh()
    expect(native.engine()).toBeUndefined()
    expect(native.ready()).toBe(false)
    expect(mocks.calls).toBe(0)
    setState("enabled", true)
    await vi.waitFor(() => expect(native.status()?.connected).toBe(true))
    expect(mocks.calls).toBe(1)
    native.select("codex")
    expect(native.ready()).toBe(true)
  })

  test("disabling preserves historical engine identity while preventing a new selection", async () => {
    setState({ id: "existing", sessions: { existing: { engine: { type: "codex", model: "one" } } } })
    const native = mount()
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    setState("enabled", false)
    expect(native.engine()?.type).toBe("codex")
    expect(native.locked()).toBe(true)
    expect(native.ready()).toBe(false)
    expect(native.selection()).toBeUndefined()
    expect(native.status()).toBeUndefined()
    expect(mocks.calls).toBe(1)
  })
})
