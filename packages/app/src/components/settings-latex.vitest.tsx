import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import type { LatexSetup, LatexStatus } from "@opencode-ai/sdk/v2"
import { dict } from "@/i18n/en"
import { SettingsProvider, useSettings } from "@/context/settings"
import { removePersisted } from "@/utils/persist"
import { SettingsLatex } from "./settings-latex"

const mocks = vi.hoisted(() => ({
  compiler: vi.fn<(server: string) => Promise<{ data: LatexStatus }>>(),
  status: vi.fn<(server: string) => Promise<{ data: LatexSetup }>>(),
  start: vi.fn<(server: string) => Promise<{ data: LatexSetup }>>(),
  cancel: vi.fn<(server: string) => Promise<{ data: LatexSetup }>>(),
  save: vi.fn(),
  open: vi.fn(),
}))
const [state, setState] = createStore({
  server: "http://first-server",
  ready: true,
  config: { latex: { tectonic: { path: "" }, latexmk: { path: "" } } },
})
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en-US",
    t: (key: string, values?: Record<string, string>) =>
      (dict[key as keyof typeof dict] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => values?.[name] ?? name),
  }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web", openLink: mocks.open }) }))
vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({
    data: state,
    get ready() {
      return state.ready
    },
    updateConfig: async (config: typeof state.config) => {
      mocks.save(config)
      setState("config", config)
    },
  }),
}))
vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    get url() {
      return state.server
    },
    get client() {
      const server = state.server
      return {
        latex: {
          status: () => mocks.compiler(server),
          setupStatus: () => mocks.status(server),
          setupStart: () => mocks.start(server),
          setupCancel: () => mocks.cancel(server),
        },
      }
    },
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
    label?: string
    disabled?: boolean
    onChange?: (value: string) => void
    "data-action"?: string
  }) => (
    <input
      value={props.value}
      aria-label={props.label}
      disabled={props.disabled}
      data-action={props["data-action"]}
      onInput={(event) => props.onChange?.(event.currentTarget.value)}
    />
  ),
}))
vi.mock("@opencode-ai/ui/select", () => ({
  Select: <T,>(props: {
    options: T[]
    current?: T
    value?: (value: T) => string
    label?: (value: T) => string
    onSelect?: (value: T | undefined) => void
    triggerProps?: Record<string, string>
    "data-action"?: string
  }) => (
    <select
      value={String(props.current)}
      aria-label={props.triggerProps?.["aria-label"]}
      data-action={props["data-action"]}
      onChange={(event) => props.onSelect?.(props.options.find((value) => String(value) === event.currentTarget.value))}
    >
      {props.options.map((value) => (
        <option value={props.value?.(value) ?? String(value)}>{props.label?.(value) ?? String(value)}</option>
      ))}
    </select>
  ),
}))

const setup = (value: Partial<LatexSetup> = {}) => ({
  data: {
    state: "idle",
    supported: true,
    version: "0.17.0",
    downloaded: 0,
    ...value,
  } as LatexSetup,
})
let host: HTMLDivElement
let dispose: VoidFunction | undefined
let settings: ReturnType<typeof useSettings>
function Content() {
  settings = useSettings()
  return <SettingsLatex />
}
const mount = () => {
  dispose = render(
    () => (
      <SettingsProvider>
        <Content />
      </SettingsProvider>
    ),
    host,
  )
}
const tick = (time = 0) => vi.advanceTimersByTimeAsync(time)
const button = (action: string) => host.querySelector<HTMLButtonElement>(`[data-action="latex-${action}"]`)!
const field = () => host.querySelector<HTMLInputElement>('[data-action="latex-tectonic-path"]')!
const input = (value: string) => {
  field().value = value
  field().dispatchEvent(new Event("input", { bubbles: true }))
}
const select = (name: string, value: string) => {
  const field = host.querySelector<HTMLSelectElement>(`[data-action="latex-appearance-${name}"]`)!
  field.value = value
  field.dispatchEvent(new Event("change", { bubbles: true }))
}
const appearance = () => ({
  mode: settings.latex.mode(),
  size: settings.latex.size(),
  spacing: settings.latex.spacing(),
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  removePersisted({ key: "settings.v3" })
  setState({
    server: "http://first-server",
    ready: true,
    config: { latex: { tectonic: { path: "" }, latexmk: { path: "" } } },
  })
  mocks.compiler.mockResolvedValue({
    data: {
      tools: [
        { driver: "tectonic", installed: false },
        { driver: "latexmk", installed: false },
      ],
    },
  })
  mocks.status.mockResolvedValue(setup())
  mocks.start.mockResolvedValue(setup({ state: "downloading", downloaded: 1024, total: 4096 }))
  mocks.cancel.mockResolvedValue(setup({ state: "cancelled" }))
  host = document.createElement("div")
  document.body.append(host)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  host.remove()
  removePersisted({ key: "settings.v3" })
  vi.clearAllTimers()
  vi.useRealTimers()
})

test("older local settings receive LaTeX appearance defaults without changing compiler paths", async () => {
  localStorage.setItem("settings.v3", JSON.stringify({ appearance: { fontSize: 18 }, general: { autoSave: false } }))
  setState("config", "latex", "tectonic", "path", "/custom/tectonic")
  mount()
  await tick()
  expect(appearance()).toEqual({ mode: "auto", size: 14, spacing: "normal" })
  expect(settings.appearance.fontSize()).toBe(18)
  expect(settings.general.autoSave()).toBe(false)
  expect(field().value).toBe("/custom/tectonic")
  expect(host.textContent).toContain("Editor appearance")
  expect(host.textContent).toContain("Compilers")
  expect(mocks.save).not.toHaveBeenCalled()
})

test.each([
  [null, { mode: "auto", size: 14, spacing: "normal" }],
  [
    { mode: "sepia", size: "large", spacing: "huge" },
    { mode: "auto", size: 14, spacing: "normal" },
  ],
  [
    { mode: "dark", size: 1, spacing: "compact" },
    { mode: "dark", size: 12, spacing: "compact" },
  ],
  [
    { mode: "light", size: 99, spacing: "wide" },
    { mode: "light", size: 20, spacing: "wide" },
  ],
  [{ size: 15.6 }, { mode: "auto", size: 16, spacing: "normal" }],
])("validates persisted LaTeX appearance %j", async (latex, expected) => {
  localStorage.setItem("settings.v3", JSON.stringify({ latex }))
  mount()
  await tick()
  expect(appearance()).toEqual(expected)
  expect(mocks.save).not.toHaveBeenCalled()
})

test("appearance updates persist immediately and restore defaults without saving compiler drafts", async () => {
  setState("config", "latex", "tectonic", "path", "/custom/tectonic")
  mount()
  await tick()
  input("/draft/tectonic")
  select("mode", "dark")
  select("size", "18")
  select("spacing", "wide")
  expect(appearance()).toEqual({ mode: "dark", size: 18, spacing: "wide" })
  expect(JSON.parse(localStorage.getItem("settings.v3")!).latex).toEqual(appearance())
  expect(mocks.save).not.toHaveBeenCalled()
  expect(field().value).toBe("/draft/tectonic")
  expect(state.config.latex.tectonic.path).toBe("/custom/tectonic")
  button("appearance-reset").click()
  expect(appearance()).toEqual({ mode: "auto", size: 14, spacing: "normal" })
  expect(JSON.parse(localStorage.getItem("settings.v3")!).latex).toEqual(appearance())
  expect(field().value).toBe("/draft/tectonic")
  expect(mocks.save).not.toHaveBeenCalled()
  button("save").click()
  await tick()
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
    latex: { tectonic: { path: "/draft/tectonic" }, latexmk: { path: "" } },
  })
  expect(appearance()).toEqual({ mode: "auto", size: 14, spacing: "normal" })
})

test("appearance is restored when settings reopen and setters keep font size valid", async () => {
  mount()
  await tick()
  select("mode", "light")
  select("spacing", "compact")
  settings.latex.setSize(Infinity)
  expect(settings.latex.size()).toBe(14)
  settings.latex.setSize(22)
  expect(settings.latex.size()).toBe(20)
  settings.latex.setSize(10)
  expect(settings.latex.size()).toBe(12)
  settings.latex.setSize(16)
  dispose?.()
  mount()
  await tick()
  expect(appearance()).toEqual({ mode: "light", size: 16, spacing: "compact" })
  expect(mocks.save).not.toHaveBeenCalled()
})

test("loads once when configuration is ready and does not poll an idle installer", async () => {
  setState("ready", false)
  mount()
  await tick()
  expect(mocks.status).not.toHaveBeenCalled()
  expect(mocks.compiler).not.toHaveBeenCalled()
  setState("ready", true)
  await tick()
  await tick(5000)
  expect(mocks.status).toHaveBeenCalledTimes(1)
  expect(mocks.compiler).toHaveBeenCalledTimes(1)
  expect(button("setup-start").disabled).toBe(false)
  expect(host.textContent).toContain("machine running the Aether server")
  expect(host.textContent).toContain("separate download on the first build")
  expect(host.querySelector('a[href="https://www.tug.org/texlive/acquire-netinstall.html"]')).not.toBeNull()
  expect(host.querySelector('a[href="https://miktex.org/download"]')).not.toBeNull()
  expect(host.querySelector('[data-component="latex-latexmk"] [data-action="latex-setup-start"]')).toBeNull()
})

test("shows download bytes and each busy phase, then discovers the managed path without saving config", async () => {
  mount()
  await tick()
  button("setup-start").click()
  await tick()
  expect(host.textContent).toContain("Downloaded 1 KiB of 4 KiB")
  expect(host.querySelector("progress")?.value).toBe(1024)
  expect(host.querySelector("progress")?.max).toBe(4096)
  for (const phase of ["verifying", "extracting", "checking"] as const) {
    mocks.status.mockResolvedValueOnce(setup({ state: phase }))
    await tick(750)
    expect(host.textContent).toContain(dict[`latex.setup.${phase}`])
    expect(button("setup-cancel").disabled).toBe(false)
  }
  mocks.compiler.mockResolvedValue({
    data: { tools: [{ driver: "tectonic", installed: true, path: "/managed/tectonic" }] },
  })
  mocks.status.mockResolvedValueOnce(setup({ state: "ready", path: "/managed/tectonic" }))
  await tick(750)
  expect(host.textContent).toContain("Tectonic installed")
  expect(host.textContent).toContain("Available")
  expect(field().value).toBe("")
  expect(host.querySelector('[data-component="latex-managed-path"]')?.textContent).toBe("/managed/tectonic")
  expect(mocks.save).not.toHaveBeenCalled()
  const count = mocks.status.mock.calls.length
  await tick(5000)
  expect(mocks.status).toHaveBeenCalledTimes(count)
  expect(button("setup-start").textContent).toBe("Check / repair installation")
  button("setup-start").click()
  await tick()
  expect(mocks.start).toHaveBeenCalledTimes(2)
})

test("cancellation wins over an older progress response and polling stops", async () => {
  mount()
  await tick()
  button("setup-start").click()
  await tick()
  const pending = Promise.withResolvers<{ data: LatexSetup }>()
  mocks.status.mockReturnValueOnce(pending.promise)
  await tick(750)
  button("setup-cancel").click()
  await tick()
  expect(host.textContent).toContain("Installation cancelled")
  pending.resolve(setup({ state: "ready", path: "/old-result/tectonic" }))
  await tick()
  expect(field().value).toBe("")
  expect(host.textContent).not.toContain("Tectonic installed")
  const count = mocks.status.mock.calls.length
  await tick(5000)
  expect(mocks.status).toHaveBeenCalledTimes(count)
  expect(mocks.cancel).toHaveBeenCalledTimes(1)
  expect(button("setup-start").textContent).toBe("Retry installation")
})

test("a failed download can be retried without changing either compiler configuration", async () => {
  mocks.start.mockResolvedValueOnce(setup({ state: "failed", error: "Checksum did not match" }))
  mount()
  await tick()
  button("setup-start").click()
  await tick()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Checksum did not match")
  expect(button("setup-start").textContent).toBe("Retry installation")
  button("setup-start").click()
  await tick()
  expect(mocks.start).toHaveBeenCalledTimes(2)
  expect(host.textContent).toContain("Downloading Tectonic")
  expect(host.textContent).not.toContain("Checksum did not match")
  expect(mocks.save).not.toHaveBeenCalled()
})

test("completion preserves a path being edited during installation", async () => {
  mount()
  await tick()
  button("setup-start").click()
  await tick()
  input("/my/draft/tectonic")
  mocks.status.mockResolvedValueOnce(setup({ state: "ready", path: "/managed/tectonic" }))
  await tick(750)
  expect(field().value).toBe("/my/draft/tectonic")
  expect(host.querySelector('[data-component="latex-managed-path"]')?.textContent).toBe("/managed/tectonic")
  expect(mocks.save).not.toHaveBeenCalled()
})

test("existing custom paths remain active until the user explicitly saves a change", async () => {
  setState("config", "latex", "tectonic", "path", "/custom/tectonic")
  mocks.status.mockResolvedValue(setup({ state: "ready", path: "/managed/tectonic" }))
  mount()
  await tick()
  expect(field().value).toBe("/custom/tectonic")
  expect(host.textContent).toContain("A custom Tectonic path is still configured")
  expect(mocks.save).not.toHaveBeenCalled()
  input("")
  button("save").click()
  await tick()
  expect(mocks.save).toHaveBeenCalledWith({ latex: { tectonic: { path: "" }, latexmk: { path: "" } } })
  expect(host.textContent).not.toContain("A custom Tectonic path is still configured")
})

test("saving latexmk after installation preserves Tectonic discovery across managed path repairs", async () => {
  mount()
  await tick()
  mocks.start.mockResolvedValueOnce(setup({ state: "ready", path: "/managed/uuid-first/tectonic" }))
  button("setup-start").click()
  await tick()
  expect(field().value).toBe("")
  expect(host.querySelector('[data-component="latex-managed-path"]')?.textContent).toBe("/managed/uuid-first/tectonic")
  const latexmk = host.querySelector<HTMLInputElement>('[data-action="latex-latexmk-path"]')!
  latexmk.value = "/custom/latexmk"
  latexmk.dispatchEvent(new Event("input", { bubbles: true }))
  button("save").click()
  await tick()
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
    latex: { tectonic: { path: "" }, latexmk: { path: "/custom/latexmk" } },
  })
  mocks.start.mockResolvedValueOnce(setup({ state: "ready", path: "/managed/uuid-repaired/tectonic" }))
  button("setup-start").click()
  await tick()
  expect(field().value).toBe("")
  expect(host.querySelector('[data-component="latex-managed-path"]')?.textContent).toBe(
    "/managed/uuid-repaired/tectonic",
  )
  expect(state.config.latex.tectonic.path).toBe("")
  expect(mocks.save).toHaveBeenCalledTimes(1)
})

test("unsupported servers retain manual guidance and cannot start installation", async () => {
  mocks.status.mockResolvedValue(setup({ supported: false, error: "No official release for this architecture" }))
  mount()
  await tick()
  expect(button("setup-start").disabled).toBe(true)
  expect(host.textContent).toContain("Automatic installation is unavailable")
  expect(host.textContent).not.toContain("Ready to install")
  expect(
    host.querySelector('a[href="https://tectonic-typesetting.github.io/book/latest/installation/"]'),
  ).not.toBeNull()
  await tick(5000)
  expect(mocks.status).toHaveBeenCalledTimes(1)
  expect(mocks.start).not.toHaveBeenCalled()
})

test("late installation responses cannot replace another server's path or restart polling", async () => {
  const pending = Promise.withResolvers<{ data: LatexSetup }>()
  mocks.start.mockReturnValueOnce(pending.promise)
  mount()
  await tick()
  button("setup-start").click()
  await tick()
  mocks.status.mockImplementation(async (server) => setup({ state: "ready", path: `${server}/tectonic` }))
  setState("server", "http://second-server")
  await tick()
  expect(field().value).toBe("")
  expect(host.querySelector('[data-component="latex-managed-path"]')?.textContent).toBe("http://second-server/tectonic")
  pending.resolve(setup({ state: "downloading", downloaded: 10 }))
  await tick()
  await tick(5000)
  expect(field().value).toBe("")
  expect(host.querySelector('[data-component="latex-managed-path"]')?.textContent).toBe("http://second-server/tectonic")
  expect(host.textContent).not.toContain("Downloading Tectonic")
  expect(mocks.status.mock.calls.map((call) => call[0])).toEqual(["http://first-server", "http://second-server"])
})

test("closing settings stops polling and ignores an in-flight response", async () => {
  mount()
  await tick()
  button("setup-start").click()
  await tick()
  const pending = Promise.withResolvers<{ data: LatexSetup }>()
  mocks.status.mockReturnValueOnce(pending.promise)
  await tick(750)
  dispose?.()
  dispose = undefined
  const count = mocks.status.mock.calls.length
  pending.resolve(setup({ state: "downloading", downloaded: 2048 }))
  await tick()
  await tick(5000)
  expect(mocks.status).toHaveBeenCalledTimes(count)
})
