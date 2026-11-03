import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { State } from "./global-sync/types"
import { createReconnectTracker } from "./global-sync/reconnect"
import { markViewing } from "./global-sync/viewing"
import { resetSessionPrefetch } from "./global-sync/session-prefetch"
import { SyncProvider, useSync } from "./sync"

const hooks = vi.hoisted(() => ({ global: () => ({}), sdk: () => ({}) }))
vi.mock("./global-sync", () => ({ useGlobalSync: () => hooks.global() }))
vi.mock("./sdk", () => ({ useSDK: () => hooks.sdk() }))
vi.mock("./language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@solidjs/router", () => ({ useNavigate: () => () => undefined }))

const directory = "/sync-recovery"
const id = "session"
const session = { id, directory, time: { created: 1, updated: 1 } } as Session
const user = (id: string, created: number): Message => ({
  id,
  sessionID: "session",
  role: "user",
  time: { created },
  agent: "agent",
  model: { providerID: "codex", modelID: "model" },
})
const text = (id: string, messageID: string, value: string): Part => ({
  id,
  sessionID: "session",
  messageID,
  type: "text",
  text: value,
})
type Row = { info: Message; parts: Part[] }
const response = (rows: Row[], cursor?: string) => ({
  data: rows,
  response: new Response(undefined, { headers: cursor ? { "x-next-cursor": cursor } : undefined }),
})
let dispose: VoidFunction

beforeEach(() => resetSessionPrefetch())
afterEach(() => {
  dispose?.()
  markViewing()
  resetSessionPrefetch()
})

function setup() {
  const scope = { server: "http://sync-test" }
  const reconnect = createReconnectTracker()
  const [store, setStore] = createStore<State>({
    status: "complete",
    path: { directory },
    session: [session],
    message: {},
    part: {},
    session_status: {},
    limit: 10,
  } as State)
  const messages = vi.fn(async (_input: { limit: number; before?: string }) => response([]))
  const status = vi.fn(async (): Promise<{ data: Record<string, SessionStatus> }> => ({ data: {} }))
  const get = vi.fn(async () => ({ data: session }))
  hooks.global = () => ({
    child: () => [store, setStore],
    onReconnect: reconnect.listen,
    todo: { set: () => undefined },
  })
  hooks.sdk = () => ({
    get url() {
      return scope.server
    },
    directory,
    client: { session: { messages, status, get } },
  })
  let sync!: ReturnType<typeof useSync>
  function Child() {
    sync = useSync()
    return null
  }
  dispose = render(
    () => (
      <SyncProvider>
        <Child />
      </SyncProvider>
    ),
    document.createElement("div"),
  )
  markViewing(id)
  return { sync, store, setStore, messages, status, get, reconnect, scope }
}

test("reconnect recovers a viewed conversation completed while SSE was disconnected", async () => {
  const test = setup()
  test.messages.mockResolvedValue(response([{ info: user("first", 1), parts: [] }]))
  await test.sync.session.sync(id)
  test.setStore("session_status", id, { type: "busy" })
  const assistant: Message = {
    id: "reply",
    sessionID: id,
    role: "assistant",
    parentID: "first",
    time: { created: 2, completed: 3 },
    modelID: "model",
    providerID: "codex",
    mode: "agent",
    agent: "agent",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  test.messages.mockResolvedValue(
    response([
      { info: user("first", 1), parts: [] },
      { info: assistant, parts: [text("answer", "reply", "Saved while offline")] },
    ]),
  )
  test.reconnect.fire()
  await vi.waitFor(() => expect(test.store.part.reply?.[0]).toMatchObject({ text: "Saved while offline" }))
  expect(test.store.message[id].at(-1)).toMatchObject({ role: "assistant", time: { completed: 3 } })
  await vi.waitFor(() => expect(test.store.session_status[id]?.type).toBe("idle"))
})

test("force refresh preserves the loaded window and newer live messages, parts, and deletions", async () => {
  const test = setup()
  const rows = Array.from({ length: 90 }, (_, index) => ({
    info: user(`message-${index}`, index),
    parts: [text(`text-${index}`, `message-${index}`, "before")],
  }))
  test.messages.mockResolvedValue(response(rows.slice(0, 2)))
  await test.sync.session.sync(id)
  test.setStore(
    "message",
    id,
    rows.map((row) => row.info),
  )
  for (const row of rows) test.setStore("part", row.info.id, row.parts)
  const pending = Promise.withResolvers<ReturnType<typeof response>>()
  test.messages.mockReturnValueOnce(pending.promise)
  const reading = test.sync.session.sync(id, { force: true })
  await vi.waitFor(() => expect(test.messages).toHaveBeenCalledTimes(2))
  test.setStore("message", id, (messages) => [...messages.slice(1), user("streamed", 100)])
  test.setStore("part", "message-1", [text("text-1", "message-1", "new live content")])
  test.setStore("part", "message-2", [])
  test.setStore("part", "streamed", [text("streamed-text", "streamed", "new live message")])
  pending.resolve(response(rows))
  await reading
  expect(test.messages.mock.calls[1][0].limit).toBeGreaterThanOrEqual(90)
  expect(test.store.message[id].some((message) => message.id === "message-0")).toBe(false)
  expect(test.store.message[id].at(-1)?.id).toBe("streamed")
  expect(test.store.part["message-1"][0]).toMatchObject({ text: "new live content" })
  expect(test.store.part["message-2"]).toEqual([])
})

test("reconnect queues a fresh read after an older snapshot already in flight", async () => {
  const test = setup()
  const pending = Promise.withResolvers<ReturnType<typeof response>>()
  test.messages.mockReturnValueOnce(pending.promise)
  const reading = test.sync.session.sync(id)
  await vi.waitFor(() => expect(test.messages).toHaveBeenCalledTimes(1))
  test.messages.mockResolvedValue(response([{ info: user("latest", 2), parts: [text("last", "latest", "Recovered")] }]))
  test.reconnect.fire()
  pending.resolve(response([{ info: user("old", 1), parts: [] }]))
  await reading
  await vi.waitFor(() => expect(test.store.part.latest?.[0]).toMatchObject({ text: "Recovered" }))
  expect(test.messages).toHaveBeenCalledTimes(2)
})

test("an explicit force request is not swallowed by a normal read already in flight", async () => {
  const test = setup()
  const pending = Promise.withResolvers<ReturnType<typeof response>>()
  test.messages.mockReturnValueOnce(pending.promise)
  const reading = test.sync.session.sync(id)
  await vi.waitFor(() => expect(test.messages).toHaveBeenCalledTimes(1))
  test.messages.mockResolvedValue(response([{ info: user("latest", 2), parts: [] }]))
  const forced = test.sync.session.sync(id, { force: true })
  pending.resolve(response([{ info: user("old", 1), parts: [] }]))
  await Promise.all([reading, forced])
  expect(test.messages).toHaveBeenCalledTimes(2)
  expect(test.status).toHaveBeenCalledTimes(1)
  expect(test.store.message[id].at(-1)?.id).toBe("latest")
})

test("force waits for an older history page and then fetches the latest window", async () => {
  const test = setup()
  test.messages.mockResolvedValueOnce(response([{ info: user("first", 2), parts: [] }], "older"))
  await test.sync.session.sync(id)
  const pending = Promise.withResolvers<ReturnType<typeof response>>()
  test.messages.mockReturnValueOnce(pending.promise)
  const older = test.sync.session.history.loadMore(id)
  await vi.waitFor(() => expect(test.messages).toHaveBeenCalledTimes(2))
  test.messages.mockResolvedValue(
    response([
      { info: user("older", 1), parts: [] },
      { info: user("first", 2), parts: [] },
      { info: user("latest", 3), parts: [text("latest-text", "latest", "Missed update")] },
    ]),
  )
  const forced = test.sync.session.sync(id, { force: true })
  pending.resolve(response([{ info: user("older", 1), parts: [] }]))
  await Promise.all([older, forced])
  expect(test.messages).toHaveBeenCalledTimes(3)
  expect(test.messages.mock.calls[1][0].before).toBe("older")
  expect(test.messages.mock.calls[2][0].before).toBeUndefined()
  expect(test.store.part.latest?.[0]).toMatchObject({ text: "Missed update" })
})

test("a late status or metadata snapshot cannot replace a newer live event", async () => {
  const test = setup()
  test.messages.mockResolvedValue(response([{ info: user("first", 1), parts: [] }]))
  await test.sync.session.sync(id)
  test.setStore("session_status", id, { type: "busy" })
  const status = Promise.withResolvers<{ data: Record<string, SessionStatus> }>()
  const metadata = Promise.withResolvers<{ data: Session }>()
  test.status.mockReturnValueOnce(status.promise)
  test.get.mockReturnValueOnce(metadata.promise)
  const reading = test.sync.session.sync(id, { force: true })
  await vi.waitFor(() => expect(test.status).toHaveBeenCalledTimes(1))
  test.setStore("session_status", id, { type: "idle" })
  test.setStore("session", 0, { title: "New live title", time: { created: 1, updated: 20 } })
  status.resolve({ data: { [id]: { type: "busy" } } })
  metadata.resolve({ data: { ...session, title: "Old title", time: { created: 1, updated: 10 } } })
  await reading
  expect(test.store.session_status[id]?.type).toBe("idle")
  expect(test.store.session[0].title).toBe("New live title")
})

test("a previous server response cannot populate the current server's view", async () => {
  const test = setup()
  const pending = Promise.withResolvers<ReturnType<typeof response>>()
  test.messages.mockReturnValueOnce(pending.promise)
  const reading = test.sync.session.sync(id)
  await vi.waitFor(() => expect(test.messages).toHaveBeenCalledTimes(1))
  test.scope.server = "http://another-server"
  pending.resolve(response([{ info: user("old", 1), parts: [text("old-part", "old", "Other server")] }]))
  await reading
  expect(test.store.message[id]).toBeUndefined()
})
