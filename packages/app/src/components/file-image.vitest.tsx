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
