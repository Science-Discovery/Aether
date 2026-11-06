import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { checksum } from "@opencode-ai/util/encode"
import type { LatexBuild } from "@opencode-ai/sdk/v2/client"
import type { LatexDraft } from "@/components/latex-drafts"
import { useLatexNavigation } from "./use-latex-navigation"
import { identity } from "@/utils/pdf-source"

const mocks = vi.hoisted(() => ({
  forward: vi.fn(),
  inverse: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  load: vi.fn(),
  locate: vi.fn(),
  open: vi.fn(),
  activate: vi.fn(),
  reveal: vi.fn(),
  panel: vi.fn(),
}))
const build: LatexBuild = {
  id: "build",
  root: "paper",
  main: "main.tex",
  bindingRevision: "binding",
  sourceRevision: "source",
  state: "succeeded",
  createdAt: 1,
  diagnostics: [],
  log: "",
  truncated: false,
  pdf: true,
  sync: { state: "ready" },
}
const document = identity("http://localhost", "/workspace", "paper", "main.tex")
const [state, setState] = createStore({
  path: "paper/main.tex",
  drafts: [] as LatexDraft[],
  displayed: "build",
  target: "build",
  document,
  changed: false,
  available: true,
  content: "Text",
  versions: [{ build }],
})
vi.mock("@/context/latex", () => ({
  useLatex: () => ({
    state: {
      get path() {
        return state.path
      },
      root: "paper",
      main: "main.tex",
      driver: "auto",
      program: "auto",
      composing: [],
      locating: { path: "", nonce: 0 },
      get project() {
        return {
          root: "paper",
          binding: { main: "main.tex", revision: "binding" },
          lastSuccessful: state.versions[0]?.build,
        }
      },
    },
    changed: () => state.changed,
    conflicts: () => [],
  }),
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "http://localhost",
    directory: "/workspace",
    client: { latex: mocks },
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: mocks.toast }))
vi.mock("@/context/file", () => ({
  useFile: () => ({
    drafts: () => state.drafts,
    load: mocks.load,
    locate: mocks.locate,
    reveal: mocks.reveal,
    get: () => ({ content: { type: "text", content: state.content } }),
    draft: (path: string) => state.drafts.find((draft) => draft.path === path)?.content,
    tab: (path: string) => `file://${path}`,
  }),
}))
vi.mock("./session-layout", () => ({
  useSessionLayout: () => ({
    reading: () => ({ open: mocks.open }),
    view: () => ({ reviewPanel: { open: mocks.panel } }),
    tabs: () => ({ open: mocks.open, setActive: mocks.activate }),
  }),
}))

let dispose: VoidFunction | undefined
let navigation: ReturnType<typeof useLatexNavigation>
const mount = () =>
  createRoot((cleanup) => {
    dispose = cleanup
    navigation = useLatexNavigation({
      key: () => state.document,
      document: () => (state.document ? { kind: "latex", root: "paper", main: "main.tex" } : undefined),
      target: () => state.target,
      updating: () => state.target !== state.displayed,
      state: {
        get versions() {
          return state.versions.map((item) => ({
            ...item,
            pdfHash: "hash",
            annotationCount: 0,
            referenced: false,
            viewing: true,
          }))
        },
        get displayed() {
          return state.displayed
        },
      },
    })
  })
beforeEach(() => {
  vi.resetAllMocks()
  setState({
    path: "paper/main.tex",
    drafts: [],
    displayed: "build",
    target: "build",
    document,
    changed: false,
    content: "Text",
    versions: [{ build: { ...build } }],
  })
  mocks.refresh.mockResolvedValue({
    data: { binding: { revision: "binding" }, freshness: { sourceRevision: "source" }, editors: [] },
  })
  mocks.forward.mockResolvedValue({ data: { page: 2, rect: [1, 2, 30, 40] } })
  mocks.inverse.mockResolvedValue({ data: { path: "paper/chapter.tex", line: 8, column: 2 } })
  mocks.load.mockResolvedValue(undefined)
})
afterEach(() => dispose?.())

test("forward navigation uses the displayed build and repeated requests get distinct IDs", async () => {
  mount()
  await navigation.forward({ path: "paper/main.tex", line: 5, column: 3 })
  expect(mocks.forward).toHaveBeenCalledWith(
    { id: "build", path: "paper/main.tex", line: 5, column: 3 },
    { throwOnError: true },
  )
  const first = navigation.reveal()
  expect(first).toMatchObject({ document, version: "build", page: 2, rect: [1, 2, 30, 40] })
  await navigation.forward({ path: "paper/main.tex", line: 5, column: 3 })
  expect(navigation.reveal()?.id).not.toBe(first?.id)
  expect(mocks.open).not.toHaveBeenCalled()
})

test("dirty or stale clean editor buffers require a compile without moving the view", async () => {
  mount()
  setState("drafts", [{ path: "paper/main.tex", content: "Draft", base: checksum("Text") }])
  await navigation.forward({ path: "paper/main.tex", line: 1, column: 1 })
  expect(mocks.refresh).not.toHaveBeenCalled()
  setState("drafts", [{ path: "paper/main.tex", content: "Text", base: checksum("Text") }])
  mocks.refresh.mockResolvedValue({
    data: {
      binding: { revision: "binding" },
      freshness: { sourceRevision: "source" },
      editors: [{ path: "paper/main.tex", checksum: checksum("Changed externally") }],
    },
  })
  await navigation.forward({ path: "paper/main.tex", line: 1, column: 1 })
  expect(mocks.forward).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "latex.sync.stale" }))
  expect(mocks.open).not.toHaveBeenCalled()
})

test("typing or switching builds during a query discards late forward responses", async () => {
  let finish!: (value: { data: { page: number; rect: number[] } }) => void
  mocks.forward.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  mount()
  const pending = navigation.forward({ path: "paper/main.tex", line: 2, column: 1 })
  await vi.waitFor(() => expect(mocks.forward).toHaveBeenCalled())
  setState("drafts", [{ path: "paper/main.tex", content: "New", base: checksum("Text") }])
  finish({ data: { page: 1, rect: [1, 2, 3, 4] } })
  await pending
  expect(navigation.reveal()).toBeUndefined()
  expect(mocks.open).not.toHaveBeenCalled()
})

test("inverse navigation opens the mapped file and preserves ordinary editor state", async () => {
  mount()
  await navigation.inverse({ document, version: "build", page: 1, x: 10, y: 20 })
  expect(mocks.inverse).toHaveBeenCalledWith({ id: "build", page: 1, x: 10, y: 20 }, { throwOnError: true })
  expect(mocks.load).toHaveBeenCalledWith("paper/chapter.tex", { force: true })
  expect(mocks.activate).toHaveBeenCalledWith("file://paper/chapter.tex")
  expect(mocks.locate).toHaveBeenCalledWith("paper/chapter.tex", 8, 2)
})

test("inverse events from another build or stale project never change the editor", async () => {
  mount()
  await navigation.inverse({ document, version: "previous", page: 1, x: 10, y: 20 })
  expect(mocks.inverse).not.toHaveBeenCalled()
  mocks.refresh.mockResolvedValue({
    data: { binding: { revision: "other" }, freshness: { sourceRevision: "source" }, editors: [] },
  })
  await navigation.inverse({ document, version: "build", page: 1, x: 10, y: 20 })
  expect(mocks.inverse).not.toHaveBeenCalled()
  expect(mocks.locate).not.toHaveBeenCalled()
})

test("inverse responses are discarded if the displayed PDF changes during file loading", async () => {
  mocks.load.mockImplementation(async () => {
    setState("displayed", "new")
  })
  mount()
  await navigation.inverse({ document, version: "build", page: 1, x: 10, y: 20 })
  expect(mocks.load).toHaveBeenCalled()
  expect(mocks.locate).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
})

test("older builds without mapping report unavailable instead of opening a different version", async () => {
  setState("versions", [{ build: { ...build, sync: undefined } }])
  mount()
  await navigation.forward({ path: "paper/main.tex", line: 1, column: 1 })
  expect(mocks.forward).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "latex.sync.unavailable" }))
})

test("missing published mapping reports unavailable rather than claiming the source changed", async () => {
  mount()
  mocks.forward.mockRejectedValue({
    status: 409,
    message: "The source mapping is unavailable. Compile again before locating.",
  })
  await navigation.forward({ path: "paper/main.tex", line: 1, column: 1 })
  expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "latex.sync.unavailable" }))
  expect(navigation.reveal()).toBeUndefined()
  expect(mocks.open).not.toHaveBeenCalled()
})

test("a busy reader prevents forward navigation before any project or PDF is switched", async () => {
  mount()
  navigation.busy(true)
  await navigation.forward({ path: "paper/main.tex", line: 1, column: 1 })
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "latex.sync.busy" }))
})

test("a pending replacement reports busy instead of silently losing a forward result", async () => {
  mount()
  setState("target", "next")
  await navigation.forward({ path: "paper/main.tex", line: 1, column: 1 })
  expect(mocks.forward).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "latex.sync.busy" }))
})

test("external changes during inverse source loading invalidate the jump", async () => {
  mount()
  mocks.load.mockImplementation(async () => {
    mocks.refresh.mockResolvedValue({
      data: { binding: { revision: "binding" }, freshness: { sourceRevision: "changed" }, editors: [] },
    })
  })
  await navigation.inverse({ document, version: "build", page: 1, x: 10, y: 20 })
  expect(mocks.locate).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "latex.sync.stale" }))
})
