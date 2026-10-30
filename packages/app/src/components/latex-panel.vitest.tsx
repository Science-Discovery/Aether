import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import type { LatexBuild, LatexProject, LatexStatus } from "@opencode-ai/sdk/v2"
import { dict } from "@/i18n/en"
import { LatexPanel } from "./latex-panel"
import { LatexProvider, useLatex } from "@/context/latex"
import { checksum } from "@opencode-ai/util/encode"
import type { LatexDraft } from "./latex-drafts"

const mocks = vi.hoisted(() => ({
  project: vi.fn<(input: { root?: string; path?: string }) => Promise<{ data: LatexProject }>>(),
  refresh: vi.fn<(input: { root: string; editors: string[] }) => Promise<{ data: LatexProject }>>(),
  status: vi.fn<() => Promise<{ data: LatexStatus }>>(),
  bind: vi.fn<() => Promise<{ data: LatexProject }>>(),
  build: vi.fn<() => Promise<{ data: LatexBuild }>>(),
  stop: vi.fn(),
  write: vi.fn<(input: { path: string; content: string; expectedChecksum?: string }) => Promise<unknown>>(),
}))
const [buffer, setBuffer] = createStore({ drafts: [] as LatexDraft[], disk: {} as Record<string, string> })
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
    client: { latex: mocks, file: { write: mocks.write } },
    event: { on: () => mocks.stop },
  }),
}))
vi.mock("@/context/file", () => ({
  useFile: () => ({
    drafts: () => buffer.drafts,
    ready: () => true,
    draft: (path: string) => buffer.drafts.find((draft) => draft.path === path)?.content,
    draftBase: (path: string) => buffer.drafts.find((draft) => draft.path === path)?.base,
    setDraft: (path: string, content: string) =>
      setBuffer("drafts", (draft) => draft.path === path, "content", content),
    setDraftBase: (path: string, base: string) => setBuffer("drafts", (draft) => draft.path === path, "base", base),
    load: async () => undefined,
    get: (path: string) => ({ content: { type: "text", content: buffer.disk[path] ?? "" } }),
    capture: () => ({
      drafts: () => buffer.drafts,
      saved: (path: string, content: string) =>
        setBuffer("drafts", (draft) => draft.path === path, "base", checksum(content) ?? ""),
    }),
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
    lastSuccessful: { ...build },
  })
}
let host: HTMLDivElement
let dispose: VoidFunction | undefined
let latex: ReturnType<typeof useLatex>
const Probe = () => {
  latex = useLatex()
  return null
}
const mount = () => {
  dispose = render(
    () => (
      <LatexProvider>
        <Probe />
        <LatexPanel enabled active={state.active} path={state.path} onNavigate={() => undefined}>
          <div>Source editor</div>
        </LatexPanel>
      </LatexProvider>
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
  setBuffer({ drafts: [], disk: {} })
  mocks.project.mockResolvedValue({ data: project() })
  mocks.refresh.mockResolvedValue({ data: project() })
  mocks.status.mockResolvedValue({ data: { tools: [{ driver: "tectonic", installed: true }] } })
  mocks.bind.mockResolvedValue({ data: project() })
  mocks.write.mockImplementation(async (input) => {
    setBuffer("disk", input.path, input.content)
  })
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
  expect(latex.pdf()?.build.id).toBe("build-1")
  expect(host.querySelector('[data-testid="pdf"]')).toBeNull()
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

test("refocusing checks files silently and only marks a confirmed revision change outdated", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  latex.automatic(false)
  const pending = Promise.withResolvers<{ data: LatexProject }>()
  mocks.refresh.mockReturnValueOnce(pending.promise)
  window.dispatchEvent(new Event("focus"))
  await tick()
  expect(latex.state.scanning).toBe(true)
  expect(latex.current()).toBe(false)
  expect(latex.verified()).toBe(true)
  expect(latex.outdated()).toBe(false)
  expect(host.querySelector('[data-component="latex-preview-status"]')?.textContent).toBe(dict["latex.current"])
  pending.resolve({ data: bound() })
  await tick()
  expect(latex.outdated()).toBe(false)
  expect(latex.current()).toBe(true)
  expect(mocks.build).not.toHaveBeenCalled()
  mocks.refresh.mockResolvedValueOnce({
    data: { ...bound(), freshness: { state: "stale", sourceRevision: "source-2" } },
  })
  window.dispatchEvent(new Event("focus"))
  await tick()
  expect(latex.outdated()).toBe(true)
  expect(latex.verified()).toBe(false)
})

test("folding hides setup controls while keeping save, status and the editor available", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mocks.build.mockResolvedValue({ data: { ...bound().latest!, id: "build-2", state: "running" } })
  mount()
  await tick()
  button("latex.collapse").click()
  expect(latex.state.collapsed).toBe(true)
  expect(host.querySelector<HTMLElement>('[data-component="latex-toolbar-details"]')?.hidden).toBe(true)
  expect(button("latex.refresh")).toBeUndefined()
  expect(host.querySelector('[data-component="latex-compact-status"]')?.textContent).toContain(dict["latex.saved"])
  expect(host.textContent).toContain("Source editor")
  button("latex.compile").click()
  await tick()
  expect(mocks.build).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[data-component="latex-compact-status"]')?.textContent).toContain(
    dict["latex.state.running"],
  )
  button("latex.expand").click()
  expect(host.querySelector<HTMLElement>('[data-component="latex-toolbar-details"]')?.hidden).toBe(false)
  expect(button("latex.refresh")).toBeDefined()
})

test("folding retains its state across source tabs and does not stop autosave", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  latex.collapse(true)
  setBuffer("drafts", [{ path: "main.tex", content: "edit while folded", base: "" }])
  expect(host.querySelector('[data-component="latex-compact-status"]')?.textContent).toContain("1")
  setState("path", "references.bib")
  await vi.advanceTimersByTimeAsync(1000)
  expect(latex.state.collapsed).toBe(true)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  expect(latex.pending()).toHaveLength(0)
})

test("a new unbound project expands its required configuration", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  latex.collapse(true)
  mocks.project.mockResolvedValue({ data: project({ root: "new" }) })
  mocks.refresh.mockResolvedValue({ data: project({ root: "new" }) })
  await latex.open("new/main.tex", "new")
  expect(latex.state.collapsed).toBe(false)
  expect(field("main")).not.toBeNull()
})

test("folded controls keep save conflicts and their resolution entry visible", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mocks.write.mockRejectedValueOnce(new Error("File changed on disk"))
  mount()
  await tick()
  latex.collapse(true)
  setBuffer("drafts", [{ path: "main.tex", content: "local changes", base: "" }])
  await vi.advanceTimersByTimeAsync(1000)
  expect(latex.state.collapsed).toBe(true)
  const alert = host.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain("main.tex")
  expect(alert?.closest("[hidden]")).toBeNull()
  const compare = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(dict["latex.compare"]))
  expect(compare).toBeDefined()
  expect(compare?.closest("[hidden]")).toBeNull()
  expect(host.querySelector('[data-component="latex-compact-status"]')?.textContent).toContain(dict["latex.paused"])
})

test("a failed background check is unverified, not evidence of modified source", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  latex.automatic(false)
  mocks.refresh.mockRejectedValueOnce(new Error("Cannot check files"))
  await latex.refresh()
  expect(latex.current()).toBe(false)
  expect(latex.verified()).toBe(false)
  expect(latex.outdated()).toBe(false)
  expect(latex.state.loadError).toContain("Cannot check files")
})

test("manual mode keeps drafts until save and compile is explicitly requested", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mocks.build.mockResolvedValue({ data: { ...bound().latest!, id: "build-2", state: "running" } })
  mount()
  await tick()
  setBuffer("drafts", [{ path: "main.tex", content: "manual draft", base: "" }])
  latex.automatic(false)
  await vi.advanceTimersByTimeAsync(2000)
  window.dispatchEvent(new Event("focus"))
  await vi.advanceTimersByTimeAsync(2000)
  expect(mocks.write).not.toHaveBeenCalled()
  expect(mocks.build).not.toHaveBeenCalled()
  expect(latex.outdated()).toBe(true)
  button("latex.compile").click()
  await tick()
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
    { path: "main.tex", content: "manual draft", expectedChecksum: "" },
    { throwOnError: true },
  )
  expect(mocks.build).toHaveBeenCalledTimes(1)
  expect(latex.pending()).toHaveLength(0)
})

test("re-enabling automatic mode saves drafts after the typing delay", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  latex.automatic(false)
  setBuffer("drafts", [{ path: "main.tex", content: "draft", base: "" }])
  await vi.advanceTimersByTimeAsync(2000)
  expect(mocks.write).not.toHaveBeenCalled()
  latex.automatic(true)
  await vi.advanceTimersByTimeAsync(999)
  expect(mocks.write).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.write).toHaveBeenCalledTimes(1)
})

test("manual save compiles its saved revision while later typing stays unsaved", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  const pending = Promise.withResolvers<unknown>()
  mocks.write.mockReturnValueOnce(pending.promise)
  mocks.build.mockResolvedValue({ data: { ...bound().latest!, id: "build-2", state: "running" } })
  mount()
  await tick()
  latex.automatic(false)
  setBuffer("drafts", [{ path: "main.tex", content: "saved version", base: "" }])
  const request = latex.compile()
  setBuffer("drafts", 0, "content", "newer draft")
  mocks.refresh.mockResolvedValue({
    data: {
      ...bound(),
      freshness: { state: "stale", sourceRevision: "source-2" },
      editors: [{ path: "main.tex", checksum: checksum("saved version")! }],
    },
  })
  pending.resolve(undefined)
  await request
  await vi.advanceTimersByTimeAsync(2000)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  expect(mocks.build).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceRevision: "source-2" }), {
    throwOnError: true,
  })
  expect(latex.pending()[0].content).toBe("newer draft")
  expect(latex.pending()[0].base).toBe(checksum("saved version"))
})

test("turning off automation during a save retains newer typing without another write", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  const pending = Promise.withResolvers<unknown>()
  mocks.write.mockReturnValueOnce(pending.promise)
  mount()
  await tick()
  setBuffer("drafts", [{ path: "main.tex", content: "first", base: "" }])
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  latex.automatic(false)
  setBuffer("drafts", 0, "content", "newer")
  pending.resolve(undefined)
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  expect(latex.pending()[0].content).toBe("newer")
  expect(latex.pending()[0].base).toBe(checksum("first"))
  expect(mocks.build).not.toHaveBeenCalled()
})

test("manual project switching retains unsaved drafts without writing them", async () => {
  const first = { ...bound(), root: "first", binding: { ...bound().binding!, root: "first" } }
  const second = { ...bound(), root: "second", binding: { ...bound().binding!, root: "second" } }
  setState("path", "first/main.tex")
  mocks.project.mockImplementation(async (input) => ({ data: input.path?.startsWith("second/") ? second : first }))
  mocks.refresh.mockImplementation(async (input) => ({ data: input.root === "second" ? second : first }))
  mount()
  await tick()
  latex.automatic(false)
  setBuffer("drafts", [{ path: "first/main.tex", content: "unsaved", base: "" }])
  setState("path", "second/main.tex")
  await vi.advanceTimersByTimeAsync(2000)
  expect(latex.state.project?.root).toBe("second")
  setState("path", "first/main.tex")
  await tick()
  expect(latex.pending()[0].content).toBe("unsaved")
  expect(latex.pending()[0].base).toBe("")
  expect(mocks.write).not.toHaveBeenCalled()
})

test("disabling automation releases a project switch blocked by conflicting drafts", async () => {
  const first = {
    ...bound(),
    root: "first",
    binding: { ...bound().binding!, root: "first" },
    editors: [{ path: "first/main.tex", checksum: checksum("external")! }],
  }
  const second = { ...bound(), root: "second", binding: { ...bound().binding!, root: "second" } }
  setState("path", "first/main.tex")
  mocks.project.mockImplementation(async (input) => ({ data: input.path?.startsWith("second/") ? second : first }))
  mocks.refresh.mockImplementation(async (input) => ({ data: input.root === "second" ? second : first }))
  mount()
  await tick()
  setBuffer("drafts", [{ path: "first/main.tex", content: "unsaved", base: "" }])
  expect(latex.conflicts()).toHaveLength(1)
  setState("path", "second/main.tex")
  await tick()
  expect(latex.state.project?.root).toBe("first")
  latex.automatic(false)
  await tick()
  expect(latex.state.project?.root).toBe("second")
  expect(buffer.drafts[0].content).toBe("unsaved")
  expect(mocks.write).not.toHaveBeenCalled()
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

test.each(["server", "directory"] as const)("late responses cannot modify a different %s scope", async (key) => {
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
})

test("autosave waits for a typing pause and IME completion across source tabs", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  setBuffer("drafts", [
    { path: "main.tex", content: "初", base: "" },
    { path: "notes.md", content: "private draft", base: "" },
  ])
  latex.composing("main.tex", true)
  await vi.advanceTimersByTimeAsync(2000)
  expect(mocks.write).not.toHaveBeenCalled()
  setBuffer("drafts", 0, "content", "初稿")
  latex.composing("main.tex", false)
  await vi.advanceTimersByTimeAsync(999)
  expect(mocks.write).not.toHaveBeenCalled()
  setState("path", "refs.bib")
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
    { path: "main.tex", content: "初稿", expectedChecksum: "" },
    { throwOnError: true },
  )
  expect(buffer.drafts[0].base).toBe(checksum("初稿"))
  expect(buffer.drafts[1].base).toBe("")
  expect(latex.state.path).toBe("refs.bib")
  expect(mocks.build).not.toHaveBeenCalled()
})

test("new input during an in-flight save stays dirty and is saved in the next pass", async () => {
  const original = "before"
  setBuffer("disk", "main.tex", original)
  const project = () => ({
    ...bound(),
    editors: [{ path: "main.tex", checksum: checksum(buffer.disk["main.tex"]) ?? "" }],
  })
  mocks.project.mockImplementation(async () => ({ data: project() }))
  mocks.refresh.mockImplementation(async () => ({ data: project() }))
  const write = Promise.withResolvers<unknown>()
  mocks.write.mockReturnValueOnce(write.promise)
  mount()
  await tick()
  setBuffer("drafts", [{ path: "main.tex", content: "first", base: checksum(original) }])
  await vi.advanceTimersByTimeAsync(1000)
  setBuffer("drafts", 0, "content", "latest")
  setBuffer("disk", "main.tex", "first")
  write.resolve(undefined)
  await tick()
  expect(buffer.drafts[0].base).toBe(checksum("first"))
  expect(latex.pending()[0].content).toBe("latest")
  expect(latex.state.project?.editors[0].checksum).toBe(checksum("first"))
  expect(latex.conflicts()).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.write).toHaveBeenCalledTimes(2)
  expect(mocks.write).toHaveBeenLastCalledWith(
    { path: "main.tex", content: "latest", expectedChecksum: checksum("first") },
    { throwOnError: true },
  )
  expect(buffer.drafts[0].base).toBe(checksum("latest"))
})

test("a running build only queues the latest saved source revision", async () => {
  let disk = bound()
  mocks.project.mockImplementation(async () => ({ data: structuredClone(disk) }))
  mocks.refresh.mockImplementation(async () => ({ data: structuredClone(disk) }))
  mocks.write.mockImplementation(async (input) => {
    setBuffer("disk", input.path, input.content)
    disk = { ...disk, freshness: { state: "fresh", sourceRevision: input.content } }
  })
  mocks.build.mockImplementation(async () => {
    const build = {
      ...disk.latest!,
      id: `build-${mocks.build.mock.calls.length + 1}`,
      state: "running" as const,
      sourceRevision: disk.freshness.sourceRevision,
    }
    disk = { ...disk, latest: build }
    return { data: build }
  })
  mount()
  await tick()
  setBuffer("drafts", [{ path: "main.tex", content: "v2", base: "" }])
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.build).toHaveBeenCalledTimes(1)
  setBuffer("drafts", 0, "content", "v3")
  await vi.advanceTimersByTimeAsync(1000)
  setBuffer("drafts", 0, "content", "v4")
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.build).toHaveBeenCalledTimes(1)
  expect(latex.state.queued).toBe(true)
  disk = { ...disk, latest: { ...disk.latest!, state: "succeeded" } }
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.build).toHaveBeenCalledTimes(2)
  expect(mocks.build).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceRevision: "v4", allowDownloads: false }),
    { throwOnError: true },
  )
})

test("a completed build reaches the preview within one short poll and stops polling", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mocks.build.mockResolvedValue({ data: { ...bound().latest!, id: "build-2", state: "running" } })
  mount()
  await tick()
  latex.automatic(false)
  await vi.advanceTimersByTimeAsync(1000)
  await latex.compile()
  expect(latex.pdf()?.build.id).toBe("build-1")
  const build = { ...bound().latest!, id: "build-2" }
  mocks.project.mockResolvedValue({ data: { ...bound(), latest: build, lastSuccessful: build } })
  mocks.refresh.mockResolvedValue({ data: { ...bound(), latest: build, lastSuccessful: build } })
  await vi.advanceTimersByTimeAsync(500)
  expect(latex.pdf()?.build.id).toBe("build-2")
  expect(latex.running()).toBe(false)
  const calls = mocks.project.mock.calls.length
  await vi.advanceTimersByTimeAsync(2000)
  expect(mocks.project).toHaveBeenCalledTimes(calls)
})

test("slow build status requests do not overlap or discard the completed result", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mocks.build.mockResolvedValue({ data: { ...bound().latest!, id: "build-2", state: "running" } })
  mount()
  await tick()
  latex.automatic(false)
  await vi.advanceTimersByTimeAsync(1000)
  await latex.compile()
  const pending = Promise.withResolvers<{ data: LatexProject }>()
  const calls = mocks.project.mock.calls.length
  mocks.project.mockReturnValueOnce(pending.promise)
  await vi.advanceTimersByTimeAsync(2000)
  expect(mocks.project).toHaveBeenCalledTimes(calls + 1)
  const build = { ...bound().latest!, id: "build-2" }
  const project = { ...bound(), latest: build, lastSuccessful: build }
  mocks.project.mockResolvedValue({ data: project })
  mocks.refresh.mockResolvedValue({ data: project })
  pending.resolve({ data: project })
  await tick()
  expect(latex.pdf()?.build.id).toBe("build-2")
  expect(latex.running()).toBe(false)
})

test("conflicts pause autosave and compare resolution uses the displayed disk checksum", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mocks.write.mockRejectedValueOnce({
    error: "conflict",
    currentChecksum: checksum("external"),
    currentContent: "external",
  })
  mount()
  await tick()
  setBuffer({ drafts: [{ path: "main.tex", content: "my draft", base: "" }], disk: { "main.tex": "external" } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(latex.conflicts()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  const snapshot = await latex.compare("main.tex")
  expect(snapshot?.disk).toBe("external")
  expect(await latex.resolve(snapshot!, "draft")).toBe(true)
  expect(mocks.write).toHaveBeenLastCalledWith(
    { path: "main.tex", content: "my draft", expectedChecksum: checksum("external") },
    { throwOnError: true },
  )
  expect(latex.conflicts()).toHaveLength(0)
})

test("an external edit cannot be discarded after the comparison becomes stale", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  latex.automatic(false)
  setBuffer({ drafts: [{ path: "main.tex", content: "my draft", base: "" }], disk: { "main.tex": "external" } })
  const snapshot = await latex.compare("main.tex")
  setBuffer("disk", "main.tex", "newer external")
  expect(await latex.resolve(snapshot!, "disk")).toBe(false)
  expect(buffer.drafts[0].content).toBe("my draft")
  expect(mocks.write).not.toHaveBeenCalled()
})

test("switching project folders flushes the previous draft before discovery", async () => {
  const first = { ...bound(), root: "first", binding: { ...bound().binding!, root: "first" } }
  setState("path", "first/main.tex")
  mocks.project.mockResolvedValue({ data: first })
  mocks.refresh.mockResolvedValue({ data: first })
  mount()
  await tick()
  setBuffer("drafts", [{ path: "first/main.tex", content: "unsaved", base: "" }])
  const saved = Promise.withResolvers<unknown>()
  mocks.write.mockReturnValueOnce(saved.promise)
  setState("path", "second/main.tex")
  await tick()
  expect(mocks.project).toHaveBeenCalledTimes(1)
  mocks.project.mockResolvedValue({ data: project({ root: "second", main: "main.tex" }) })
  saved.resolve(undefined)
  await tick()
  expect(buffer.drafts[0].base).toBe(checksum("unsaved"))
  expect(mocks.project).toHaveBeenLastCalledWith({ path: "second/main.tex", root: undefined }, { throwOnError: true })
})

test("new edits recover from a compiler start error without repeated automatic retries", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: { ...bound(), freshness: { state: "fresh", sourceRevision: "v2" } } })
  mocks.build.mockRejectedValueOnce(new Error("Compiler could not start"))
  mount()
  await tick()
  await vi.advanceTimersByTimeAsync(1000)
  expect(latex.state.error).toContain("Compiler could not start")
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.build).toHaveBeenCalledTimes(1)
  mocks.refresh.mockResolvedValue({ data: { ...bound(), freshness: { state: "fresh", sourceRevision: "v3" } } })
  mocks.build.mockResolvedValue({ data: { ...bound().latest!, sourceRevision: "v3", state: "running" } })
  setBuffer("drafts", [{ path: "main.tex", content: "fixed", base: "" }])
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.build).toHaveBeenCalledTimes(2)
  expect(latex.state.error).toBe("")
})

test("PDF identity survives rebuilds without requesting the closed reading pane again", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  const preview = latex.state.preview
  const key = latex.pdf()?.key
  const build = { ...bound().latest!, id: "new-pdf" }
  mocks.project.mockResolvedValue({ data: { ...bound(), latest: build, lastSuccessful: build } })
  mocks.refresh.mockResolvedValue({ data: { ...bound(), latest: build, lastSuccessful: build } })
  await latex.refresh()
  expect(latex.pdf()?.key).toBe(key)
  expect(latex.pdf()?.build.id).toBe("new-pdf")
  expect(latex.state.preview).toBe(preview)
  latex.show()
  expect(latex.state.preview).toBe(preview + 1)
})

test("a comparison opened in another workspace cannot write into the current workspace", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  latex.automatic(false)
  setBuffer({ drafts: [{ path: "main.tex", content: "draft", base: "" }], disk: { "main.tex": "saved" } })
  const snapshot = await latex.compare("main.tex")
  setState("directory", "/other-workspace")
  await tick()
  expect(await latex.resolve(snapshot!, "draft")).toBe(false)
  expect(mocks.write).not.toHaveBeenCalled()
})

test("opening a nested project uses its nearest binding instead of the parent project", async () => {
  const child = { ...bound(), root: "paper", binding: { ...bound().binding!, root: "paper", revision: "child" } }
  mocks.project.mockImplementation(async (input) => ({
    data: input.root === "paper" || input.path?.startsWith("paper/") ? child : bound(),
  }))
  mocks.refresh.mockImplementation(async (input) => ({ data: input.root === "paper" ? child : bound() }))
  mount()
  await tick()
  latex.automatic(false)
  setState("path", "paper/main.tex")
  await tick()
  expect(mocks.project).toHaveBeenCalledWith({ path: "paper/main.tex" }, { throwOnError: true })
  expect(latex.state.project?.root).toBe("paper")
  expect(latex.state.project?.binding?.revision).toBe("child")
  setState("path", "main.tex")
  await tick()
  expect(latex.state.project?.root).toBe(".")
  expect(latex.state.project?.binding?.revision).toBe("binding-1")
})

test("an older nested-project discovery cannot replace the latest selected file", async () => {
  const delayed = Promise.withResolvers<{ data: LatexProject }>()
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mount()
  await tick()
  mocks.project.mockReturnValueOnce(delayed.promise)
  setState("path", "paper/main.tex")
  await tick()
  setState("path", "refs.bib")
  await tick()
  delayed.resolve({
    data: { ...bound(), root: "paper", binding: { ...bound().binding!, root: "paper", revision: "child" } },
  })
  await tick()
  expect(latex.state.path).toBe("refs.bib")
  expect(latex.state.project?.root).toBe(".")
  expect(latex.state.project?.binding?.revision).toBe("binding-1")
})

test("automatic builds do not consume permission intended for an explicit build", async () => {
  mocks.project.mockResolvedValue({ data: bound() })
  mocks.refresh.mockResolvedValue({ data: bound() })
  mocks.build.mockRejectedValue(new Error("Missing packages"))
  mount()
  await tick()
  latex.downloads(true)
  mocks.refresh.mockResolvedValue({ data: { ...bound(), freshness: { state: "fresh", sourceRevision: "changed" } } })
  setBuffer("drafts", [{ path: "main.tex", content: "changed", base: "" }])
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.build).toHaveBeenLastCalledWith(expect.objectContaining({ allowDownloads: false }), {
    throwOnError: true,
  })
  expect(latex.state.downloads).toBe(true)
  await latex.compile()
  expect(mocks.build).toHaveBeenLastCalledWith(expect.objectContaining({ allowDownloads: true }), {
    throwOnError: true,
  })
  expect(latex.state.downloads).toBe(false)
  await latex.compile()
  expect(mocks.build).toHaveBeenLastCalledWith(expect.objectContaining({ allowDownloads: false }), {
    throwOnError: true,
  })
})
