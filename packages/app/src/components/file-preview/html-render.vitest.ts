import { afterEach, describe, expect, test, vi } from "vitest"
import { htmlRender } from "./html-render"
import type { HtmlRead } from "./html-convert"
import type { HtmlRequest, HtmlResponse } from "./html-bridge"

class Channel {
  onmessage: ((event: MessageEvent<HtmlResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: HtmlRequest[] = []
  stopped = 0
  postMessage(message: HtmlRequest) {
    this.messages.push(message)
  }
  terminate() {
    this.stopped++
  }
  send(message: HtmlResponse) {
    this.onmessage?.({ data: message } as MessageEvent<HtmlResponse>)
  }
}

function setup(read: HtmlRead = async () => ({ data: new ArrayBuffer(1), mime: "image/png" })) {
  const channel = new Channel()
  const controller = new AbortController()
  const start = (draft?: (path: string) => string | undefined) =>
    htmlRender({
      path: "site/index.html",
      source: "<p>test</p>",
      signal: controller.signal,
      read,
      draft,
      worker: () => channel as unknown as Worker,
    })
  return { channel, controller, start }
}

afterEach(() => vi.useRealTimers())

describe("HTML preview worker lifecycle", () => {
  test("returns the completed document and immediately terminates the worker", async () => {
    const fixture = setup()
    const task = fixture.start()
    expect(fixture.channel.messages[0]).toEqual({ type: "render", path: "site/index.html", source: "<p>test</p>" })
    const result = { html: "<p>rendered</p>", deps: ["style.css"], missing: 0, blocked: 1 }
    fixture.channel.send({ type: "done", result })
    expect(await task).toEqual(result)
    expect(fixture.channel.stopped).toBe(1)
    expect(fixture.channel.onmessage).toBeNull()
    fixture.controller.abort()
    expect(fixture.channel.stopped).toBe(1)
  })
  test("aborts resource reads, drops late responses and releases callbacks", async () => {
    let signal: AbortSignal | undefined
    let resolve: ((file: { data: ArrayBuffer; mime: string }) => void) | undefined
    const fixture = setup((_path, next) => {
      signal = next
      return new Promise((done) => {
        resolve = done
      })
    })
    const task = fixture.start()
    const result = expect(task).rejects.toMatchObject({ name: "AbortError" })
    fixture.channel.send({ type: "read", id: 1, path: "image.png" })
    await Promise.resolve()
    expect(signal?.aborted).toBe(false)
    fixture.controller.abort()
    await result
    expect(signal?.aborted).toBe(true)
    resolve?.({ data: new ArrayBuffer(1), mime: "image/png" })
    await Promise.resolve()
    expect(fixture.channel.messages).toHaveLength(1)
    expect(fixture.channel.stopped).toBe(1)
    expect(fixture.channel.onerror).toBeNull()
  })
  test("uses an empty CSS draft without requesting disk bytes", async () => {
    const read = vi.fn<HtmlRead>()
    const fixture = setup(read)
    const task = fixture.start((path) => (path === "style.css" ? "" : undefined))
    fixture.channel.send({ type: "read", id: 2, path: "style.css" })
    await Promise.resolve()
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    expect(fixture.channel.messages[1]).toMatchObject({ type: "resource", id: 2, mime: "text/css" })
    const message = fixture.channel.messages[1]
    expect(message?.type === "resource" ? message.data.byteLength : -1).toBe(0)
    fixture.channel.send({ type: "done", result: { html: "", deps: ["style.css"], missing: 0, blocked: 0 } })
    await task
  })
  test("returns resource errors to the worker so the readable page can still render", async () => {
    const fixture = setup(async () => {
      throw new Error("File not found")
    })
    const task = fixture.start()
    fixture.channel.send({ type: "read", id: 3, path: "missing.png" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.channel.messages[1]).toEqual({ type: "failure", id: 3, message: "File not found" })
    fixture.channel.send({ type: "done", result: { html: "text", deps: ["missing.png"], missing: 1, blocked: 0 } })
    expect((await task).missing).toBe(1)
  })
  test("terminates a silent or unresponsive worker on timeout", async () => {
    vi.useFakeTimers()
    const fixture = setup()
    const task = fixture.start()
    const result = expect(task).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(45_000)
    await result
    expect(fixture.channel.stopped).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  test("cleans up failed workers and refuses to start an already aborted request", async () => {
    const fixture = setup()
    const task = fixture.start()
    const result = expect(task).rejects.toThrow("parse failed")
    fixture.channel.send({ type: "error", message: "parse failed" })
    await result
    expect(fixture.channel.stopped).toBe(1)
    const stopped = setup()
    stopped.controller.abort()
    await expect(stopped.start()).rejects.toMatchObject({ name: "AbortError" })
    expect(stopped.channel.messages).toHaveLength(0)
  })
  test("terminates and reports failures to transfer a request", async () => {
    const fixture = setup()
    fixture.channel.postMessage = () => {
      throw new DOMException("not transferable", "DataCloneError")
    }
    await expect(fixture.start()).rejects.toMatchObject({ name: "DataCloneError" })
    expect(fixture.channel.stopped).toBe(1)
    expect(fixture.channel.onmessage).toBeNull()
  })
})
