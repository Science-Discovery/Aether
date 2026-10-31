import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { decodeTiff, type TiffReply, type TiffResult } from "./tiff-preview"

const workers: Preview[] = []
const send = vi.fn<(message: ArrayBuffer, transfer: Transferable[]) => void>()
class Preview {
  onmessage: ((event: MessageEvent<TiffReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = send
  terminate = vi.fn()

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    workers.push(this)
  }
}

const image = (): TiffResult => ({
  width: 1,
  height: 1,
  data: new Uint8ClampedArray([255, 0, 0, 255]),
  pages: 1,
})

function closed(worker: Preview) {
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(worker.onmessage).toBeNull()
  expect(worker.onerror).toBeNull()
  expect(worker.onmessageerror).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
}

beforeEach(() => {
  workers.length = 0
  send.mockReset()
  vi.useFakeTimers()
  vi.stubGlobal("Worker", Preview)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("isolated TIFF preview", () => {
  test("transfers the source into a module worker and cleans up after success", async () => {
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, "removeEventListener")
    const input = new ArrayBuffer(8)
    const result = image()
    const promise = decodeTiff(input, abort.signal)
    const worker = workers[0]
    expect(worker.url.pathname).toMatch(/tiff-worker\.ts$/)
    expect(worker.options).toEqual({ type: "module" })
    expect(send).toHaveBeenCalledWith(input, [input])
    worker.onmessage?.(new MessageEvent("message", { data: { result } }))
    await expect(promise).resolves.toBe(result)
    closed(worker)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    abort.abort()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  test.each(["Error", "RangeError"])("preserves %s from the decoder and terminates it", async (name) => {
    const promise = decodeTiff(new ArrayBuffer(8))
    workers[0].onmessage?.(new MessageEvent("message", { data: { error: { name, message: "decode failed" } } }))
    await expect(promise).rejects.toBeInstanceOf(name === "RangeError" ? RangeError : Error)
    await expect(promise).rejects.toMatchObject({ name, message: "decode failed" })
    closed(workers[0])
  })

  test("does not create a worker for an already cancelled request", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(decodeTiff(new ArrayBuffer(8), abort.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(workers).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("terminates on cancellation and ignores a late worker reply", async () => {
    const abort = new AbortController()
    const promise = decodeTiff(new ArrayBuffer(8), abort.signal)
    const handler = workers[0].onmessage!
    abort.abort()
    handler(new MessageEvent("message", { data: { result: image() } }))
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    closed(workers[0])
  })

  test("terminates a stuck worker after five seconds", async () => {
    const promise = decodeTiff(new ArrayBuffer(8))
    const rejection = expect(promise).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(4999)
    expect(workers[0].terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    closed(workers[0])
  })

  test("rejects worker errors without leaving a timer", async () => {
    const promise = decodeTiff(new ArrayBuffer(8))
    const event = new ErrorEvent("error", { message: "worker could not load", cancelable: true })
    workers[0].onerror?.(event)
    await expect(promise).rejects.toThrow("worker could not load")
    expect(event.defaultPrevented).toBe(true)
    closed(workers[0])
  })

  test("rejects unreadable worker messages", async () => {
    const promise = decodeTiff(new ArrayBuffer(8))
    workers[0].onmessageerror?.()
    await expect(promise).rejects.toThrow("could not be read")
    closed(workers[0])
  })

  test.each([null, "invalid", 42])("rejects malformed worker responses: %s", async (data) => {
    const promise = decodeTiff(new ArrayBuffer(8))
    workers[0].onmessage?.(new MessageEvent("message", { data }))
    await expect(promise).rejects.toThrow("Invalid TIFF worker response")
    closed(workers[0])
  })

  test("cleans up if transferring the input throws", async () => {
    send.mockImplementationOnce(() => {
      throw new DOMException("detached source", "DataCloneError")
    })
    await expect(decodeTiff(new ArrayBuffer(8))).rejects.toMatchObject({ name: "DataCloneError" })
    closed(workers[0])
  })

  test("rejects a failed worker constructor without scheduling a timeout", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("worker unavailable")
        }
      },
    )
    await expect(decodeTiff(new ArrayBuffer(8))).rejects.toThrow("worker unavailable")
    expect(vi.getTimerCount()).toBe(0)
  })
})
