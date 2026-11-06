import { describe, expect, test } from "bun:test"
import { createKnowledgeClient } from "./knowledge-client"

const json = (value: unknown) => new Response(JSON.stringify(value))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe("knowledge request lifecycle", () => {
  test("disabled features allow saved metadata but do not start work", async () => {
    const paths: string[] = []
    const client = createKnowledgeClient({
      url: () => "https://aether.test",
      auth: () => ({}),
      enabled: () => false,
      disabled: () => "disabled",
      fetch: async (url) => {
        paths.push(String(url))
        return json({ saved: true })
      },
    })
    await expect(client.request("/knowledge/discover")).rejects.toThrow("disabled")
    expect(paths).toEqual([])
    expect(await client.request<{ saved: boolean }>("/knowledge/state", {}, false)).toEqual({ saved: true })
    expect(paths).toEqual(["https://aether.test/knowledge/state"])
  })

  test("uses authenticated reads and preserves explicit request headers", async () => {
    let headers: Headers | undefined
    const client = createKnowledgeClient({
      url: () => "https://aether.test",
      auth: () => ({ Authorization: "Basic test" }),
      enabled: () => true,
      disabled: () => "disabled",
      fetch: async (_url, options) => {
        headers = new Headers(options?.headers)
        return json({ value: 1 })
      },
    })
    expect(
      await client.request<{ value: number }>("/knowledge/test/stats", { headers: new Headers({ "X-Test": "value" }) }),
    ).toEqual({
      value: 1,
    })
    expect(headers?.get("Authorization")).toBe("Basic test")
    expect(headers?.get("X-Test")).toBe("value")
  })

  test("feature shutdown cancels work while keeping metadata requests", async () => {
    const work = deferred<Response>()
    const metadata = deferred<Response>()
    const signals: AbortSignal[] = []
    const client = createKnowledgeClient({
      url: () => "https://aether.test",
      auth: () => ({}),
      enabled: () => true,
      disabled: () => "disabled",
      fetch: async (url, options) => {
        signals.push(options!.signal!)
        return String(url).endsWith("/state") ? metadata.promise : work.promise
      },
    })
    const pending = client.request("/knowledge/test/search")
    const saved = client.request("/knowledge/state", {}, false)
    client.reset(true)
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    work.resolve(json({ late: true }))
    metadata.resolve(json({ saved: true }))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(await saved).toEqual({ saved: true })
  })

  test("late JSON bodies stay cancelled after the feature is reenabled", async () => {
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>()
    const stream = new ReadableStream<Uint8Array>({ start: body.resolve })
    const client = createKnowledgeClient({
      url: () => "https://aether.test",
      auth: () => ({}),
      enabled: () => true,
      disabled: () => "disabled",
      fetch: async () => new Response(stream),
    })
    const pending = client.request("/knowledge/test/stats")
    const writer = await body.promise
    await Promise.resolve()
    client.reset(true)
    writer.enqueue(new TextEncoder().encode('{"late":true}'))
    writer.close()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("changing server rejects old metadata even when fetch ignores cancellation", async () => {
    const response = deferred<Response>()
    let url = "https://first.test"
    const client = createKnowledgeClient({
      url: () => url,
      auth: () => ({}),
      enabled: () => true,
      disabled: () => "disabled",
      fetch: async () => response.promise,
    })
    const pending = client.request("/knowledge/state", {}, false)
    url = "https://second.test"
    client.reset()
    response.resolve(json({ old: true }))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("caller cancellation propagates and server errors remain visible", async () => {
    const response = deferred<Response>()
    const abort = new AbortController()
    const client = createKnowledgeClient({
      url: () => "https://aether.test",
      auth: () => ({}),
      enabled: () => true,
      disabled: () => "disabled",
      fetch: async () => response.promise,
    })
    const pending = client.request("/knowledge/test/sync", { signal: abort.signal })
    abort.abort()
    response.resolve(json({ late: true }))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })

    const failing = createKnowledgeClient({
      url: () => "https://aether.test",
      auth: () => ({}),
      enabled: () => true,
      disabled: () => "disabled",
      fetch: async () => new Response("service unavailable", { status: 503 }),
    })
    await expect(failing.request("/knowledge/state", {}, false)).rejects.toThrow("service unavailable")
  })
})
