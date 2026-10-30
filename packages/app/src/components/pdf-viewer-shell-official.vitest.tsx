import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { PdfViewerShell, type PdfReveal } from "./pdf-viewer-shell-official"

vi.mock("@/context/sdk", () => ({ useSDK: () => ({ url: "http://server", directory: "/paper" }) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({}) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))

const requests: Array<{ url: string; init?: RequestInit }> = []
const fetcher = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
const cleanup: Array<() => void> = []
const file = (id: string) => ({
  version: "1.2",
  source: { path: `latex-build:${id}`, fingerprint: id },
  annotations: [],
})
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  requests.length = 0
  fetcher.mockReset()
  fetcher.mockImplementation(async (input, init) => {
    requests.push({ url: input.toString(), init })
    const id = /build\/([^/]+)/.exec(input.toString())?.[1] ?? "file"
    return Response.json({ status: "ready", data: file(id), revision: "r0" })
  })
  vi.stubGlobal("fetch", fetcher)
})

afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function viewer(plain = false) {
  const source = plain
    ? { src: "http://server/paper.pdf", document: undefined, version: undefined }
    : { src: "http://server/latex/build/first/pdf", document: "paper", version: "first" }
  const [state, setState] = createStore({
    ...source,
    reveal: undefined as PdfReveal | undefined,
    enabled: false,
    activity: false,
  })
  const loaded = vi.fn()
  const locate = vi.fn()
  const unavailable = vi.fn()
  const busy = vi.fn()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <PdfViewerShell
        src={state.src}
        document={state.document}
        version={state.version}
        annotationBuild={state.version}
        mode="full"
        onVersionChange={loaded}
        reveal={state.reveal}
        onSourceLocate={state.enabled ? locate : undefined}
        onLocateUnavailable={unavailable}
        onBusyChange={state.activity ? busy : undefined}
      />
    ),
    host,
  )
  const frame = host.querySelector("iframe")!
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message) => {
    // Happy DOM does not enforce the browser's postMessage cloning restrictions.
    structuredClone(message)
  })
  cleanup.push(() => {
    dispose()
    host.remove()
  })
  const send = (type: string, data: Record<string, unknown> = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: window.location.origin,
        data: {
          channel: "aether-pdf-viewer",
          type,
          ...source,
          ...data,
        },
      }),
    )
  send("ready")
  return {
    loaded,
    locate,
    unavailable,
    busy,
    post,
    send,
    show: (id = "first") =>
      send(
        "documentinfo",
        plain
          ? { totalPages: 3, source }
          : {
              totalPages: 3,
              version: id,
              src: `http://server/latex/build/${id}/pdf`,
              source: {
                src: `http://server/latex/build/${id}/pdf`,
                document: "paper",
                version: id,
                annotationBuild: id,
              },
            },
      ),
    next: () => setState({ src: "http://server/latex/build/second/pdf", version: "second" }),
    reveal: (target: PdfReveal) => setState("reveal", target),
    enable: () => setState("enabled", true),
    activity: () => setState("activity", true),
  }
}

test("busy changes follow the loaded source for ordinary PDFs and compiled builds", async () => {
  const plain = viewer(true)
  plain.activity()
  plain.show()
  await tick()
  plain.send("busychange", { busy: true })
  plain.send("busychange", { busy: false, src: "http://other/file.pdf" })
  expect(plain.busy.mock.calls).toEqual([[true]])
  const ctx = viewer()
  ctx.activity()
  ctx.show()
  await tick()
  ctx.next()
  await tick()
  ctx.send("busychange", { busy: true })
  ctx.send("busychange", { busy: false, version: "second" })
  expect(ctx.busy.mock.calls).toEqual([[true]])
  ctx.show("second")
  await tick()
  ctx.send("busychange", { busy: false })
  expect(ctx.busy.mock.calls).toEqual([[true]])
  ctx.send("busychange", { busy: false, version: "second", src: "http://server/latex/build/second/pdf" })
  expect(ctx.busy.mock.calls).toEqual([[true], [false]])
})

test("reactive reveal is cloneable, waits for the displayed build and preserves repeated same-page requests", async () => {
  const ctx = viewer()
  const target: PdfReveal = { id: "one", document: "paper", version: "first", page: 2, rect: [1, 2, 3, 4] }
  ctx.reveal(target)
  await tick()
  expect(ctx.post.mock.calls.filter(([item]) => item.type === "reveal")).toHaveLength(0)
  ctx.show()
  await tick()
  expect(ctx.post.mock.calls.filter(([item]) => item.type === "reveal").map(([item]) => item.id)).toEqual(["one"])
  ctx.reveal({ ...target, id: "two" })
  await tick()
  expect(ctx.post.mock.calls.filter(([item]) => item.type === "reveal").map(([item]) => item.id)).toEqual([
    "one",
    "two",
  ])
  ctx.next()
  ctx.reveal({ ...target, id: "three", version: "second" })
  await tick()
  expect(ctx.post.mock.calls.filter(([item]) => item.type === "reveal")).toHaveLength(2)
  ctx.show("second")
  await tick()
  expect(ctx.post.mock.calls.filter(([item]) => item.type === "reveal").at(-1)?.[0]).toMatchObject({
    id: "three",
    version: "second",
    src: "http://server/latex/build/second/pdf",
  })
})

test("source lookup and failure callbacks must belong to the loaded build and latest request", async () => {
  const ctx = viewer()
  ctx.show()
  await tick()
  ctx.send("sourcelocate", { page: 1, x: 20, y: 30 })
  expect(ctx.locate).not.toHaveBeenCalled()
  ctx.enable()
  await tick()
  ctx.next()
  await tick()
  ctx.send("sourcelocate", { page: 1, x: 20, y: 30 })
  expect(ctx.locate.mock.calls).toEqual([[{ document: "paper", version: "first", page: 1, x: 20, y: 30 }]])
  ctx.send("sourcelocate", { page: 1, x: Number.NaN, y: 30 })
  ctx.send("sourcelocate", { version: "second", page: 1, x: 20, y: 30 })
  ctx.send("sourcelocate", { src: "http://other/file", page: 1, x: 20, y: 30 })
  expect(ctx.locate).toHaveBeenCalledTimes(1)
  ctx.reveal({ id: "current", document: "paper", version: "first", page: 1, rect: [1, 2, 3, 4] })
  await tick()
  ctx.send("locateunavailable", { id: "old", reason: "busy" })
  ctx.send("locateunavailable", { id: "current", version: "second", reason: "busy" })
  expect(ctx.unavailable).not.toHaveBeenCalled()
  ctx.send("locateunavailable", { id: "current", reason: "busy" })
  expect(ctx.unavailable.mock.calls).toEqual([[{ id: "current", document: "paper", version: "first", reason: "busy" }]])
  ctx.show("second")
  await tick()
  ctx.send("sourcelocate", { page: 1, x: 20, y: 30 })
  expect(ctx.locate).toHaveBeenCalledTimes(1)
})

test("a requested version does not replace the displayed annotation source", async () => {
  const ctx = viewer()
  await tick()
  expect(requests).toHaveLength(0)
  ctx.show()
  await tick()
  ctx.next()
  await tick()
  expect(ctx.loaded.mock.calls).toEqual([["first"]])
  expect(requests.map((request) => request.url)).toEqual([
    "http://server/latex/build/first/annotations?directory=%2Fpaper",
  ])
  ctx.send("annotationchange", { id: 1, annotations: [] })
  await tick()
  expect(requests.at(-1)?.init?.method).toBe("PUT")
  expect(requests.at(-1)?.url).toContain("/build/first/annotations")
  expect(JSON.parse(requests.at(-1)?.init?.body as string).revision).toBe("r0")
  ctx.show("second")
  await tick()
  expect(ctx.loaded.mock.calls).toEqual([["first"], ["second"]])
  expect(requests.at(-1)?.url).toContain("/build/second/annotations")
})

test("queued annotation writes use the returned revision and reject stale version callbacks", async () => {
  const ctx = viewer()
  ctx.show()
  await tick()
  const gate = Promise.withResolvers<Response>()
  fetcher.mockImplementationOnce(async (input, init) => {
    requests.push({ url: input.toString(), init })
    return gate.promise
  })
  ctx.send("annotationchange", { id: 1, annotations: [] })
  ctx.send("annotationchange", { id: 2, annotations: [] })
  await tick()
  expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(1)
  gate.resolve(Response.json({ status: "ready", data: file("first"), revision: "r1" }))
  await tick()
  const writes = requests.filter((request) => request.init?.method === "PUT")
  expect(writes.map((request) => JSON.parse(request.init?.body as string).revision)).toEqual(["r0", "r1"])
  ctx.send("annotationchange", { id: 3, version: "other", annotations: [] })
  await tick()
  expect(requests.filter((request) => request.init?.method === "PUT")).toHaveLength(2)
  expect(
    ctx.post.mock.calls.some(
      ([message]) => message.type === "annotationstatus" && message.id === 3 && message.ok === false,
    ),
  ).toBe(true)
})
