import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { FileImage } from "./file-image"

const state = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), open: vi.fn() }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ fetch: state.fetch }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: { file: { open: state.open } } }) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))

const mounts: VoidFunction[] = []
const blobs: Blob[] = []
const revoked: string[] = []
const path = "实验/有 空格 #%.png"
const src = `http://localhost:4096/file/raw?path=${encodeURIComponent(path)}&directory=F%3A%2Ftest&v=1`
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } })
const size = { width: 600, height: 400 }
let resize = () => {}

async function loaded(view: ReturnType<typeof mount>, width = 1000, height = 500) {
  await vi.waitFor(() => expect(view.host.querySelector("img")).not.toBeNull())
  const image = view.host.querySelector("img")!
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  })
  image.dispatchEvent(new Event("load"))
  return image
}

function button(view: ReturnType<typeof mount>, key: string) {
  return view.host.querySelector<HTMLButtonElement>(`button[aria-label="file.image.${key}"]`)!
}

function pointer(viewport: HTMLElement, type: string, x: number, y: number, id = 1) {
  viewport.dispatchEvent(new PointerEvent(type, { button: 0, pointerId: id, clientX: x, clientY: y, bubbles: true }))
}

function mount() {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const [props, set] = createStore({ src, path, auth: "Basic dGVzdDpwYXNz" })
  const dispose = render(() => <FileImage {...props} />, host)
  const close = () => {
    dispose()
    host.remove()
  }
  mounts.push(close)
  return { host, set, close }
}

beforeEach(() => {
  vi.resetAllMocks()
  blobs.length = 0
  revoked.length = 0
  size.width = 600
  size.height = 400
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: VoidFunction) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-image-viewport") ? size.width : 0
  })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-image-viewport") ? size.height : 0
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(100, 50, size.width, size.height),
  )
  state.fetch.mockImplementation(async () => png())
  state.open.mockResolvedValue({})
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return `blob:image-${blobs.length}`
  })
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => revoked.push(url))
})

afterEach(() => {
  mounts.splice(0).forEach((dispose) => dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("image preview controls", () => {
  test("fits the image and zooms at the cursor without scrolling the page or fetching again", async () => {
    const view = mount()
    const image = await loaded(view)
    expect(view.host.querySelector("[data-image-scale]")?.textContent).toBe("56.8%")
    expect(button(view, "fit").getAttribute("aria-pressed")).toBe("true")
    button(view, "original").click()
    const viewport = view.host.querySelector<HTMLElement>("[data-image-viewport]")!
    const event = new WheelEvent("wheel", {
      deltaY: -Math.log(1.25) / 0.002,
      clientX: 500,
      clientY: 300,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    // Happy DOM's WheelEvent omits the MouseEvent coordinates supplied above.
    Object.defineProperties(event, { clientX: { value: 500 }, clientY: { value: 300 } })
    viewport.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(image.style.transform).toContain("translate(-25px, -12.5px)")
    expect(image.style.transform).toContain("scale(1.25)")
    expect(view.host.querySelector("[data-image-scale]")?.textContent).toBe("125%")
    const outside = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
    view.host.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(false)
    button(view, "fit").click()
    expect(image.style.transform).toContain("translate(0px, 0px)")
    expect(view.host.querySelector("[data-image-scale]")?.textContent).toBe("56.8%")
    expect(state.fetch).toHaveBeenCalledTimes(1)
  })

  test("fits rotated dimensions in both directions and preserves manual zoom on rotation", async () => {
    const view = mount()
    const image = await loaded(view)
    button(view, "rotateRight").click()
    expect(image.style.transform).toContain("rotate(90deg) scale(0.368)")
    button(view, "rotateRight").click()
    expect(image.style.transform).toContain("rotate(180deg) scale(0.568)")
    button(view, "rotateLeft").click()
    button(view, "rotateLeft").click()
    expect(image.style.transform).toContain("rotate(0deg) scale(0.568)")
    button(view, "original").click()
    button(view, "zoomIn").click()
    button(view, "rotateLeft").click()
    expect(image.style.transform).toContain("rotate(270deg) scale(1.25)")
    button(view, "zoomOut").click()
    expect(image.style.transform).toContain("scale(1)")
    expect(state.fetch).toHaveBeenCalledTimes(1)
  })

  test("allows reaching every rotated edge with bounded dragging and releases the active pointer", async () => {
    const view = mount()
    const image = await loaded(view)
    const viewport = view.host.querySelector<HTMLElement>("[data-image-viewport]")!
    button(view, "original").click()
    button(view, "zoomIn").click()
    button(view, "rotateRight").click()
    pointer(viewport, "pointerdown", 300, 200)
    expect(viewport.classList.contains("cursor-grabbing")).toBe(true)
    pointer(viewport, "pointermove", 9000, 9000, 2)
    expect(image.style.transform).toContain("translate(0px, 0px)")
    pointer(viewport, "pointermove", 9000, 9000)
    expect(image.style.transform).toContain("translate(12.5px, 425px)")
    pointer(viewport, "pointermove", -9000, -9000)
    expect(image.style.transform).toContain("translate(-12.5px, -425px)")
    pointer(viewport, "pointerup", -9000, -9000)
    expect(viewport.classList.contains("cursor-grabbing")).toBe(false)
    pointer(viewport, "pointermove", 300, 200)
    expect(image.style.transform).toContain("translate(-12.5px, -425px)")
    button(view, "fit").click()
    pointer(viewport, "pointerdown", 300, 200)
    pointer(viewport, "pointermove", 9000, 9000)
    expect(image.style.transform).toContain("translate(0px, 0px)")
    pointer(viewport, "pointercancel", 9000, 9000)
    expect(viewport.classList.contains("cursor-grabbing")).toBe(false)
  })

  test("adapts fit mode to panel resize, preserves manual zoom, and resets only when the source changes", async () => {
    const view = mount()
    const image = await loaded(view)
    size.width = 300
    resize()
    expect(image.style.transform).toContain("scale(0.268)")
    button(view, "original").click()
    button(view, "rotateRight").click()
    size.width = 900
    size.height = 800
    resize()
    expect(image.style.transform).toContain("rotate(90deg) scale(1)")
    expect(state.fetch).toHaveBeenCalledTimes(1)
    view.set("src", src + "&v=2")
    expect(view.host.querySelector("[data-image-scale]")).toBeNull()
    const next = await loaded(view, 1200, 600)
    expect(next.style.transform).toContain("rotate(0deg)")
    expect(view.host.querySelector("[data-image-scale]")?.textContent).toBe("72.3%")
    expect(button(view, "fit").getAttribute("aria-pressed")).toBe("true")
    expect(state.fetch).toHaveBeenCalledTimes(2)
  })

  test("keeps zoom bounded and permits keyboard panning without intercepting modified shortcuts", async () => {
    const view = mount()
    const image = await loaded(view)
    const viewport = view.host.querySelector<HTMLElement>("[data-image-viewport]")!
    Array.from({ length: 40 }).forEach(() => button(view, "zoomIn").click())
    expect(image.style.transform).toContain("scale(16)")
    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
    const parent = vi.fn()
    view.host.addEventListener("keydown", parent)
    viewport.dispatchEvent(arrow)
    expect(arrow.defaultPrevented).toBe(true)
    expect(parent).not.toHaveBeenCalled()
    expect(image.style.transform).toContain("translate(-40px, 0px)")
    const shortcut = new KeyboardEvent("keydown", { key: "0", ctrlKey: true, bubbles: true, cancelable: true })
    viewport.dispatchEvent(shortcut)
    expect(shortcut.defaultPrevented).toBe(false)
    expect(parent).toHaveBeenCalledTimes(1)
    expect(image.style.transform).toContain("scale(16)")
    Array.from({ length: 50 }).forEach(() => button(view, "zoomOut").click())
    expect(image.style.transform).toContain("scale(0.05)")
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }))
    expect(image.style.transform).toContain("scale(0.568)")
  })
})

describe("authenticated file images", () => {
  test("fetches bytes with authentication and displays only a local blob URL", async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.host.querySelector("img")).not.toBeNull())
    expect(state.fetch).toHaveBeenCalledWith(src, {
      headers: { Authorization: "Basic dGVzdDpwYXNz" },
      signal: expect.any(AbortSignal),
    })
    const img = view.host.querySelector("img")!
    expect(img.getAttribute("src")).toBe("blob:image-1")
    expect(img.alt).toBe(path)
    expect(blobs[0].type).toBe("image/png")
    expect(view.host.querySelector('[role="status"]')).not.toBeNull()
    img.dispatchEvent(new Event("load"))
    expect(view.host.querySelector('[role="status"]')).toBeNull()
    expect(img.classList.contains("invisible")).toBe(false)
  })

  test("shows HTTP errors and retries without changing the source or dropping credentials", async () => {
    state.fetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
    const view = mount()
    await vi.waitFor(() => expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("HTTP 401"))
    expect(view.host.querySelector("img")).toBeNull()
    const retry = Array.from(view.host.querySelectorAll("button")).find(
      (button) => button.textContent === "file.image.retry",
    )!
    retry.click()
    await vi.waitFor(() => expect(view.host.querySelector("img")).not.toBeNull())
    expect(state.fetch).toHaveBeenCalledTimes(2)
    expect(state.fetch.mock.calls[1][0]).toBe(src)
    expect(state.fetch.mock.calls[1][1]?.headers).toEqual({ Authorization: "Basic dGVzdDpwYXNz" })
    expect(view.host.querySelector('[role="alert"]')).toBeNull()
  })

  test("distinguishes network failures from unsupported or damaged image bytes", async () => {
    state.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const view = mount()
    await vi.waitFor(() => expect(view.host.textContent).toContain("file.image.loadFailed"))
    view.set("src", src + "&retry=1")
    await vi.waitFor(() => expect(view.host.querySelector("img")).not.toBeNull())
    view.host.querySelector("img")!.dispatchEvent(new Event("error"))
    expect(view.host.textContent).toContain("file.image.decodeFailed")
    expect(view.host.querySelector("img")!.classList.contains("invisible")).toBe(true)
    Array.from(view.host.querySelectorAll("button"))
      .find((button) => button.textContent === "file.image.external")!
      .click()
    expect(state.open).toHaveBeenCalledWith({ path })
  })

  test("ignores an older response even when its fetch transport ignores cancellation", async () => {
    let resolve: (value: Response) => void = () => undefined
    state.fetch.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    const view = mount()
    const signal = state.fetch.mock.calls[0][1]?.signal
    view.set("src", src + "&v=2")
    await vi.waitFor(() => expect(view.host.querySelector("img")).not.toBeNull())
    expect(signal?.aborted).toBe(true)
    resolve(png())
    await new Promise((done) => setTimeout(done, 0))
    expect(blobs).toHaveLength(1)
    expect(view.host.querySelector("img")!.getAttribute("src")).toBe("blob:image-1")
  })

  test("refreshes on version and authentication changes and revokes each replaced blob", async () => {
    const view = mount()
    await vi.waitFor(() => expect(blobs).toHaveLength(1))
    const old = view.host.querySelector("img")!
    view.set("src", src.replace("v=1", "v=2"))
    await vi.waitFor(() => expect(blobs).toHaveLength(2))
    old.dispatchEvent(new Event("error"))
    expect(view.host.querySelector('[role="alert"]')).toBeNull()
    expect(revoked).toEqual(["blob:image-1"])
    view.set("auth", "Basic bmV3OnBhc3M=")
    await vi.waitFor(() => expect(blobs).toHaveLength(3))
    expect(state.fetch.mock.calls[2][1]?.headers).toEqual({ Authorization: "Basic bmV3OnBhc3M=" })
    view.close()
    expect(revoked).toEqual(["blob:image-1", "blob:image-2", "blob:image-3"])
  })

  test("does not create an object URL after the viewer has been closed", async () => {
    let resolve: (value: Response) => void = () => undefined
    state.fetch.mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    const view = mount()
    const signal = state.fetch.mock.calls[0][1]?.signal
    view.close()
    resolve(png())
    await new Promise((done) => setTimeout(done, 0))
    expect(signal?.aborted).toBe(true)
    expect(blobs).toHaveLength(0)
  })
})
