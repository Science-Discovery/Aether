import { describe, expect, test } from "bun:test"
import { read } from "./preview-read"

describe("preview stream budget", () => {
  test("reads real bytes without relying on a content length", async () => {
    expect(new TextDecoder().decode(await read(new Response("hello"), new AbortController().signal, 10))).toBe("hello")
  })
  test("rejects declared size before reading its body", async () => {
    let cancelled = false
    const body = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    await expect(
      read(new Response(body, { headers: { "Content-Length": "11" } }), new AbortController().signal, 10),
    ).rejects.toHaveProperty("name", "QuotaExceededError")
    expect(cancelled).toBe(true)
  })
  test("cancels an unknown or misleading size stream when actual bytes exceed budget", async () => {
    let cancelled = false
    let size = 0
    const body = new ReadableStream({
      pull(controller) {
        size++
        controller.enqueue(new Uint8Array(6))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(
      read(new Response(body, { headers: { "Content-Length": "1" } }), new AbortController().signal, 10),
    ).rejects.toHaveProperty("name", "QuotaExceededError")
    expect(cancelled).toBe(true)
    expect(size).toBeLessThan(5)
  })
  test("does not consume a read that was cancelled before starting", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(read(new Response("bytes"), controller.signal)).rejects.toHaveProperty("name", "AbortError")
  })
  test("cancels a pending read when no more chunks arrive and releases its reader", async () => {
    const controller = new AbortController()
    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({
      pull() {
        start()
        return new Promise<void>(() => {})
      },
      cancel() {
        cancelled++
      },
    })
    const task = read(new Response(body), controller.signal)
    await started
    controller.abort()
    await expect(task).rejects.toHaveProperty("name", "AbortError")
    expect(cancelled).toBe(1)
    expect(body.locked).toBe(false)
  })
})
