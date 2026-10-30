import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { PdfViewerShell } from "./pdf-viewer-shell-official"

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

function viewer() {
  const [state, setState] = createStore({ src: "http://server/latex/build/first/pdf", version: "first" })
  const loaded = vi.fn()
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <PdfViewerShell
        src={state.src}
        document="paper"
        version={state.version}
        annotationBuild={state.version}
        mode="full"
        onVersionChange={loaded}
      />
    ),
    host,
  )
  const frame = host.querySelector("iframe")!
  const post = vi.spyOn(frame.contentWindow!, "postMessage")
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
          document: "paper",
          version: "first",
          src: "http://server/latex/build/first/pdf",
          ...data,
        },
      }),
    )
  send("ready")
  return {
    loaded,
    post,
    send,
    show: (id = "first") =>
      send("documentinfo", {
        totalPages: 3,
        version: id,
        source: { src: `http://server/latex/build/${id}/pdf`, document: "paper", version: id, annotationBuild: id },
      }),
    next: () => setState({ src: "http://server/latex/build/second/pdf", version: "second" }),
  }
}

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
