import { describe, expect, test } from "bun:test"
import type { Event, Todo } from "@opencode-ai/sdk/v2/client"
import { createServer, type RequestListener } from "node:http"
import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ServerConnection } from "@/context/server"
import { connectShared } from "./shared-connection"
import { applyDirectoryEvent } from "./global-sync/event-reducer"
import type { State } from "./global-sync/types"

const directory = "/tmp/todo-live-sync"

const todo = (content: string, status: Todo["status"]): Todo => ({ content, status, priority: "high" })

const v1 = [todo("task one", "in_progress"), todo("task two", "pending")]
const v2 = [todo("task one", "completed"), todo("task two", "in_progress")]
const v3 = [todo("task one", "completed"), todo("task two", "completed")]

function baseState(input: Partial<State> = {}) {
  return {
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory } as State["path"],
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
  } as State
}

async function until(check: () => boolean, ms: number, label: string) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timeout waiting for: ${label}`)
}

async function startEventServer() {
  const clients = new Set<import("node:http").ServerResponse>()
  const handler: RequestListener = (req, res) => {
    if (req.url !== "/global/event") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
      return
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    clients.add(res)
    res.write(
      `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`,
    )
    res.on("close", () => clients.delete(res))
  }
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    push(type: string, properties: unknown) {
      const payload = { type, properties } as Event
      for (const res of clients) res.write(`data: ${JSON.stringify({ directory, payload })}\n\n`)
    },
    stop: () => server.close(),
  }
}

describe("todo live sync over real SSE", () => {
  test("todo.updated events reach the frontend stores in real time and heal a stale list", async () => {
    const http = await startEventServer()

    // Mirrors the production listener in global-sync.tsx: the todo.updated
    // handler writes the global session_todo cache, then applyDirectoryEvent
    // writes the per-directory child store the dock timeline reads.
    const [globalStore, setGlobalStore] = createStore({ session_todo: {} as Record<string, Todo[]> })
    const setSessionTodo = (sessionID: string, todos: Todo[]) => {
      setGlobalStore("session_todo", sessionID, reconcile(todos))
    }
    const [store, setStore] = createStore(baseState())

    const ctrl = new AbortController()
    const conn = connectShared({
      server: { url: http.url } as ServerConnection.HttpBase,
      signal: ctrl.signal,
      // happy-dom hijacks globalThis.fetch in bun test and blocks cross-origin
      // SSE; route through Bun's native fetch like a real browser would.
      fetch: ((input, init) => Bun.fetch(input, init)) as typeof fetch,
    })

    let connected = false
    void (async () => {
      for await (const event of conn.stream) {
        if (event.payload.type === "server.connected") {
          connected = true
          continue
        }
        if (event.payload.type !== "todo.updated") continue
        const props = event.payload.properties as { sessionID: string; todos: Todo[] }
        batch(() => {
          setSessionTodo(props.sessionID, props.todos)
          applyDirectoryEvent({
            event: event.payload,
            directory,
            store,
            setStore,
            push() {},
            loadLsp() {},
          })
        })
      }
    })()

    try {
      const sessionID = "ses_todo"
      await until(() => connected, 5000, "sse stream connected")

      http.push("todo.updated", { sessionID, todos: v1 })
      await until(
        () => globalStore.session_todo[sessionID]?.length === 2 && store.todo[sessionID]?.length === 2,
        5000,
        "initial todo list arrives in real time",
      )
      expect(globalStore.session_todo[sessionID]).toEqual(v1)
      expect(store.todo[sessionID]).toEqual(v1)

      http.push("todo.updated", { sessionID, todos: v2 })
      await until(
        () => globalStore.session_todo[sessionID]?.[1]?.status === "in_progress",
        5000,
        "mid-turn update arrives in real time",
      )
      expect(store.todo[sessionID]).toEqual(v2)

      // The issue scenario: the client missed the final todowrite update, so
      // both stores stay on v2 while server truth has already moved to v3.
      await until(
        () => globalStore.session_todo[sessionID]?.[1]?.status === "in_progress",
        100,
        "stores keep the stale list while no event is sent",
      )

      // Follow-up turn: the prompt loop re-asserts stored truth at step start
      // (see Todo.publish in packages/opencode), which is this event.
      http.push("todo.updated", { sessionID, todos: v3 })
      await until(
        () => globalStore.session_todo[sessionID]?.[1]?.status === "completed",
        5000,
        "re-asserted truth heals the stale list",
      )
      expect(globalStore.session_todo[sessionID]).toEqual(v3)
      expect(store.todo[sessionID]).toEqual(v3)
    } finally {
      ctrl.abort()
      conn.destroy()
      http.stop()
    }
  }, 30_000)
})
