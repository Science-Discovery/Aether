import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import { SettingsNative } from "./settings-native"

const mocks = vi.hoisted(() => ({
  calls: 0,
  fail: false,
  enabled: true,
  queries: [] as boolean[],
  updates: [] as { path?: string; enabled?: boolean; limit?: number }[],
}))
const [state, setState] = createStore<{
  ready: boolean
  config: { native: { codex: { path: string; enabled?: boolean; limit?: number } } }
}>({ ready: true, config: { native: { codex: { path: "" } } } })

vi.mock("@solidjs/router", () => ({ useParams: () => ({}) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({
    data: state,
    get ready() {
      return state.ready
    },
    updateConfig: async (config: { native: { codex: { path?: string; enabled?: boolean; limit?: number } } }) => {
      mocks.updates.push(config.native.codex)
      if (mocks.fail) throw new Error("Could not save settings")
      setState("config", "native", "codex", config.native.codex)
    },
  }),
}))
vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    url: "http://localhost:1234",
    createClient: () => ({
      native: {
        status: async (input?: { refresh?: boolean }) => {
          mocks.calls++
          mocks.queries.push(input?.refresh ?? false)
          return {
            data: {
              enabled: mocks.enabled,
              installed: true,
              connected: true,
              auth: "missing",
              path: state.config.native.codex.path || "/auto/codex",
              version: "test-version",
              models: [],
            },
          }
        },
      },
    }),
  }),
}))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; disabled?: boolean; onClick?: () => void; "data-action"?: string }) => (
    <button disabled={props.disabled} onClick={props.onClick} data-action={props["data-action"]}>
      {props.children}
    </button>
  ),
}))
vi.mock("@opencode-ai/ui/text-field", () => ({
  TextField: (props: {
    value?: string
    disabled?: boolean
    onChange?: (value: string) => void
    "data-action"?: string
  }) => (
    <input
      value={props.value}
      disabled={props.disabled}
      data-action={props["data-action"]}
      onInput={(event) => props.onChange?.(event.currentTarget.value)}
    />
  ),
}))
vi.mock("@opencode-ai/ui/switch", () => ({
  Switch: (props: { checked?: boolean; disabled?: boolean; onChange?: (value: boolean) => void }) => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked ? "true" : "false"}
      disabled={props.disabled}
      onClick={() => props.onChange?.(!props.checked)}
    />
  ),
}))

let host: HTMLDivElement
let dispose: VoidFunction

beforeEach(() => {
  setState({ ready: true, config: { native: { codex: { path: "", enabled: undefined, limit: undefined } } } })
  mocks.calls = 0
  mocks.fail = false
  mocks.enabled = true
  mocks.updates = []
  mocks.queries = []
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <SettingsNative />, host)
})
afterEach(() => {
  dispose()
  host.remove()
})

const input = (value: string, action = "native-path") => {
  const field = host.querySelector<HTMLInputElement>(`[data-action="${action}"]`)!
  field.value = value
  field.dispatchEvent(new Event("input", { bubbles: true }))
}
const save = () => host.querySelector<HTMLButtonElement>('[data-action="native-save"]')!.click()

describe("native settings", () => {
  test("distinguishes installation and protocol connection from missing authentication", async () => {
    await vi.waitFor(() => expect(host.textContent).toContain("native.auth.missing"))
    expect(host.textContent).toContain("native.found")
    expect(host.textContent).toContain("native.connected")
    expect(host.textContent).toContain("/auto/codex")
    expect(host.textContent).toContain("test-version")
  })

  test("saves a trimmed global executable path and probes it once", async () => {
    await vi.waitFor(() => expect(mocks.calls).toBe(1))
    input("  C:\\Apps\\Codex\\codex.exe  ")
    save()
    await vi.waitFor(() => expect(host.textContent).toContain("C:\\Apps\\Codex\\codex.exe"))
    expect(mocks.updates).toEqual([{ path: "C:\\Apps\\Codex\\codex.exe", limit: 4 }])
    expect(mocks.calls).toBe(2)
  })

  test("preserves the edited path and reports a failed save", async () => {
    await vi.waitFor(() => expect(mocks.calls).toBe(1))
    mocks.fail = true
    input("/custom/codex")
    save()
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save settings"),
    )
    expect(host.querySelector("input")!.value).toBe("/custom/codex")
    expect(state.config.native.codex.path).toBe("")
    expect(mocks.calls).toBe(1)
  })

  test("can restore automatic discovery with an empty path", async () => {
    setState("config", "native", "codex", "path", "/custom/codex")
    await vi.waitFor(() => expect(host.textContent).toContain("/custom/codex"))
    input(" ")
    save()
    await vi.waitFor(() => expect(host.textContent).toContain("/auto/codex"))
    expect(mocks.updates).toEqual([{ path: "", limit: 4 }])
  })

  test("defaults to enabled with four idle processes and preserves settings while switching off", async () => {
    await vi.waitFor(() => expect(mocks.calls).toBe(1))
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true")
    expect(host.querySelector<HTMLInputElement>('[data-action="native-limit"]')?.value).toBe("4")
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    await vi.waitFor(() => expect(host.textContent).toContain("native.disabled"))
    expect(mocks.updates).toEqual([{ enabled: false }])
    expect(host.textContent).not.toContain("native.connected")
    expect(host.querySelector<HTMLButtonElement>('[data-action="native-refresh"]')?.disabled).toBe(true)
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('[data-action="native-save"]')?.disabled).toBe(false),
    )
    input("0", "native-limit")
    save()
    await vi.waitFor(() => expect(state.config.native.codex.limit).toBe(0))
    expect(mocks.calls).toBe(1)
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(false))
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    await vi.waitFor(() => expect(mocks.calls).toBe(2))
    expect(state.config.native.codex.enabled).toBe(true)
    expect(state.config.native.codex.limit).toBe(0)
  })

  test("does not probe an initially disabled or not yet loaded configuration", async () => {
    dispose()
    host.replaceChildren()
    setState({ ready: false, config: { native: { codex: { path: "", enabled: false } } } })
    mocks.calls = 0
    dispose = render(() => <SettingsNative />, host)
    expect(mocks.calls).toBe(0)
    setState("ready", true)
    await Promise.resolve()
    expect(mocks.calls).toBe(0)
    expect(host.textContent).toContain("native.disabled")
  })

  test("a disabled server response is not mislabeled as an installation problem", async () => {
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('[data-action="native-refresh"]')?.disabled).toBe(false),
    )
    mocks.enabled = false
    host.querySelector<HTMLButtonElement>('[data-action="native-refresh"]')!.click()
    await vi.waitFor(() => expect(host.textContent).toContain("native.disabled"))
    expect(host.textContent).not.toContain("native.installation")
    expect(host.textContent).not.toContain("native.connected")
  })

  test.each(["", "-1", "1.5", "17"])("rejects the invalid process limit %j without saving", async (value) => {
    await vi.waitFor(() => expect(mocks.calls).toBe(1))
    input(value, "native-limit")
    save()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("native.limitInvalid")
    expect(mocks.updates).toEqual([])
    expect(mocks.calls).toBe(1)
  })

  test("retains the enabled setting on save failure and explicitly bypasses the probe cache", async () => {
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('[data-action="native-refresh"]')?.disabled).toBe(false),
    )
    mocks.fail = true
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save settings"),
    )
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true")
    host.querySelector<HTMLButtonElement>('[data-action="native-refresh"]')!.click()
    await vi.waitFor(() => expect(mocks.calls).toBe(2))
    expect(mocks.queries).toEqual([false, true])
  })
})
