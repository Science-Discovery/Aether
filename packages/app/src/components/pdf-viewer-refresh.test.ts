import { expect, spyOn, test } from "bun:test"
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
  const dom = document.implementation.createHTMLDocument()
  const state = {
    time: 10000,
    selected: false,
    closed: 0,
    location: "",
    loads: [] as string[],
    destroyed: [] as string[],
    visible: [] as number[],
    delayed: false,
    covered: false,
    mac: false,
    reveals: [] as Array<{ pageNumber: number; destArray: unknown[]; ignoreDestinationZoom: boolean }>,
  }
  const viewport = {
    width: 300,
    height: 400,
    convertToPdfPoint: (x: number, y: number) => [x / 2, 200 - y / 2],
    convertToViewportPoint: (x: number, y: number) => [x * 2, 400 - y * 2],
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
    pdfViewer: {
      currentPageNumber: 1,
      currentScaleValue: "auto",
      scrollMode: 0,
      spreadMode: 0,
      pagesRotation: 0,
      _getVisiblePages: () => ({ views: state.visible.map((id) => ({ id })) }),
      getPageView: () => ({ viewport, renderingState: 3 }),
      scrollPageIntoView: (target: { pageNumber: number; destArray: unknown[]; ignoreDestinationZoom: boolean }) => {
        state.reveals.push(target)
        app.page = target.pageNumber
      },
    },
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
      state.covered = !!dom.querySelector("[data-aether-refresh]")
      dom.getElementById("viewer")?.replaceChildren()
      await app.pdfLoadingTask?.destroy()
      app.pdfDocument = null
    },
    load: (doc: Doc) => {
      app.pdfDocument = doc
      state.loads.push(doc.name)
      emit("documentloaded")
      emit("pagesinit")
      emit("pagesloaded", { pagesCount: doc.numPages })
      if (!state.delayed) emit("pagerendered", { pageNumber: app.page })
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
    navigator: {
      get platform() {
        return state.mac ? "MacIntel" : "Win32"
      },
    },
    PDFViewerApplication: app,
    addEventListener: (type: string, fn: (event: Event) => unknown) => callbacks.set(type, fn),
    setTimeout: timeout,
    clearTimeout: clear,
    getComputedStyle: () => ({ backgroundColor: "rgb(32, 32, 32)" }),
    getSelection: () => ({
      rangeCount: 0,
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
    document: dom,
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
    Element,
  })
  await callbacks.get("load")!({})
  await Promise.resolve()
  const send = async (type: string, data: Event, event: Event = {}) =>
    callbacks.get("message")!({
      source: parent,
      origin: window.location.origin,
      data: { channel: "aether-pdf-viewer", type, ...data },
      ...event,
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
    dom,
    viewport,
    send,
    open: async (
      src: string,
      document = "paper",
      version: string | null = src,
      elapsed = 10000,
      locate = false,
      opts: { activity?: boolean; annotations?: boolean } = {},
    ) => {
      state.time += elapsed
      await send("config", {
        config: {
          src,
          document,
          version: version ?? undefined,
          mode: "full",
          features: { textSelectionActions: true, sourceLocate: locate, ...opts },
        },
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

function page(ctx: Awaited<ReturnType<typeof viewer>>) {
  ctx.dom.getElementById("viewerContainer")?.remove()
  ctx.dom.body.insertAdjacentHTML(
    "beforeend",
    '<div id="viewerContainer"><div id="viewer"><div class="page" data-page-number="1"><div class="canvasWrapper"></div></div></div></div>',
  )
  const page = ctx.dom.querySelector<HTMLElement>(".page")!
  const canvas = page.querySelector<HTMLElement>(".canvasWrapper")!
  page.getBoundingClientRect = () => new DOMRect(8, 18, 304, 404)
  canvas.getBoundingClientRect = () => new DOMRect(10, 20, 300, 400)
  return canvas
}

function click(target: HTMLElement, opts: MouseEventInit = {}) {
  const init = { bubbles: true, cancelable: true, clientX: 70, clientY: 100, ctrlKey: true, ...opts }
  target.dispatchEvent(new MouseEvent("pointerdown", init))
  return target.dispatchEvent(new MouseEvent("click", init))
}

test("activity reports ordinary PDF selections without polling or enabling source lookup", async () => {
  const ctx = await viewer()
  await ctx.open("file", "", null, 10000, false, { activity: true })
  const updates = () => ctx.posts.filter((item) => item.type === "busychange")
  expect(updates().map((item) => item.busy)).toEqual([false])
  ctx.state.selected = true
  ctx.dom.dispatchEvent(new Event("selectionchange"))
  await Promise.resolve()
  expect(updates().map((item) => item.busy)).toEqual([false, true])
  ctx.dom.dispatchEvent(new Event("selectionchange"))
  await Promise.resolve()
  expect(updates()).toHaveLength(2)
  ctx.state.selected = false
  ctx.dom.dispatchEvent(new Event("selectionchange"))
  await Promise.resolve()
  expect(updates().map((item) => item.busy)).toEqual([false, true, false])
  expect(updates().every((item) => item.src === "file" && item.version === undefined)).toBe(true)
  expect(ctx.posts.some((item) => item.type === "sourcelocate")).toBe(false)
})

test("activity covers annotation editing and remains busy until annotation writes finish", async () => {
  const ctx = await viewer()
  await ctx.open("first", "paper", "first", 10000, false, { activity: true, annotations: true })
  page(ctx)
  await ctx.send("annotations", {
    document: "paper",
    version: "first",
    src: "first",
    annotations: [
      {
        id: "note",
        type: "note",
        color: "yellow",
        pages: [{ page: 1, quads: [[10, 10, 30, 10, 10, 20, 30, 20]] }],
        selectedText: "Text",
        note: "",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  ctx.dom
    .querySelector(".aetherAnnotationHit")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 70, clientY: 100 }))
  await Promise.resolve()
  expect(ctx.posts.filter((item) => item.type === "busychange").at(-1)?.busy).toBe(true)
  ctx.dom
    .getElementById("aetherAnnotationEditor")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await Promise.resolve()
  expect(ctx.dom.getElementById("aetherAnnotationEditor")).toBeNull()
  expect(ctx.posts.filter((item) => item.type === "busychange").at(-1)?.busy).toBe(true)
  await ctx.send("annotationstatus", { document: "paper", version: "first", src: "first", id: 1, ok: true })
  expect(ctx.posts.filter((item) => item.type === "busychange").at(-1)?.busy).toBe(false)
})

test("activity reporting is opt-in", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  ctx.state.selected = true
  ctx.dom.dispatchEvent(new Event("selectionchange"))
  await Promise.resolve()
  expect(ctx.posts.some((item) => item.type === "busychange")).toBe(false)
})

test("source reveal keeps zoom, handles repeated same-page requests and rejects stale or untrusted messages", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  page(ctx)
  ctx.app.pdfViewer.currentScaleValue = "200"
  const data = { id: "one", document: "paper", version: "first", src: "first", page: 1, rect: [20, 120, 50, 140] }
  await ctx.send("reveal", data)
  await ctx.send("reveal", { ...data, id: "two" })
  expect(ctx.state.reveals).toHaveLength(2)
  expect(ctx.state.reveals[0]).toEqual({
    pageNumber: 1,
    destArray: [null, { name: "XYZ" }, 20, 140, null],
    ignoreDestinationZoom: true,
  })
  expect(ctx.app.pdfViewer.currentScaleValue).toBe("200")
  const mark = ctx.dom.querySelector<HTMLElement>(".aetherSourceHighlight")!
  expect(mark.style.left).toBe("42px")
  expect(mark.style.top).toBe("122px")
  expect(mark.style.width).toBe("60px")
  expect(mark.style.height).toBe("40px")
  expect(mark.style.pointerEvents).toBe("none")
  await ctx.send("reveal", { ...data, version: "second" })
  await ctx.send("reveal", data, { origin: "https://other.test" })
  await ctx.send("reveal", data, { source: {} })
  expect(ctx.state.reveals).toHaveLength(2)
  await ctx.flush()
  expect(ctx.dom.querySelector(".aetherSourceHighlight")).toBeNull()
})

test("source reveal does not disturb a selection and validates destination geometry", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  page(ctx)
  const data = { id: "one", document: "paper", version: "first", src: "first", page: 1, rect: [20, 120, 50, 140] }
  ctx.state.selected = true
  await ctx.send("reveal", data)
  expect(ctx.state.selected).toBe(true)
  expect(ctx.state.reveals).toHaveLength(0)
  expect(ctx.posts.at(-1)).toMatchObject({ type: "locateunavailable", id: "one", reason: "busy", version: "first" })
  ctx.state.selected = false
  await ctx.send("reveal", { ...data, id: "bad", rect: [0, 10, Number.NaN, 2] })
  await ctx.send("reveal", { ...data, id: "page", page: 99 })
  expect(ctx.state.reveals).toHaveLength(0)
  expect(ctx.posts.at(-1)).toMatchObject({ type: "locateunavailable", id: "page", reason: "unavailable" })
})

test("source reveal leaves visible padding below an overlay toolbar without changing zoom, including rotated pages", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  const canvas = page(ctx)
  const container = ctx.dom.getElementById("viewerContainer")!
  container.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
  canvas.getBoundingClientRect = () => new DOMRect(10, 112 - container.scrollTop, 300, 400)
  canvas.parentElement!.getBoundingClientRect = () => new DOMRect(8, 110 - container.scrollTop, 304, 404)
  const toolbar = ctx.dom.createElement("div")
  toolbar.id = "toolbarContainer"
  toolbar.getBoundingClientRect = () => new DOMRect(0, 0, 400, 40)
  ctx.dom.body.appendChild(toolbar)
  ctx.app.pdfViewer.currentScaleValue = "200"
  container.scrollTop = 200
  const data = { id: "one", document: "paper", version: "first", src: "first", page: 1, rect: [20, 120, 50, 140] }
  await ctx.send("reveal", data)
  expect(container.scrollTop).toBe(176)
  expect(ctx.app.pdfViewer.currentScaleValue).toBe("200")
  ctx.viewport.convertToViewportPoint = (x, y) => [y * 2, x * 2]
  container.scrollTop = 200
  await ctx.send("reveal", { ...data, id: "rotated" })
  expect(container.scrollTop).toBe(96)
  expect(ctx.app.pdfViewer.currentScaleValue).toBe("200")
})

test("source reveal keeps horizontally clipped targets visible after 180 and 270 degree rotation", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  const canvas = page(ctx)
  const container = ctx.dom.getElementById("viewerContainer")!
  container.getBoundingClientRect = () => new DOMRect(0, 0, 200, 400)
  canvas.getBoundingClientRect = () => new DOMRect(112 - container.scrollLeft, 20, 300, 400)
  canvas.parentElement!.getBoundingClientRect = () => new DOMRect(110 - container.scrollLeft, 18, 304, 404)
  ctx.viewport.convertToViewportPoint = (x, y) => [300 - x * 2, 400 - y * 2]
  container.scrollLeft = 350
  const data = { id: "half", document: "paper", version: "first", src: "first", page: 1, rect: [20, 120, 50, 140] }
  await ctx.send("reveal", data)
  expect(container.scrollLeft).toBe(296)
  ctx.viewport.width = 400
  ctx.viewport.height = 300
  ctx.viewport.convertToViewportPoint = (x, y) => [400 - y * 2, x * 2]
  container.scrollLeft = 350
  await ctx.send("reveal", { ...data, id: "three-quarters" })
  expect(container.scrollLeft).toBe(186)
})

test("source reveal keeps the leading edge of a region wider than the viewport visible", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  const canvas = page(ctx)
  const container = ctx.dom.getElementById("viewerContainer")!
  container.getBoundingClientRect = () => new DOMRect(0, 0, 150, 400)
  canvas.getBoundingClientRect = () => new DOMRect(112 - container.scrollLeft, 20, 300, 400)
  canvas.parentElement!.getBoundingClientRect = () => new DOMRect(110 - container.scrollLeft, 18, 304, 404)
  container.scrollLeft = 100
  await ctx.send("reveal", {
    id: "wide",
    document: "paper",
    version: "first",
    src: "first",
    page: 1,
    rect: [20, 120, 140, 140],
  })
  expect(container.scrollLeft).toBe(136)
})

test("source lookup uses the loaded PDF coordinates and excludes ordinary clicks, links and annotation controls", async () => {
  const ctx = await viewer()
  await ctx.open("first", "paper", "first", 10000, true)
  const canvas = page(ctx)
  click(canvas)
  expect(ctx.posts.at(-1)).toMatchObject({
    type: "sourcelocate",
    document: "paper",
    version: "first",
    page: 1,
    x: 30,
    y: 160,
  })
  const count = () => ctx.posts.filter((item) => item.type === "sourcelocate").length
  click(canvas, { ctrlKey: false })
  canvas.innerHTML = '<a href="#">link</a><div class="aetherAnnotationLayer"><span>annotation</span></div>'
  click(canvas.querySelector("a")!)
  click(canvas.querySelector("span")!)
  expect(count()).toBe(1)
  ctx.state.mac = true
  click(canvas)
  expect(count()).toBe(1)
  click(canvas, { ctrlKey: false, metaKey: true })
  expect(count()).toBe(2)
  ctx.state.selected = true
  click(canvas, { ctrlKey: false, metaKey: true })
  expect(ctx.state.selected).toBe(true)
  expect(count()).toBe(2)
  expect(ctx.posts.at(-1)).toMatchObject({ type: "locateunavailable", reason: "busy" })
})

test("source lookup transforms CSS-scaled rotated pages through the PDF viewport", async () => {
  const ctx = await viewer()
  await ctx.open("first", "paper", "first", 10000, true)
  const canvas = page(ctx)
  ctx.viewport.width = 400
  ctx.viewport.height = 300
  ctx.viewport.convertToPdfPoint = (x, y) => [y / 2, x / 2]
  click(canvas)
  expect(ctx.posts.at(-1)).toMatchObject({ type: "sourcelocate", page: 1, x: 30, y: 40 })
})

test("ordinary PDF source lookup stays disabled and preloading does not use the incoming build identity", async () => {
  const ctx = await viewer()
  await ctx.open("ordinary", "ordinary", null)
  click(page(ctx))
  expect(ctx.posts.some((item) => item.type === "sourcelocate")).toBe(false)
  await ctx.open("first", "paper", "first", 10000, true)
  const canvas = page(ctx)
  const gate = Promise.withResolvers<void>()
  ctx.paused.set("second", gate.promise)
  const loading = ctx.open("second", "paper", "second", 10000, true)
  await Promise.resolve()
  click(canvas)
  expect(ctx.posts.at(-1)).toMatchObject({ type: "sourcelocate", version: "first", src: "first" })
  gate.resolve()
  await loading
  expect(ctx.state.loads.at(-1)).toBe("second")
})

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

test("immutable build versions bypass the ordinary file refresh interval", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  await ctx.open("second", "paper", "second", 100)
  expect(ctx.state.loads).toEqual(["first", "second"])
  await ctx.open("file?v=1", "ordinary", null)
  await ctx.open("file?v=2", "ordinary", null, 100)
  expect(ctx.state.loads).toEqual(["first", "second", "file?v=1"])
  await ctx.flush()
  expect(ctx.state.loads).toEqual(["first", "second", "file?v=1", "file?v=2"])
})

test("a viewport snapshot keeps painted pixels until the restored visible page renders", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  ctx.app.page = 7
  ctx.state.visible = [7]
  ctx.state.delayed = true
  ctx.dom.body.insertAdjacentHTML(
    "beforeend",
    '<div id="viewerContainer"><div id="viewer" class="pdfViewer"><div class="page" data-page-number="7"><canvas id="old-canvas" width="20" height="20"></canvas></div></div></div>',
  )
  const container = ctx.dom.getElementById("viewerContainer")!
  container.getBoundingClientRect = () => new DOMRect(0, 32, 400, 600)
  ctx.dom.querySelector(".page")!.getBoundingClientRect = () => new DOMRect(10, 12, 380, 800)
  let copied = 0
  const spy = spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: () => copied++,
  } as unknown as CanvasRenderingContext2D)
  try {
    await ctx.open("second")
    const cover = ctx.dom.querySelector<HTMLElement>("[data-aether-refresh]")!
    expect(ctx.state.covered).toBe(true)
    expect(copied).toBe(1)
    expect(cover.getAttribute("aria-hidden")).toBe("true")
    expect(cover.querySelector("[id]")).toBeNull()
    expect(container.inert).toBe(true)
    ctx.emit("pagerendered", { pageNumber: 1 })
    ctx.emit("pagerendered", { pageNumber: 7, cssTransform: true })
    expect(cover.isConnected).toBe(true)
    expect(ctx.posts.filter((item) => item.type === "documentinfo").map((item) => item.version)).toEqual(["first"])
    ctx.emit("pagerendered", { pageNumber: 7 })
    expect(cover.isConnected).toBe(false)
    expect(container.inert).toBe(false)
    expect(ctx.posts.filter((item) => item.type === "documentinfo").map((item) => item.version)).toEqual([
      "first",
      "second",
    ])
  } finally {
    spy.mockRestore()
  }
})

test("a visible page render error releases replacement so another build can recover", async () => {
  const ctx = await viewer()
  await ctx.open("first")
  ctx.state.delayed = true
  await ctx.open("second")
  ctx.emit("pagerendered", { pageNumber: 1, error: new Error("Rendering failed") })
  expect(ctx.posts.find((item) => item.type === "loaderror")?.version).toBe("second")
  ctx.state.delayed = false
  await ctx.open("third")
  expect(ctx.state.loads).toEqual(["first", "second", "third"])
  expect(ctx.posts.filter((item) => item.type === "documentinfo").map((item) => item.version)).toEqual([
    "first",
    "third",
  ])
})
