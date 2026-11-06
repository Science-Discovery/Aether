import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import Xlsx from "./xlsx"
import type { Cell, Reply, Request, Sheet } from "./xlsx-types"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "zh" }) }))
const workers: MockWorker[] = []
const cleanup: VoidFunction[] = []
class MockWorker {
  onmessage: ((event: MessageEvent<Reply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn<(request: Request, transfers: Transferable[]) => void>()
  terminate = vi.fn()
  constructor() {
    workers.push(this)
  }
  send(reply: Reply) {
    this.onmessage?.({ data: reply } as MessageEvent<Reply>)
  }
}

const sheet = (id: number): Sheet => ({
  id,
  name: `工作表 ${id}`,
  rows: { count: 100_000, size: 20, custom: {} },
  columns: { count: 2000, size: 64, custom: {} },
  images: id === 1 ? [{ id: "picture", left: 0, top: 0, width: 64, height: 40 }] : [],
})
const cell = (text: string): Cell => ({
  address: "A1",
  row: 1,
  column: 1,
  rows: 1,
  columns: 1,
  left: 0,
  top: 0,
  width: 64,
  height: 20,
  text,
  style: {},
})

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const error = vi.fn()
  const data = new Uint8Array([1, 2, 3]).buffer
  const dispose = render(() => <Xlsx data={data} path="workbook.xlsx" onError={error} />, host)
  const close = () => {
    dispose()
    host.remove()
  }
  cleanup.push(close)
  return { host, close, error, data, worker: workers.at(-1)! }
}

function loaded(worker: MockWorker) {
  worker.send({
    type: "loaded",
    id: 1,
    sheets: [sheet(1), sheet(2)],
    images: [{ id: "picture", mime: "image/png", data: new Uint8Array([137, 80, 78, 71]) }],
  })
}

beforeEach(() => {
  workers.length = 0
  vi.stubGlobal("Worker", MockWorker)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("xlsx-viewport") ? 600 : 0
  })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("xlsx-viewport") ? 300 : 0
  })
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:worksheet-image")
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
})
afterEach(() => {
  cleanup.splice(0).forEach((close) => close())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("virtual workbook preview", () => {
  test("transfers a copy, requests only the viewport, and follows scrolling on both axes", async () => {
    const view = mount()
    const request = view.worker.postMessage.mock.calls[0][0]
    expect(request.type).toBe("load")
    if (request.type !== "load") throw new Error("Missing load request")
    expect(request.data).not.toBe(view.data)
    expect(new Uint8Array(view.data)).toEqual(new Uint8Array([1, 2, 3]))
    loaded(view.worker)
    await vi.waitFor(() => expect(view.worker.postMessage.mock.calls.length).toBe(2))
    const first = view.worker.postMessage.mock.calls[1][0]
    expect(first.type).toBe("range")
    if (first.type !== "range") throw new Error("Missing viewport")
    expect(first.rows.length).toBeLessThan(25)
    expect(first.columns.length).toBeLessThan(15)
    view.worker.send({ type: "range", id: first.id, sheet: 1, cells: [{ ...cell("visible"), unformatted: true }] })
    expect(view.host.querySelector('[role="gridcell"]')?.textContent).toBe("visible")
    expect(view.host.querySelector(".xlsx-warning")?.textContent).toContain("数字格式未完全支持")
    expect(view.host.querySelectorAll('[role="rowheader"]').length).toBeLessThan(25)
    expect(view.host.querySelectorAll('[role="columnheader"]').length).toBeLessThan(15)
    expect(view.host.querySelector("img")?.getAttribute("src")).toBe("blob:worksheet-image")
    const viewport = view.host.querySelector<HTMLElement>(".xlsx-viewport")!
    viewport.scrollTop = 10000
    viewport.scrollLeft = 2000
    viewport.dispatchEvent(new Event("scroll"))
    await vi.waitFor(() => expect(view.worker.postMessage.mock.calls.length).toBe(3))
    const next = view.worker.postMessage.mock.calls[2][0]
    if (next.type !== "range") throw new Error("Missing scrolled viewport")
    expect(next.rows[0]).toBeGreaterThan(490)
    expect(next.columns[0]).toBeGreaterThan(25)
    expect(next.rows.length * next.columns.length).toBeLessThan(500)
    expect(view.host.querySelector("img")).toBeNull()
    view.worker.send({ id: next.id, type: "range", sheet: 1, cells: [cell("normal format")] })
    expect(view.host.querySelector(".xlsx-warning")).not.toBeNull()
  })

  test("ignores old sheet results and releases worker, timer and image URLs when closed", async () => {
    const view = mount()
    loaded(view.worker)
    await vi.waitFor(() => expect(view.worker.postMessage.mock.calls.length).toBe(2))
    const first = view.worker.postMessage.mock.calls[1][0]
    view.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click()
    await new Promise((resolve) => setTimeout(resolve, 25))
    view.worker.send({ id: first.id, type: "range", sheet: 1, cells: [cell("stale")] })
    expect(view.host.textContent).not.toContain("stale")
    await vi.waitFor(() => expect(view.worker.postMessage.mock.calls.length).toBe(3))
    const second = view.worker.postMessage.mock.calls[2][0]
    expect(second).toMatchObject({ type: "range", sheet: 2 })
    view.worker.send({ id: first.id, type: "range", sheet: 1, cells: [cell("stale again")] })
    view.worker.send({ id: second.id, type: "range", sheet: 2, cells: [cell("current")] })
    expect(view.host.querySelector('[role="gridcell"]')?.textContent).toBe("current")
    const callback = view.worker.onmessage
    view.close()
    expect(view.worker.terminate).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:worksheet-image")
    callback?.({ data: { id: second.id, type: "range", sheet: 2, cells: [cell("closed")] } } as MessageEvent<Reply>)
    expect(view.error).not.toHaveBeenCalled()
  })

  test("terminates parsing on cancel without applying a late result", () => {
    const view = mount()
    expect(view.host.textContent).toContain("正在加载工作簿")
    view.host.querySelector<HTMLButtonElement>("button")!.click()
    expect(view.worker.terminate).toHaveBeenCalledTimes(1)
    expect(view.error.mock.calls[0][0].message).toBe("已取消工作簿预览。")
    loaded(view.worker)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  test("terminates a timed-out worker with a translated retry explanation", () => {
    vi.useFakeTimers()
    const view = mount()
    vi.advanceTimersByTime(30_000)
    expect(view.worker.terminate).toHaveBeenCalledTimes(1)
    expect(view.error.mock.calls[0][0].message).toContain("解析超时")
    expect(view.error.mock.calls[0][0].message).toContain("重新加载")
  })

  test("reports worker startup and parser errors instead of falling back to the main thread", () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("Worker blocked")
        }
      },
    )
    const blocked = mount()
    expect(blocked.error.mock.calls[0][0].message).toBe("Worker blocked")
    vi.stubGlobal("Worker", MockWorker)
    const view = mount()
    view.worker.send({ id: 1, type: "error", message: "Invalid workbook" })
    expect(view.error.mock.calls[0][0].message).toBe("Invalid workbook")
    expect(view.worker.terminate).toHaveBeenCalledTimes(1)
  })
})
