import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import { NativeUsage } from "./native-usage"

const mocks = vi.hoisted(() => ({ usage: vi.fn() }))
const [state, setState] = createStore({ ready: true, server: "first", path: "", enabled: true })
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get url() {
      return state.server
    },
    client: { native: { usage: mocks.usage } },
  }),
}))
vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({
    get ready() {
      return state.ready
    },
    get data() {
      return { config: { native: { codex: { enabled: state.enabled, path: state.path } } } }
    },
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en-US",
    t: (key: string, values?: Record<string, unknown>) => key + (values ? JSON.stringify(values) : ""),
  }),
}))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

let host: HTMLDivElement
let dispose: VoidFunction | undefined
const mount = () => {
  dispose = render(() => <NativeUsage />, host)
}
const available = (name = "Codex") => ({
  data: {
    enabled: true,
    state: "available",
    updatedAt: 1000,
    limits: [{ id: "codex", name, primary: { usedPercent: 25 } }],
  },
})

beforeEach(() => {
  vi.resetAllMocks()
  setState({ ready: true, server: "first", path: "", enabled: true })
  mocks.usage.mockResolvedValue(available())
  host = document.createElement("div")
  document.body.append(host)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  host.remove()
})

test("disabled Codex never queries quota", async () => {
  setState("enabled", false)
  mount()
  expect(mocks.usage).not.toHaveBeenCalled()
  expect(host.textContent).toContain("native.usage.disabled")
  expect(host.querySelector("button")?.disabled).toBe(true)
})

test("quota displays remaining percentage and unknown reset time, and explicit refresh uses the bypass flag", async () => {
  mount()
  await vi.waitFor(() => expect(host.textContent).toContain('native.usage.remaining{"value":75}'))
  expect(host.textContent).toContain("native.usage.resetUnknown")
  expect(mocks.usage).toHaveBeenLastCalledWith({ refresh: false }, { throwOnError: true })
  host.querySelector("button")!.click()
  await vi.waitFor(() => expect(mocks.usage).toHaveBeenLastCalledWith({ refresh: true }, { throwOnError: true }))
  await vi.waitFor(() => expect(host.querySelector("button")?.disabled).toBe(false))
})

test.each(["server", "path"] as const)("late quota results cannot replace a different %s scope", async (key) => {
  const old = Promise.withResolvers<ReturnType<typeof available>>()
  mocks.usage.mockReturnValueOnce(old.promise).mockResolvedValueOnce(available("Current"))
  mount()
  await vi.waitFor(() => expect(mocks.usage).toHaveBeenCalledTimes(1))
  setState(key, "second")
  await vi.waitFor(() => expect(host.textContent).toContain("Current"))
  old.resolve(available("Old account"))
  await old.promise
  expect(host.textContent).not.toContain("Old account")
  expect(host.textContent).toContain("Current")
})

test("disabling while a query is pending discards the response", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof available>>()
  mocks.usage.mockReturnValueOnce(pending.promise)
  mount()
  await vi.waitFor(() => expect(mocks.usage).toHaveBeenCalledTimes(1))
  setState("enabled", false)
  pending.resolve(available("Old account"))
  await pending.promise
  expect(host.textContent).toContain("native.usage.disabled")
  expect(host.textContent).not.toContain("Old account")
})

test("a failed refresh removes old quota instead of showing a false current balance", async () => {
  mount()
  await vi.waitFor(() => expect(host.textContent).toContain('native.usage.remaining{"value":75}'))
  mocks.usage.mockResolvedValueOnce({ data: { enabled: true, state: "unavailable", limits: [] } })
  host.querySelector("button")!.click()
  await vi.waitFor(() => expect(host.textContent).toContain("native.usage.unavailable"))
  expect(host.textContent).not.toContain("native.usage.remaining")
  expect(host.textContent).not.toContain("native.usage.updated")
})
