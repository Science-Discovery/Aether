import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { KnowledgeProvider, useKnowledge, type KnowledgeState } from "./knowledge"
import { useGlobalSync } from "./global-sync"

vi.mock("./global-sync", async () => {
  const { createStore } = await import("solid-js/store")
  const [data, set] = createStore({ config: { knowledge: { enabled: false } }, url: "https://first.test" })
  return { useGlobalSync: () => ({ ready: true, data, set }) }
})
vi.mock("./global-sdk", async () => {
  const { useGlobalSync } = await import("./global-sync")
  return {
    useGlobalSDK: () => ({
      get url() {
        return (useGlobalSync().data as { url?: string }).url
      },
      auth: () => ({ Authorization: "Basic test" }),
    }),
  }
})
vi.mock("./server", async () => {
  const { useGlobalSync } = await import("./global-sync")
  return {
    useServer: () => ({
      current: {
        http: {
          get url() {
            return (useGlobalSync().data as { url?: string }).url
          },
        },
      },
    }),
  }
})
vi.mock("./language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))

const control = useGlobalSync() as unknown as {
  set: (...args: unknown[]) => void
}
const sample = (id = "kb1"): KnowledgeState => ({
  knowledgeBases: [
    {
      id,
      path: `/docs/${id}`,
      name: id,
      embeddingProvider: "local",
      embeddingModel: "test",
      chunkSize: 500,
      chunkOverlap: 50,
      documentCount: 7,
    },
  ],
  activeIdsBySession: { session1: [id] },
})
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

let dispose: VoidFunction | undefined
let knowledge: ReturnType<typeof useKnowledge>
let remote = sample()
const calls: Array<{ url: string; method: string; signal?: AbortSignal | null }> = []

const mount = () => {
  const host = document.createElement("div")
  document.body.append(host)
  const Read = () => {
    knowledge = useKnowledge()
    return null
  }
  dispose = render(
    () => (
      <KnowledgeProvider>
        <Read />
      </KnowledgeProvider>
    ),
    host,
  )
}

beforeEach(() => {
  remote = sample()
  calls.length = 0
  control.set("url", "https://first.test")
  control.set("config", "knowledge", "enabled", false)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({ url, method: options?.method ?? "GET", signal: options?.signal })
      if (url.endsWith("/state")) return json(remote)
      if (url.endsWith("/discover")) return json({ found: [] })
      if (url.endsWith("/stats")) return json({ totalDocuments: 9, pdfFileCount: 2, lastSyncedAt: 100 })
      return json({})
    }),
  )
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("knowledge feature master", () => {
  test("reads saved configuration while off without discovery, stats, or overwriting it", async () => {
    mount()
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    expect(knowledge.available()).toBe(false)
    expect(knowledge.activeIds("session1")).toEqual(["kb1"])
    expect(knowledge.activeKnowledgeBases("session1")).toEqual([])
    expect(knowledge.knowledgeBases()[0].documentCount).toBe(7)
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/knowledge/state"])
  })

  test("reenabling restores selections and starts stats refresh", async () => {
    mount()
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    control.set("config", "knowledge", "enabled", true)
    await vi.waitFor(() => expect(knowledge.knowledgeBases()[0].documentCount).toBe(9))
    expect(knowledge.activeKnowledgeBases("session1").map((kb) => kb.id)).toEqual(["kb1"])
    control.set("config", "knowledge", "enabled", false)
    expect(knowledge.activeIds("session1")).toEqual(["kb1"])
    expect(knowledge.enabled("session1")).toBe(false)
  })

  test("disabled operations do not send requests", async () => {
    mount()
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    await expect(knowledge.syncKnowledgeBase("kb1")).rejects.toThrow("knowledge.disabled")
    await expect(knowledge.importDocument("kb1", "/docs/test.pdf")).rejects.toThrow("knowledge.disabled")
    expect(await knowledge.search("test", 5, "session1")).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test("session creation transfers draft selections even when the master was turned off", async () => {
    remote.activeIdsBySession.__new__ = ["kb1"]
    mount()
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    expect(knowledge.available()).toBe(false)
    knowledge.rekey("__new__", "new-session")
    expect(knowledge.activeIds("new-session")).toEqual(["kb1"])
    expect(knowledge.activeIds("__new__")).toEqual([])
    expect(knowledge.activeKnowledgeBases("new-session")).toEqual([])
  })

  test("session creation during metadata loading queues draft ownership in order", async () => {
    const response = deferred<Response>()
    remote.activeIdsBySession.__new__ = ["kb1"]
    const saved: KnowledgeState[] = []
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (options?.method === "POST") {
        saved.push(JSON.parse(String(options.body)).data as KnowledgeState)
        return json({ ok: true })
      }
      return response.promise
    })
    mount()
    knowledge.rekey("__new__", "first-session")
    knowledge.rekey("__new__", "second-session")
    response.resolve(json(remote))
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    expect(knowledge.activeIds("first-session")).toEqual(["kb1"])
    expect(knowledge.activeIds("second-session")).toEqual([])
    expect(knowledge.activeIds("__new__")).toEqual([])
    await vi.waitFor(() => expect(saved).toHaveLength(1), { timeout: 1000 })
    expect(saved[0].activeIdsBySession).toMatchObject({ "first-session": ["kb1"], __new__: [] })
  })

  test("failed initialization never saves empty or partially edited state", async () => {
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET" })
      return new Response("unavailable", { status: 503 })
    })
    mount()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    knowledge.setActive(["new-selection"], "session1")
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(knowledge.ready()).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test("failed metadata can retry while off, coalescing clicks and preserving saved data", async () => {
    let failed = true
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET" })
      if (failed) return new Response("unavailable", { status: 503 })
      return json(remote)
    })
    mount()
    await vi.waitFor(() => expect(knowledge.error()).toContain("unavailable"))
    expect(knowledge.ready()).toBe(false)
    failed = false
    await Promise.all([knowledge.retry(), knowledge.retry()])
    expect(knowledge.error()).toBeUndefined()
    expect(knowledge.ready()).toBe(true)
    expect(knowledge.available()).toBe(false)
    expect(knowledge.activeIds("session1")).toEqual(["kb1"])
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/knowledge/state", "/knowledge/state"])
    await knowledge.retry()
    expect(calls).toHaveLength(2)
  })

  test("uninitialized and disabled mutators cannot replace saved configuration", async () => {
    const response = deferred<Response>()
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).endsWith("/state")) return response.promise
      return json({ totalDocuments: 7, pdfFileCount: 0 })
    })
    control.set("config", "knowledge", "enabled", true)
    mount()
    await vi.waitFor(() => expect(knowledge.ready()).toBe(false))
    knowledge.setActive(["other"], "session1")
    knowledge.toggleActive("other", "session1")
    knowledge.saveLastConfig({ provider: "other", model: "other", apiKey: "", baseURL: "", dimensions: 4 })
    expect(() => knowledge.addKnowledgeBase(sample().knowledgeBases[0])).toThrow("knowledge.disabled")
    response.resolve(json(remote))
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    control.set("config", "knowledge", "enabled", false)
    knowledge.setActive(["other"], "session1")
    knowledge.toggleActive("other", "session1")
    knowledge.updateKnowledgeBase("kb1", { name: "other" })
    expect(knowledge.activeIds("session1")).toEqual(["kb1"])
    expect(knowledge.knowledgeBases()[0].name).toBe("kb1")
    expect(knowledge.getLastConfig()).toBeUndefined()
  })

  test("disabling cancels refresh and rejects late stats", async () => {
    const result = deferred<Response>()
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET", signal: options?.signal })
      if (String(url).endsWith("/stats")) return result.promise
      return json(remote)
    })
    control.set("config", "knowledge", "enabled", true)
    mount()
    await vi.waitFor(() => expect(calls.some((call) => call.url.endsWith("/stats"))).toBe(true))
    const call = calls.find((call) => call.url.endsWith("/stats"))!
    control.set("config", "knowledge", "enabled", false)
    expect(call.signal?.aborted).toBe(true)
    result.resolve(json({ totalDocuments: 999, pdfFileCount: 999 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(knowledge.knowledgeBases()[0].documentCount).toBe(7)
    expect(knowledge.activeIds("session1")).toEqual(["kb1"])
  })

  test("server switching rejects old metadata and isolates saved state", async () => {
    const old = deferred<Response>()
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET", signal: options?.signal })
      if (String(url).startsWith("https://first.test")) return old.promise
      const next = sample("kb2")
      next.activeIdsBySession.__new__ = ["kb2"]
      return json(next)
    })
    mount()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    knowledge.rekey("__new__", "old-session")
    control.set("url", "https://second.test")
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    old.resolve(json(sample("kb1")))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(knowledge.knowledgeBases().map((kb) => kb.id)).toEqual(["kb2"])
    expect(knowledge.activeIds("session1")).toEqual(["kb2"])
    expect(knowledge.activeIds("__new__")).toEqual(["kb2"])
    expect(knowledge.activeIds("old-session")).toEqual([])
    expect(calls[0].signal?.aborted).toBe(true)
  })

  test("shutdown cancels the sync reader and clears progress", async () => {
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start: body.resolve,
      cancel: () => {
        cancelled = true
      },
    })
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? "GET", signal: options?.signal })
      if (String(url).endsWith("/state")) return json(remote)
      if (String(url).endsWith("/stats")) return json({ totalDocuments: 7, pdfFileCount: 0 })
      if (String(url).endsWith("/sync")) return new Response(stream)
      return json({})
    })
    control.set("config", "knowledge", "enabled", true)
    mount()
    await vi.waitFor(() => expect(knowledge.ready()).toBe(true))
    const pending = knowledge.syncKnowledgeBase("kb1").catch((error: Error) => error)
    const writer = await body.promise
    await vi.waitFor(() => expect(calls.some((call) => call.url.endsWith("/sync"))).toBe(true))
    writer.enqueue(new TextEncoder().encode('event: progress\ndata: {"current":1,"total":2}\n\n'))
    await vi.waitFor(() => expect(knowledge.syncProgress()).toEqual({ current: 1, total: 2 }))
    control.set("config", "knowledge", "enabled", false)
    expect(await pending).toMatchObject({ name: "AbortError" })
    expect(cancelled).toBe(true)
    expect(knowledge.syncProgress()).toBeNull()
    expect(knowledge.activeIds("session1")).toEqual(["kb1"])
  })
})
