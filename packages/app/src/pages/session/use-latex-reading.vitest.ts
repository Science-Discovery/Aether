import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { LatexProject, LatexVersion } from "@opencode-ai/sdk/v2/client"
import { paper } from "@/utils/pdf-source"
import { useLatexReading } from "./use-latex-reading"

const mocks = vi.hoisted(() => ({
  versions: vi.fn<(input: { root: string }) => Promise<{ data: LatexVersion[] }>>(),
  lease: vi.fn<(input: { id: string; token?: string }) => Promise<{ data: { token: string } }>>(),
  release: vi.fn<() => Promise<void>>(),
  reference: vi.fn(),
  reading: vi.fn(),
  open: vi.fn(),
}))
const [state, setState] = createStore({
  path: paper("paper", "main.tex"),
  active: true,
  dirty: false,
  project: undefined as LatexProject | undefined,
})
vi.mock("@/context/latex", () => ({
  useLatex: () => ({
    state: {
      preview: 0,
      get project() {
        return state.project
      },
    },
    pdf: () => undefined,
    outdated: () => state.dirty,
    reading: mocks.reading,
  }),
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ url: "http://localhost:4096", directory: "/workspace", client: { latex: mocks } }),
}))
vi.mock("./session-layout", () => ({
  useSessionLayout: () => ({
    reading: () => ({ pdfPath: () => state.path, active: () => state.active, open: mocks.open }),
  }),
}))

const version = (id: string, created: number, revision = "source-1"): LatexVersion => ({
  build: {
    id,
    root: "paper",
    main: "main.tex",
    bindingRevision: "binding-1",
    sourceRevision: revision,
    state: "succeeded",
    createdAt: created,
    completedAt: created,
    diagnostics: [],
    log: "",
    truncated: false,
    pdf: true,
  },
  pdfHash: "0".repeat(64),
  annotationCount: 0,
  referenced: false,
  viewing: false,
})
const project = (): LatexProject => ({
  root: "paper",
  main: "main.tex",
  binding: { root: "paper", main: "main.tex", driver: "auto", program: "auto", revision: "binding-1", updatedAt: 1 },
  candidates: ["main.tex"],
  reason: "binding",
  freshness: { state: "fresh", sourceRevision: "source-1", checkedAt: 1 },
  lastSuccessful: version("first", 1).build,
  editors: [],
})
let dispose: VoidFunction | undefined
let reading: ReturnType<typeof useLatexReading>
const mount = () =>
  createRoot((cleanup) => {
    dispose = cleanup
    reading = useLatexReading()
  })
const tick = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  setState({ path: paper("paper", "main.tex"), active: true, dirty: false, project: project() })
  mocks.versions.mockResolvedValue({ data: [version("first", 1)] })
  mocks.lease.mockImplementation(async (input) => ({ data: { token: input.token ?? `lease-${input.id}` } }))
  mocks.release.mockResolvedValue(undefined)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
})

test("a quick replacement updates inline without becoming slow", async () => {
  mount()
  await tick()
  reading.displayed("first")
  mocks.versions.mockResolvedValue({ data: [version("first", 1), version("second", 2)] })
  await reading.refresh()
  expect(reading.updating()).toBe(true)
  expect(reading.slow()).toBe(false)
  expect(mocks.reading).toHaveBeenLastCalledWith({ root: "paper", main: "main.tex", updating: true, outdated: false })
  await vi.advanceTimersByTimeAsync(1000)
  reading.displayed("second")
  await vi.advanceTimersByTimeAsync(2000)
  expect(reading.updating()).toBe(false)
  expect(reading.slow()).toBe(false)
})

test("a replacement waiting for two seconds exposes details until it is displayed", async () => {
  mount()
  await tick()
  await vi.advanceTimersByTimeAsync(1999)
  expect(reading.slow()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(reading.slow()).toBe(true)
  reading.displayed("first")
  expect(reading.updating()).toBe(false)
  expect(reading.slow()).toBe(false)
})

test("changing a target restarts the wait and closing the reader cancels it", async () => {
  mocks.versions.mockResolvedValue({ data: [version("first", 1), version("second", 2)] })
  mount()
  await tick()
  await vi.advanceTimersByTimeAsync(1500)
  reading.select("first")
  await vi.advanceTimersByTimeAsync(1500)
  expect(reading.slow()).toBe(false)
  await vi.advanceTimersByTimeAsync(500)
  expect(reading.slow()).toBe(true)
  setState("active", false)
  expect(reading.slow()).toBe(false)
  await vi.advanceTimersByTimeAsync(2500)
  expect(reading.slow()).toBe(false)
  expect(mocks.reading).toHaveBeenLastCalledWith({ root: "", main: "", updating: false, outdated: false })
})

test("switching projects and disposing clear pending wait state", async () => {
  mount()
  await tick()
  await vi.advanceTimersByTimeAsync(1500)
  const next = version("other", 3)
  mocks.versions.mockResolvedValue({ data: [{ ...next, build: { ...next.build, root: "other" } }] })
  setState("path", paper("other", "main.tex"))
  await tick()
  await vi.advanceTimersByTimeAsync(1500)
  expect(reading.slow()).toBe(false)
  dispose?.()
  dispose = undefined
  await vi.advanceTimersByTimeAsync(3000)
  expect(reading.slow()).toBe(false)
  expect(mocks.reading).toHaveBeenLastCalledWith({ root: "", main: "", updating: false, outdated: false })
})

test("rebuilding the same source does not mark the existing PDF as outdated", async () => {
  mocks.versions.mockResolvedValue({ data: [version("first", 1), version("second", 2)] })
  mount()
  await tick()
  reading.displayed("first")
  expect(reading.updating()).toBe(true)
  expect(reading.outdated()).toBe(false)
  reading.select("first")
  expect(reading.updating()).toBe(false)
  expect(reading.outdated()).toBe(false)
})

test("source changes remain outdated before the version list catches up", async () => {
  mount()
  await tick()
  reading.displayed("first")
  setState("dirty", true)
  expect(reading.outdated()).toBe(true)
  setState("project", "freshness", "sourceRevision", "source-2")
  setState("project", "lastSuccessful", version("second", 2, "source-2").build)
  setState("dirty", false)
  expect(reading.state.versions).toHaveLength(1)
  expect(reading.outdated()).toBe(true)
  mocks.versions.mockResolvedValue({ data: [version("first", 1), version("second", 2, "source-2")] })
  await reading.refresh()
  reading.displayed("second")
  expect(reading.outdated()).toBe(false)
})

test("historical source or compiler settings differ even when the reader is on another project", async () => {
  setState("project", undefined)
  const latest = version("second", 2, "source-2")
  mocks.versions.mockResolvedValue({ data: [version("first", 1), latest] })
  mount()
  await tick()
  reading.select("first")
  reading.displayed("first")
  expect(reading.outdated()).toBe(true)
  mocks.versions.mockResolvedValue({
    data: [
      version("first", 1),
      { ...latest, build: { ...latest.build, sourceRevision: "source-1", bindingRevision: "binding-2" } },
    ],
  })
  await reading.refresh()
  expect(reading.outdated()).toBe(true)
})

test("different builds with missing source revisions remain conservatively outdated", async () => {
  const latest = version("second", 2)
  delete latest.build.sourceRevision
  mocks.versions.mockResolvedValue({ data: [version("first", 1), latest] })
  mount()
  await tick()
  reading.displayed("first")
  expect(reading.outdated()).toBe(true)
})
