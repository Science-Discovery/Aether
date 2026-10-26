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
  queries: [] as boolean[],
  wait: undefined as Promise<void> | undefined,
}))
let controls: ReturnType<typeof createNative>
const [state, setState] = createStore<{
  id?: string
  path: string
  ready: boolean
  enabled?: boolean
  sessions: Record<string, { engine?: NativeEngine } | undefined>
}>({ path: "", ready: true, sessions: {} })

vi.mock("@solidjs/router", () => ({ useParams: () => state }))
vi.mock("./local", () => ({ useLocal: () => ({ native: controls }) }))
vi.mock("./language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("./sync", () => ({ useSync: () => ({ session: { get: (id: string) => state.sessions[id] } }) }))
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
    url: "http://localhost:1234",
    directory: "/project",
    client: {
      native: {
        status: async (input?: { refresh?: boolean }) => {
          mocks.calls++
          mocks.queries.push(input?.refresh ?? false)
          await mocks.wait
          if (mocks.fail) throw new Error("disconnected")
          return {
            data: {
              enabled: true,
              installed: true,
              connected: true,
              auth: mocks.auth,
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
  setState({ id: undefined, path: "", ready: true, enabled: undefined, sessions: {} })
  mocks.calls = 0
  mocks.fail = false
  mocks.auth = "chatgpt"
  mocks.queries = []
  mocks.wait = undefined
})
afterEach(() => dispose?.())

describe("native session controls", () => {
  test("prefetches once and switching engines or models does not repeat discovery", async () => {
    const native = mount()
    await vi.waitFor(() => expect(native.status()?.connected).toBe(true))
    expect(native.engine()).toBeUndefined()
    native.select("codex")
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    expect(native.selection()).toEqual({ type: "codex", model: "one", effort: "low" })
    native.setEffort("high")
    expect(native.selection()?.effort).toBe("high")
    native.setModel("two")
    expect(native.selection()).toEqual({ type: "codex", model: "two", effort: "medium" })
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
