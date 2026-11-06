import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { paper } from "@/utils/pdf-source"
import { useQuickReadingController } from "./use-quick-reading-controller"

const mocks = vi.hoisted(() => ({
  reference: vi.fn(),
  create: vi.fn(),
  navigate: vi.fn(),
  add: vi.fn(),
  send: vi.fn(),
  toast: vi.fn(),
}))
const [state, setState] = createStore({
  dir: "workspace",
  id: "session" as string | undefined,
  directory: "/workspace",
  url: "http://localhost:4096",
  path: paper("paper", "main.tex"),
  document: "document",
  pages: 4,
  model: "original",
  native: false,
  settings: { questionPrompt: "Original question prompt", translatePrompt: "Original translation prompt" },
})
const quote = { root: "paper", main: "main.tex", build: "build", hash: "a".repeat(64) }
const client = { session: { create: mocks.create } }
vi.mock("@solidjs/router", () => ({ useNavigate: () => mocks.navigate }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show() {} }) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: mocks.toast }))
vi.mock("@/components/quick-reading/dialog-quick-reading-settings", () => ({ DialogQuickReadingSettings: () => null }))
vi.mock("@/components/prompt-input/submit", () => ({ sendFollowupDraft: mocks.send }))
vi.mock("@/context/prompt", () => ({ DEFAULT_PROMPT: [], usePrompt: () => ({ references: { add: mocks.add } }) }))
vi.mock("@/context/global-sync", () => ({ useGlobalSync: () => ({}) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/latex", () => ({
  useLatex: () => ({
    state: { realtime: false },
    edit: vi.fn(),
    bind: vi.fn(async () => undefined),
    compileVersion: vi.fn(async () => true),
  }),
}))
vi.mock("@/context/local", () => ({
  useLocal: () => ({
    selection: () => ({
      agent: "build",
      model: { providerID: "test", modelID: state.model },
      engine: state.native ? { type: "codex", model: state.model } : undefined,
    }),
    native: { engine: () => undefined },
  }),
}))
vi.mock("@/context/quick-reading-mode", () => ({
  useQuickReadingMode: () => ({
    store: {
      get binding() {
        return { sessionID: state.id ?? "", pdfPath: state.path, pdfFileName: "paper.pdf" }
      },
      snapshot: {
        get settings() {
          return state.settings
        },
        get totalPages() {
          return state.pages
        },
        layoutSwapped: false,
      },
      view: { page: 1, location: "" },
    },
    bind() {},
    unbind() {},
  }),
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get url() {
      return state.url
    },
    get directory() {
      return state.directory
    },
    client,
  }),
}))
vi.mock("@/context/server", () => ({ useServer: () => ({ current: { http: { url: "http://localhost:4096" } } }) }))
vi.mock("@/context/sync", () => ({ useSync: () => ({}) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({}) }))
vi.mock("./session-layout", () => ({
  useSessionLayout: () => ({
    params: state,
    view: () => ({ reviewPanel: { opened: () => true } }),
    reading: () => ({ pdfPath: () => state.path, pdfFileName: () => "paper.pdf", active: () => true }),
  }),
}))
vi.mock("./use-latex-reading", () => ({
  useLatexReading: () => ({
    document: () => ({ root: "paper", main: "main.tex" }),
    key: () => state.document,
    capture: () => ({ ...quote }),
    url: () => "http://localhost:4096/latex/build/build/pdf",
    reference: mocks.reference,
    state: { ready: "build" },
  }),
}))
vi.mock("./use-latex-navigation", () => ({ useLatexNavigation: () => ({}) }))

let dispose: VoidFunction | undefined
const mount = () =>
  createRoot((cleanup) => {
    dispose = cleanup
    return useQuickReadingController({})
  })
const input = {
  action: "ask" as const,
  startPage: 1,
  endPage: 1,
  text: "Selected text",
  question: "Why?",
  selection: "range",
  document: "document",
  version: "build",
}
beforeEach(() => {
  vi.resetAllMocks()
  setState({
    dir: "workspace",
    id: "session",
    directory: "/workspace",
    url: "http://localhost:4096",
    path: paper("paper", "main.tex"),
    document: "document",
    pages: 4,
    model: "original",
    native: false,
    settings: { questionPrompt: "Original question prompt", translatePrompt: "Original translation prompt" },
  })
  mocks.reference.mockResolvedValue(undefined)
  mocks.send.mockResolvedValue(true)
})
afterEach(() => dispose?.())

test.each(["session", "workspace", "server", "document"])(
  "rejects a pending LaTeX selection after switching %s",
  async (kind) => {
    const pending = Promise.withResolvers<void>()
    mocks.reference.mockReturnValue(pending.promise)
    const controller = mount()
    const action = controller.handleTextSelectionAction(input)
    expect(mocks.reference).toHaveBeenCalledOnce()
    if (kind === "session") setState("id", "other")
    if (kind === "workspace") setState({ dir: "other", directory: "/other" })
    if (kind === "server") setState("url", "https://other.example")
    if (kind === "document") setState({ path: paper("other", "main.tex"), document: "other" })
    pending.resolve()
    await action
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  },
)

test("does not navigate or add a quote when new-session creation finishes after navigation", async () => {
  setState("id", undefined)
  const pending = Promise.withResolvers<{ data: { id: string } }>()
  mocks.create.mockReturnValue(pending.promise)
  const action = mount().handleTextSelectionAction(input)
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
  setState({ id: "other", dir: "other", directory: "/other" })
  pending.resolve({ data: { id: "created" } })
  await action
  expect(mocks.navigate).not.toHaveBeenCalled()
  expect(mocks.add).not.toHaveBeenCalled()
})

test("adds a workspace quote to its created session after navigation completes", async () => {
  setState("id", undefined)
  mocks.create.mockResolvedValue({ data: { id: "created" } })
  mocks.navigate.mockImplementation(() => setState("id", "created"))
  await mount().handleTextSelectionAction(input)
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ source: quote }), {
    dir: "workspace",
    id: "created",
  })
})

test("keeps the selected native engine when a reading quote creates the first session", async () => {
  setState({ id: undefined, native: true })
  mocks.create.mockResolvedValue({ data: { id: "created" } })
  mocks.navigate.mockImplementation(() => setState("id", "created"))
  await mount().handleTextSelectionAction(input)
  expect(mocks.create).toHaveBeenCalledWith({ engine: { type: "codex", model: "original" } }, { throwOnError: true })
})

test("freezes quote settings and page count before pinning its LaTeX source", async () => {
  const pending = Promise.withResolvers<void>()
  mocks.reference.mockReturnValue(pending.promise)
  const action = mount().handleTextSelectionAction(input)
  setState({ pages: 99, settings: { questionPrompt: "New prompt", translatePrompt: "New translation" } })
  pending.resolve()
  await action
  expect(mocks.add).toHaveBeenCalledWith(
    expect.objectContaining({ source: quote, totalPages: 4, settings: { questionPrompt: "Original question prompt" } }),
    { dir: "workspace", id: "session" },
  )
})

test("freezes translation settings and model before pinning its LaTeX source", async () => {
  const pending = Promise.withResolvers<void>()
  mocks.reference.mockReturnValue(pending.promise)
  const action = mount().handleImageSelectionAction({
    action: "translate",
    page: 2,
    imageDataUrl: "data:image/png;base64,AA==",
    document: "document",
    version: "build",
  })
  setState({ model: "new", settings: { questionPrompt: "New prompt", translatePrompt: "New translation" } })
  pending.resolve()
  await action
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      client,
      draft: expect.objectContaining({
        sessionID: "session",
        sessionDirectory: "/workspace",
        model: { providerID: "test", modelID: "original" },
        extraTextParts: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("Original translation prompt") }),
        ]),
      }),
    }),
  )
})
