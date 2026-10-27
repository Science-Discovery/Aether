import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import type { LatexBuild, LatexProject, LatexStatus } from "@opencode-ai/sdk/v2"
import { dict } from "@/i18n/en"
import { LatexPanel } from "./latex-panel"

const mocks = vi.hoisted(() => ({
  project: vi.fn<(input: { root?: string; path?: string }) => Promise<{ data: LatexProject }>>(),
  refresh: vi.fn<(input: { root: string; editors: string[] }) => Promise<{ data: LatexProject }>>(),
  status: vi.fn<() => Promise<{ data: LatexStatus }>>(),
  bind: vi.fn<() => Promise<{ data: LatexProject }>>(),
  build: vi.fn<() => Promise<{ data: LatexBuild }>>(),
  stop: vi.fn(),
}))
const [state, setState] = createStore({
  server: "http://first-server",
  directory: "/workspace",
  path: "main.tex",
  active: true,
})
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get url() {
      return state.server
    },
    get directory() {
      return state.directory
    },
    client: { latex: mocks },
    event: { on: () => mocks.stop },
  }),
}))
vi.mock("@/context/file", () => ({
  useFile: () => ({
    drafts: () => [],
    ready: () => true,
    capture: () => ({ drafts: () => [], saved: () => undefined }),
  }),
}))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en-US",
    t: (key: string, values?: Record<string, string | number>) =>
      (dict[key as keyof typeof dict] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(values?.[name] ?? name),
      ),
  }),
}))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => undefined }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children?: JSX.Element }) => props.children }))
vi.mock("@opencode-ai/ui/resize-handle", () => ({ ResizeHandle: () => null }))
vi.mock("./settings-latex", () => ({ SettingsLatex: () => null }))
vi.mock("./pdf-viewer-shell-official", () => ({
  PdfViewerShell: (props: { src: string }) => <div data-testid="pdf" data-src={props.src} />,
}))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; disabled?: boolean; onClick?: () => void; "data-action"?: string }) => (
    <button disabled={props.disabled} onClick={props.onClick} data-action={props["data-action"]}>
      {props.children}
    </button>
  ),
}))

const project = (value: Partial<LatexProject> = {}): LatexProject => ({
  root: ".",
  main: "main.tex",
  candidates: ["main.tex"],
  reason: "single",
  freshness: { state: "unknown" },
  editors: [],
  ...value,
})
const bound = (): LatexProject => {
  const build = {
    id: "build-1",
    root: ".",
    main: "main.tex",
    bindingRevision: "binding-1",
    sourceRevision: "source-1",
    state: "succeeded" as const,
    createdAt: 1,
    diagnostics: [],
    log: "",
    truncated: false,
    pdf: true,
  }
  return project({
    binding: { root: ".", main: "main.tex", driver: "auto", program: "auto", revision: "binding-1", updatedAt: 1 },
    reason: "binding",
    freshness: { state: "fresh", sourceRevision: "source-1", checkedAt: 1 },
    latest: build,
    lastSuccessful: build,
  })
}
let host: HTMLDivElement
let dispose: VoidFunction | undefined
const mount = () => {
  dispose = render(
    () => (
      <LatexPanel enabled active={state.active} path={state.path} onNavigate={() => undefined}>
        <div>Source editor</div>
      </LatexPanel>
    ),
    host,
  )
}
const tick = () => vi.advanceTimersByTimeAsync(0)
const button = (key: keyof typeof dict) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent === dict[key])!
const field = (key: "root" | "main" | "driver" | "program") =>
  host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${dict[`latex.${key}`]}"]`)!
const edit = (key: "root" | "main" | "driver" | "program", value: string) => {
  field(key).value = value
  field(key).dispatchEvent(new Event(key === "root" || key === "main" ? "input" : "change", { bubbles: true }))
}
const current = () => host.querySelector('[data-component="latex-preview-status"]')?.getAttribute("data-current")

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  setState({ server: "http://first-server", directory: "/workspace", path: "main.tex", active: true })
  mocks.project.mockResolvedValue({ data: project() })
  mocks.refresh.mockResolvedValue({ data: project() })
  mocks.status.mockResolvedValue({ data: { tools: [{ driver: "tectonic", installed: true }] } })
  mocks.bind.mockResolvedValue({ data: project() })
  host = document.createElement("div")
  document.body.append(host)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  host.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test("failed initial discovery exposes the project folder and can recover by opening a smaller root", async () => {
  mocks.project.mockRejectedValueOnce(new Error("Choose a smaller project directory."))
  mount()
  await tick()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Choose a smaller project directory.")
  expect(field("root")).not.toBeNull()
  expect(host.querySelector<HTMLButtonElement>('[data-action="latex-compile"]')?.disabled).toBe(true)
  expect(mocks.refresh).not.toHaveBeenCalled()
  edit("root", "paper")
  mocks.project.mockResolvedValueOnce({ data: project({ root: "paper" }) })
  mocks.refresh.mockResolvedValueOnce({ data: project({ root: "paper" }) })
  button("latex.open").click()
  await tick()
  expect(mocks.project).toHaveBeenLastCalledWith({ path: "main.tex", root: "paper" }, { throwOnError: true })
  expect(field("root").value).toBe("paper")
  expect(field("main").value).toBe("main.tex")
  expect(button("latex.bind").disabled).toBe(false)
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

test("a successful retry initializes the unedited form and clears only the loading error", async () => {
  mocks.project.mockRejectedValueOnce(new Error("Temporary discovery failure"))
  mount()
  await tick()
  mocks.project.mockResolvedValueOnce({ data: bound() })
  mocks.refresh.mockResolvedValueOnce({ data: bound() })
  button("latex.refresh").click()
  await tick()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector<HTMLButtonElement>('[data-action="latex-compile"]')?.disabled).toBe(false)
  expect(current()).toBe("true")
})

test("scan failures retain discovered main documents and refreshes preserve every configuration draft", async () => {
  mocks.refresh.mockRejectedValueOnce(new Error("The project exceeds 256 MiB."))
  mount()
  await tick()
  expect(field("root").value).toBe(".")
  expect(field("main").value).toBe("main.tex")
  expect(host.querySelector('datalist option[value="main.tex"]')).not.toBeNull()
  expect(button("latex.bind").disabled).toBe(false)
  edit("root", "paper")
  edit("main", "draft.tex")
  edit("driver", "latexmk")
  edit("program", "xelatex")
  button("latex.refresh").click()
  await tick()
  setState("active", false)
  setState("active", true)
  await tick()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(field("root").value).toBe("paper")
  expect(field("main").value).toBe("draft.tex")
  expect(field("driver").value).toBe("latexmk")
  expect(field("program").value).toBe("xelatex")
})

test("a discovered project exceeding snapshot limits can recover by opening a smaller folder", async () => {
  mocks.refresh.mockRejectedValueOnce({
    error: "The LaTeX project exceeds 256 MiB. Choose a smaller project directory.",
  })
  mount()
  await tick()
  expect(field("root").value).toBe(".")
  expect(field("main").value).toBe("main.tex")
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("The LaTeX project exceeds 256 MiB.")
  edit("root", "paper")
  mocks.project.mockResolvedValueOnce({ data: project({ root: "paper", main: "paper.tex" }) })
  mocks.refresh.mockResolvedValueOnce({ data: project({ root: "paper", main: "paper.tex" }) })
  button("latex.open").click()
  await tick()
  expect(field("root").value).toBe("paper")
  expect(field("main").value).toBe("paper.tex")
  expect(mocks.refresh).toHaveBeenLastCalledWith({ root: "paper", editors: [] }, { throwOnError: true })
  expect(button("latex.bind").disabled).toBe(false)
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

test("edits made while initial discovery is pending survive its response and later retries", async () => {
  mocks.project.mockRejectedValueOnce(new Error("Discovery unavailable"))
  mount()
  await tick()
  const pending = Promise.withResolvers<{ data: LatexProject }>()
  mocks.project.mockReturnValueOnce(pending.promise)
  button("latex.refresh").click()
  edit("root", "chosen")
  edit("main", "chosen.tex")
  pending.resolve({ data: project() })
  await tick()
  button("latex.refresh").click()
  await tick()
  expect(field("root").value).toBe("chosen")
  expect(field("main").value).toBe("chosen.tex")
})

test("cached PDF metadata is not current while scanning or after a scan failure", async () => {
  const pending = Promise.withResolvers<{ data: LatexProject }>()
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockReturnValueOnce(pending.promise)
  mount()
  await tick()
  expect(host.querySelector('[data-testid="pdf"]')).not.toBeNull()
  expect(current()).toBe("false")
  pending.reject(new Error("Source scan failed"))
  await tick()
  expect(current()).toBe("false")
  expect(field("root").value).toBe(".")
  mocks.refresh.mockResolvedValueOnce({ data: bound() })
  button("latex.refresh").click()
  await tick()
  expect(current()).toBe("true")
})

test("compilation supersedes a pending scan without blocking completion polling", async () => {
  const pending = Promise.withResolvers<{ data: LatexProject }>()
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockReturnValueOnce(pending.promise).mockResolvedValue({ data: bound() })
  mocks.build.mockResolvedValue({ data: { ...bound().latest!, id: "build-2", state: "running" } })
  mount()
  await tick()
  host.querySelector<HTMLButtonElement>('[data-action="latex-compile"]')!.click()
  await tick()
  expect(mocks.build).toHaveBeenCalledTimes(1)
  const complete = { ...bound().latest!, id: "build-2" }
  const finished = { ...bound(), latest: complete, lastSuccessful: complete }
  mocks.project.mockResolvedValue({ data: finished })
  mocks.refresh.mockResolvedValue({ data: finished })
  pending.resolve({ data: bound() })
  await tick()
  await vi.advanceTimersByTimeAsync(1500)
  expect(mocks.project.mock.calls.length).toBeGreaterThan(1)
  expect(host.querySelector('[data-component="latex-build-status"]')?.textContent).toBe(dict["latex.state.succeeded"])
  expect(current()).toBe("true")
})

test("successful background reads do not erase a failed binding operation", async () => {
  mount()
  await tick()
  mocks.bind.mockRejectedValueOnce(new Error("Binding changed in another window"))
  button("latex.bind").click()
  await tick()
  button("latex.refresh").click()
  await tick()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Binding changed in another window")
})

test("a superseded scan failure cannot replace a successful retry", async () => {
  const pending = Promise.withResolvers<{ data: LatexProject }>()
  mocks.refresh.mockReturnValueOnce(pending.promise)
  mount()
  await tick()
  button("latex.refresh").click()
  await tick()
  pending.reject(new Error("Old scan failure"))
  await tick()
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(field("main").value).toBe("main.tex")
})

test.each(["server", "directory", "path"] as const)(
  "late responses cannot modify a different %s scope",
  async (key) => {
    const pending = Promise.withResolvers<{ data: LatexProject }>()
    mocks.refresh.mockReturnValueOnce(pending.promise)
    mount()
    await tick()
    mocks.project.mockResolvedValue({ data: project({ root: "second", main: "second.tex" }) })
    mocks.refresh.mockResolvedValue({ data: project({ root: "second", main: "second.tex" }) })
    setState(key, "second")
    await tick()
    pending.reject(new Error("Old server failure"))
    await tick()
    expect(field("root").value).toBe("second")
    expect(field("main").value).toBe("second.tex")
    expect(host.querySelector('[role="alert"]')).toBeNull()
  },
)
