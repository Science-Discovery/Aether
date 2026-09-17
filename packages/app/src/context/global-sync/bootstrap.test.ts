import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Todo } from "@opencode-ai/sdk/v2/client"
import { createServer, type RequestListener } from "node:http"
import { createStore } from "solid-js/store"
import { bootstrapDirectory } from "./bootstrap"
import type { State, VcsCache } from "./types"

const oldOne: Todo[] = [{ content: "old one", status: "in_progress", priority: "high" }]
const oldBroken: Todo[] = [{ content: "old broken", status: "pending", priority: "low" }]
const oldThree: Todo[] = [{ content: "old three", status: "in_progress", priority: "medium" }]
const nextOne: Todo[] = [{ content: "task one", status: "completed", priority: "high" }]
const nextThree: Todo[] = [
  { content: "task three a", status: "completed", priority: "low" },
  { content: "task three b", status: "in_progress", priority: "medium" },
]

async function startServer() {
  let brokenHits = 0
  const handler: RequestListener = (req, res) => {
    const match = (req.url ?? "").match(/^\/session\/([\w-]+)\/todo$/)
    const body = (() => {
      if (!match) return "[]"
      if (match[1] === "ses_1") return JSON.stringify(nextOne)
      if (match[1] === "ses_3") return JSON.stringify(nextThree)
      if (match[1] === "ses_broken") {
        brokenHits += 1
        res.statusCode = 500
        return "boom"
      }
      return "[]"
    })()
    res.writeHead(res.statusCode === 500 ? 500 : 200, { "Content-Type": "application/json" })
    res.end(body)
  }
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => brokenHits,
    stop: () => server.close(),
  }
}

// Built by hand instead of createOpencodeClient: other test files mock.module
// the sdk entrypoint and bun leaks that mock across files, which would swap
// this client for a stub without the lazy service getters.
function sdkFor(url: string) {
  const get = async (path: string) => {
    const res = await Bun.fetch(new URL(path, url))
    return { data: await res.json() }
  }
  return {
    project: { current: () => get("/project/current") },
    path: { get: () => get("/path") },
    session: {
      status: () => get("/session/status"),
      todo: (input: { sessionID: string }) => get(`/session/${input.sessionID}/todo`),
    },
    vcs: { get: () => get("/vcs") },
    permission: { list: () => get("/permission") },
    question: { list: () => get("/question") },
  } as unknown as OpencodeClient
}

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "loading",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: { all: [], connected: [], default: {} } as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    preference: {} as State["preference"],
    ...input,
  }) as State

describe("bootstrapDirectory todo refresh", () => {
  test("refetches cached todos, tolerates per-session failure", async () => {
    const http = await startServer()
    try {
      const [store, setStore] = createStore(
        baseState({ todo: { ses_1: oldOne, ses_broken: oldBroken, ses_3: oldThree } }),
      )
      const setTodos: Array<[string, Todo[] | undefined]> = []
      const vcsCache = { setStore: () => {} } as unknown as VcsCache

      await bootstrapDirectory({
        directory: "/tmp/project",
        sdk: sdkFor(http.url),
        store,
        setStore,
        vcsCache,
        loadSessions: () => {},
        setSessionTodo: (sessionID, todos) => setTodos.push([sessionID, todos]),
        translate: (key) => key,
        global: { config: {}, project: [], provider: { all: [], connected: [], default: {} } },
      })

      expect(store.todo.ses_1).toEqual(nextOne)
      expect(store.todo.ses_3).toEqual(nextThree)
      expect(store.todo.ses_broken).toEqual(oldBroken)
      expect(http.hits()).toBe(1)

      const applied = new Map(setTodos)
      expect(applied.get("ses_1")).toEqual(nextOne)
      expect(applied.get("ses_3")).toEqual(nextThree)
      expect(applied.has("ses_broken")).toBe(false)
    } finally {
      http.stop()
    }
  })

  test("no-op when no todos cached", async () => {
    const http = await startServer()
    try {
      const [store, setStore] = createStore(baseState())
      await bootstrapDirectory({
        directory: "/tmp/project",
        sdk: sdkFor(http.url),
        store,
        setStore,
        vcsCache: { setStore: () => {} } as unknown as VcsCache,
        loadSessions: () => {},
        translate: (key) => key,
        global: { config: {}, project: [], provider: { all: [], connected: [], default: {} } },
      })
      expect(store.todo).toEqual({})
    } finally {
      http.stop()
    }
  })
})
