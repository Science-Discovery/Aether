import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const script = readFileSync(new URL("../../public/pdf-viewer-aether.js", import.meta.url), "utf8")
type Event = Record<string, unknown>
type Doc = {
  name: string
  numPages: number
  _pdfInfo: { fingerprints: string[] }
  getPage: (page: number) => Promise<unknown>
}
type Task = { promise: Promise<Doc>; destroy: () => Promise<void> }

async function viewer() {
  const callbacks = new Map<string, (event: Event) => unknown>()
  const events = new Map<string, Set<(event: Event) => void>>()
  const timers = new Map<number, () => void>()
  const storage = new Map<string, string>()
  const posts: Event[] = []
  const state = {
    time: 10000,
    selected: false,
    closed: 0,
    location: "",
    loads: [] as string[],
    destroyed: [] as string[],
  }
  const broken = new Set<string>()
  const failed = new Set<string>()
  const paused = new Map<string, Promise<void>>()
  const parent = { postMessage: (message: Event) => posts.push(message) }
  const emit = (type: string, event: Event = {}) => events.get(type)?.forEach((fn) => fn(event))
  const app = {
    initializedPromise: Promise.resolve(),
    pdfDocument: null as Doc | null,
    pdfLoadingTask: undefined as Task | undefined,
    pdfViewer: { currentPageNumber: 1, currentScaleValue: "auto", scrollMode: 0, spreadMode: 0, pagesRotation: 0 },
    pdfLinkService: {
      setHash: (hash: string) => {
        state.location = hash
        const page = /page=(\d+)/.exec(hash)
        if (page) app.page = Number(page[1])
      },
    },
    pdfSidebar: { close: () => undefined, switchView: () => undefined },
    eventBus: {
      on: (type: string, fn: (event: Event) => void) => {
        if (!events.has(type)) events.set(type, new Set())
        events.get(type)!.add(fn)
      },
      off: (type: string, fn: (event: Event) => void) => events.get(type)?.delete(fn),
    },
    get page() {
      return this.pdfViewer.currentPageNumber
    },
    set page(page: number) {
      this.pdfViewer.currentPageNumber = page
    },
    close: async () => {
      if (!app.pdfDocument) return
      state.closed++
      await app.pdfLoadingTask?.destroy()
      app.pdfDocument = null
    },
    load: (doc: Doc) => {
      app.pdfDocument = doc
      state.loads.push(doc.name)
      emit("documentloaded")
      emit("pagesinit")
      emit("pagesloaded", { pagesCount: doc.numPages })
      emit("pagerendered", { pageNumber: app.page })
    },
  }
  const timeout = (fn: () => void) => {
    const id = timers.size + 1
    timers.set(id, fn)
    return id
  }
  const clear = (id: number) => timers.delete(id)
  const window = {
    location: { protocol: "http:", origin: "http://aether.test" },
    parent,
    PDFViewerApplication: app,
    addEventListener: (type: string, fn: (event: Event) => unknown) => callbacks.set(type, fn),
    setTimeout: timeout,
    clearTimeout: clear,
    getSelection: () => ({
      isCollapsed: !state.selected,
      removeAllRanges: () => {
        state.selected = false
      },
    }),
    pdfjsLib: {
      getDocument: ({ url }: { url: string }): Task => ({
        destroy: async () => {
          state.destroyed.push(url)
        },
        promise: Promise.resolve().then(async () => {
          await paused.get(url)
          if (broken.has(url)) throw new Error("Invalid PDF")
          return {
            name: url,
            numPages: url.includes("short") ? 2 : 8,
            _pdfInfo: { fingerprints: [url] },
            getPage: async () => ({
              getViewport: () => ({ width: 100, height: 100 }),
              render: () => ({
                promise: failed.has(url) ? Promise.reject(new Error("Invalid page")) : Promise.resolve(),
              }),
            }),
          }
        }),
      }),
    },
  }
  runInNewContext(script, {
    window,
    document: document.implementation.createHTMLDocument(),
    PDFViewerApplication: app,
    PDFViewerApplicationOptions: { set: () => undefined },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn: () => void) => {
      fn()
      return 1
    },
    cancelAnimationFrame: () => undefined,
    setTimeout: timeout,
    clearTimeout: clear,
    Date: class extends Date {
      static now() {
        return state.time
      }
    },
    console: { error: () => undefined },
    crypto,
  })
  await callbacks.get("load")!({})
  await Promise.resolve()
  const send = async (type: string, data: Event) =>
    callbacks.get("message")!({
      source: parent,
      origin: window.location.origin,
      data: { channel: "aether-pdf-viewer", type, ...data },
    })
  return {
    app,
    state,
    posts,
    broken,
    failed,
    paused,
    emit,
    storage,
    open: async (src: string, document = "paper") => {
      state.time += 10000
      await send("config", {
        config: { src, document, version: src, mode: "full", features: { textSelectionActions: true } },
      })
    },
    flush: async () => {
      state.time += 10000
      const tasks = [...timers.values()]
      timers.clear()
      tasks.forEach((fn) => fn())
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
  }
}

test("a failed PDF fetch or render preserves the loaded document and version", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  expect(ctx.posts.find((message) => message.type === "loaderror")).toBeUndefined()
  ctx.broken.add("broken")
  await ctx.open("broken")
  ctx.failed.add("invalid-page")
  await ctx.open("invalid-page")
  expect(ctx.state.loads).toEqual(["first"])
  expect(ctx.state.closed).toBe(0)
  expect(ctx.state.destroyed).toEqual(["broken", "invalid-page"])
  expect(ctx.posts.filter((message) => message.type === "documentinfo").map((message) => message.version)).toEqual([
    "first",
  ])
})

test("recompilation preserves zoom and page offset and clamps pages in shorter PDFs", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  ctx.app.pdfViewer.currentScaleValue = "150"
  ctx.app.page = 7
  ctx.state.time += 1000
  ctx.emit("updateviewarea", { location: { pdfOpenParams: "#page=7&zoom=150,12,45" } })
  await ctx.open("short")
  expect(ctx.app.page).toBe(2)
  expect(ctx.app.pdfViewer.currentScaleValue).toBe("150")
  expect(ctx.state.location).toBe("page=2&zoom=150,12,45")
  expect(ctx.state.destroyed).toContain("first")
  expect(JSON.parse(ctx.storage.get("aether-pdf-doc-state")!).paper.state.page).toBe(7)
})

test("an active selection delays replacement until selection is released", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  ctx.state.selected = true
  await ctx.open("second")
  expect(ctx.state.loads).toEqual(["first"])
  ctx.state.selected = false
  await ctx.flush()
  expect(ctx.state.loads).toEqual(["first", "second"])
})

test("an obsolete preloaded build cannot replace the latest requested build", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  const gate = Promise.withResolvers<void>()
  ctx.paused.set("second", gate.promise)
  const second = ctx.open("second")
  await Promise.resolve()
  const third = ctx.open("third")
  gate.resolve()
  await Promise.all([second, third])
  expect(ctx.state.loads).toEqual(["first", "third"])
  expect(ctx.state.destroyed).toContain("second")
})
