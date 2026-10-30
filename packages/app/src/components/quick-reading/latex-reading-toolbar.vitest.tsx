import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { ComponentProps } from "solid-js"
import type { LatexVersion } from "@opencode-ai/sdk/v2"
import type { useLatexReading } from "@/pages/session/use-latex-reading"
import { dict } from "@/i18n/en"
import { LatexReadingToolbar } from "./latex-reading-toolbar"

const mocks = vi.hoisted(() => ({ toast: vi.fn(), download: vi.fn<() => Promise<void>>() }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en-US",
    t: (key: string) => dict[key as keyof typeof dict] ?? key,
  }),
}))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: mocks.toast }))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => (
    <button disabled={props.disabled} title={props.title} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

const [state, setState] = createStore({
  versions: [] as LatexVersion[],
  selected: "",
  ready: "build-1",
  displayed: "build-1",
  error: "",
  slow: false,
  updating: false,
  outdated: false,
  collapsed: true,
  embedded: true,
})
const reading: ReturnType<typeof useLatexReading> = {
  state,
  document: () => undefined,
  key: () => undefined,
  refresh: async () => undefined,
  target: () => state.ready,
  updating: () => state.updating,
  slow: () => state.slow,
  outdated: () => state.outdated,
  capture: () => undefined,
  select: (id) => setState("selected", id),
  displayed: (id) => setState("displayed", id),
  url: () => "",
  reference: async () => undefined,
}
let host: HTMLDivElement
let dispose: VoidFunction
const toolbar = () => host.querySelector('[data-component="latex-reading-toolbar"]')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.download.mockResolvedValue(undefined)
  setState({
    versions: [],
    selected: "",
    ready: "build-1",
    displayed: "build-1",
    error: "",
    slow: false,
    updating: false,
    outdated: false,
    collapsed: true,
    embedded: true,
  })
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => (
      <LatexReadingToolbar
        reading={reading}
        download={mocks.download}
        collapsed={state.collapsed}
        embedded={state.embedded}
      />
    ),
    host,
  )
})

afterEach(() => {
  dispose()
  host.remove()
})

test("a normal PDF replacement does not insert a collapsed toolbar or warning rows", () => {
  expect(toolbar()).toBeNull()
  setState({ updating: true, outdated: true })
  expect(toolbar()).toBeNull()
  setState("ready", "build-2")
  expect(toolbar()).toBeNull()
  setState({ displayed: "build-2", updating: false, outdated: false })
  expect(toolbar()).toBeNull()
})

test("a slow replacement or error remains visible while the controls are collapsed", () => {
  setState({ updating: true, slow: true })
  expect(host.querySelector('[role="status"]')?.textContent).toBe(dict["latex.preview.waiting"])
  expect(host.querySelector("select")).toBeNull()
  setState({ slow: false, error: "Could not load the PDF" })
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not load the PDF")
  setState("error", "")
  expect(toolbar()).toBeNull()
})

test("expanded editor controls keep their row structure during a quick replacement", () => {
  setState("collapsed", false)
  const row = toolbar()?.firstElementChild
  expect(row?.querySelector("select")).not.toBeNull()
  expect(toolbar()?.children).toHaveLength(1)
  setState({ updating: true, outdated: true })
  expect(toolbar()?.firstElementChild).toBe(row)
  expect(toolbar()?.children).toHaveLength(1)
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(host.textContent).not.toContain(dict["latex.preview.outdated"])
  expect(host.textContent).not.toContain(dict["latex.preview.waiting"])
})

test("standalone reading updates its existing fixed-width caption without adding a row", () => {
  setState({ collapsed: false, embedded: false })
  const caption = toolbar()?.querySelector("span")
  expect(caption?.textContent).toBe(dict["latex.preview"])
  expect(caption?.classList.contains("w-28")).toBe(true)
  setState({ updating: true, outdated: true })
  expect(caption?.textContent).toBe(dict["latex.preview.updating"])
  expect(toolbar()?.children).toHaveLength(1)
  setState("updating", false)
  expect(caption?.textContent).toBe(dict["latex.preview.stale"])
  expect(caption?.getAttribute("title")).toBe(dict["latex.preview.outdated"])
  expect(toolbar()?.children).toHaveLength(1)
  expect(host.querySelector('[role="status"]')).toBeNull()
})

test("exporting an outdated displayed PDF keeps the version warning at the export action", () => {
  setState({ collapsed: false, displayed: "" })
  const button = host.querySelector("button")!
  expect(button.disabled).toBe(true)
  setState({ displayed: "build-1", outdated: true })
  expect(button.title).toBe(dict["latex.preview.outdated"])
  expect(mocks.toast).not.toHaveBeenCalled()
  button.click()
  expect(mocks.download).toHaveBeenCalledTimes(1)
  expect(mocks.toast).toHaveBeenCalledWith({
    title: dict["latex.preview.export"],
    description: dict["latex.preview.outdated"],
  })
  mocks.toast.mockClear()
  setState("outdated", false)
  button.click()
  expect(mocks.download).toHaveBeenCalledTimes(2)
  expect(mocks.toast).not.toHaveBeenCalled()
})
