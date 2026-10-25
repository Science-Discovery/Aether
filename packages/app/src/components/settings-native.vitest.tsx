import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import { SettingsNative } from "./settings-native"

const mocks = vi.hoisted(() => ({ calls: 0, fail: false, updates: [] as string[] }))
const [state, setState] = createStore({ config: { native: { codex: { path: "" } } } })

vi.mock("@solidjs/router", () => ({ useParams: () => ({}) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({
    data: state,
    updateConfig: async (config: { native: { codex: { path: string } } }) => {
      mocks.updates.push(config.native.codex.path)
      if (mocks.fail) throw new Error("Could not save settings")
      setState("config", "native", "codex", "path", config.native.codex.path)
    },
  }),
}))
vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    url: "http://localhost:1234",
    createClient: () => ({
      native: {
        status: async () => {
          mocks.calls++
          return {
            data: {
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
  TextField: (props: { value?: string; disabled?: boolean; onChange?: (value: string) => void }) => (
    <input
      value={props.value}
      disabled={props.disabled}
      onInput={(event) => props.onChange?.(event.currentTarget.value)}
    />
  ),
}))

let host: HTMLDivElement
let dispose: VoidFunction

beforeEach(() => {
  setState("config", "native", "codex", "path", "")
  mocks.calls = 0
  mocks.fail = false
  mocks.updates = []
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <SettingsNative />, host)
})
afterEach(() => {
  dispose()
  host.remove()
})

const input = (value: string) => {
  const field = host.querySelector("input")!
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
    expect(mocks.updates).toEqual(["C:\\Apps\\Codex\\codex.exe"])
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
    expect(mocks.updates).toEqual([""])
  })
})
