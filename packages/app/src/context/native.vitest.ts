import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeEngine } from "@/utils/native"
import { createNative } from "./native"

const mocks = vi.hoisted(() => ({ calls: 0, fail: false, auth: "chatgpt" }))
const [state, setState] = createStore<{
  id?: string
  path: string
  sessions: Record<string, { engine?: NativeEngine } | undefined>
}>({ path: "", sessions: {} })

vi.mock("@solidjs/router", () => ({ useParams: () => state }))
vi.mock("./sync", () => ({ useSync: () => ({ session: { get: (id: string) => state.sessions[id] } }) }))
vi.mock("./global-sync", () => ({
  useGlobalSync: () => ({
    data: {
      get config() {
        return { native: { codex: { path: state.path } } }
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
        status: async () => {
          mocks.calls++
          if (mocks.fail) throw new Error("disconnected")
          return {
            data: {
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
  setState({ id: undefined, path: "", sessions: {} })
  mocks.calls = 0
  mocks.fail = false
  mocks.auth = "chatgpt"
})
afterEach(() => dispose?.())

describe("native session controls", () => {
  test("discovers on selection and does not probe again for model or effort changes", async () => {
    const native = mount()
    expect(mocks.calls).toBe(0)
    native.select("codex")
    await vi.waitFor(() => expect(native.ready()).toBe(true))
    expect(native.selection()).toEqual({ type: "codex", model: "one", effort: "low" })
    native.setEffort("high")
    expect(native.selection()?.effort).toBe("high")
    native.setModel("two")
    expect(native.selection()).toEqual({ type: "codex", model: "two", effort: "medium" })
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
    native.setModel("removed")
    expect(native.ready()).toBe(false)
  })
})
