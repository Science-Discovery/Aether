import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import { NativeHistoryControl } from "./native-history"

const mocks = vi.hoisted(() => ({ history: vi.fn() }))
const [state, setState] = createStore({
  id: "session",
  url: "local",
  directory: "/project",
  thread: "thread",
  enabled: true,
  status: "idle",
})
vi.mock("@solidjs/router", () => ({ useParams: () => state }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/local", () => ({ useLocal: () => ({ native: { enabled: () => state.enabled } }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get url() {
      return state.url
    },
    get directory() {
      return state.directory
    },
    client: { native: { history: mocks.history } },
  }),
}))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    data: {
      get session_status() {
        return { [state.id]: { type: state.status } }
      },
    },
    session: { get: () => ({ engine: { thread: state.thread } }) },
  }),
}))

const cleanups: VoidFunction[] = []
function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <NativeHistoryControl />, host)
  const off = () => {
    dispose()
    host.remove()
  }
  cleanups.push(off)
  return { host, off, button: () => host.querySelector<HTMLButtonElement>("button")! }
}
const focus = () => window.dispatchEvent(new window.Event("focus"))
beforeEach(() => {
  mocks.history.mockReset().mockResolvedValue({ data: { state: "synced" } })
  setState(
    reconcile({
      id: "session",
      url: "local",
      directory: "/project",
      thread: "thread",
      enabled: true,
      status: "idle",
    }),
  )
})
afterEach(() => cleanups.splice(0).forEach((off) => off()))

describe("native history refresh", () => {
  test("refreshes on focus without bypassing the backend throttle and removes the listener on disposal", async () => {
    const fixture = mount()
    await vi.waitFor(() => expect(fixture.button().disabled).toBe(false))
    focus()
    expect(mocks.history).toHaveBeenNthCalledWith(2, { sessionID: "session", refresh: false })
    await vi.waitFor(() => expect(fixture.button().disabled).toBe(false))
    fixture.button().click()
    expect(mocks.history).toHaveBeenNthCalledWith(3, { sessionID: "session", refresh: true })
    fixture.off()
    focus()
    expect(mocks.history).toHaveBeenCalledTimes(3)
  })

  test.each(["busy", "retry"])("does not refresh an active %s session", async (status) => {
    setState("status", status)
    const fixture = mount()
    focus()
    expect(mocks.history).not.toHaveBeenCalled()
    expect(fixture.button().disabled).toBe(true)
    setState("status", "idle")
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith({ sessionID: "session", refresh: false })
    await vi.waitFor(() => expect(fixture.button().disabled).toBe(false))
  })

  test("does not refresh disabled or unbound sessions", () => {
    setState("enabled", false)
    mount()
    focus()
    expect(mocks.history).not.toHaveBeenCalled()
    setState("thread", "")
    setState("enabled", true)
    focus()
    expect(mocks.history).not.toHaveBeenCalled()
  })

  test("coalesces focus while loading and ignores a late result from the previous scope", async () => {
    const response = Promise.withResolvers<{ data: { state: string; error?: string } }>()
    mocks.history.mockReturnValueOnce(response.promise)
    const fixture = mount()
    focus()
    focus()
    expect(mocks.history).toHaveBeenCalledTimes(1)
    setState("url", "remote")
    expect(mocks.history).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(fixture.button().disabled).toBe(false))
    response.resolve({ data: { state: "unavailable", error: "Old server failure" } })
    await response.promise
    await Promise.resolve()
    expect(fixture.button().title).toBe("native.history.refresh")
    expect(fixture.host.querySelector('[role="status"]')).toBeNull()
  })

  test("keeps partial history diagnostics out of the prompt", async () => {
    mocks.history.mockResolvedValue({ data: { state: "partial", error: "Previously observed output is missing" } })
    const fixture = mount()
    await vi.waitFor(() => expect(fixture.button().disabled).toBe(false))
    expect(fixture.button().title).toBe("native.history.refresh")
    expect(fixture.host.querySelector('[role="status"]')).toBeNull()
  })
})
