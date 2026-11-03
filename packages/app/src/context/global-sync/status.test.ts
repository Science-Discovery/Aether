import { expect, test } from "bun:test"
import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { bootstrapDirectory } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { applyDirectoryEvent } from "./event-reducer"
import * as Status from "./status"

function state(statuses: State["session_status"]): State {
  return {
    status: "complete",
    agent: [],
    command: [],
    project: "project",
    projectMeta: undefined,
    icon: undefined,
    provider: { all: [], connected: [], default: {} },
    config: {},
    path: {
      directory: "/status",
      home: "/status",
      state: "/status",
      config: "/status",
      worktree: "/status",
      data: "/status",
    },
    session: [],
    sessionTotal: 0,
    session_status: statuses,
    session_diff: {},
    permission: {},
    question: {},
    todo: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    preference: {},
  }
}

test("bootstrap status preserves live changes while a prior snapshot is pending", async () => {
  const pending = Promise.withResolvers<{ data: Record<string, SessionStatus> }>()
  const started = Promise.withResolvers<void>()
  const [store, setStore] = createStore(state({ changed: { type: "busy" }, cleared: { type: "busy" } }))
  const sdk = {
    project: { current: async () => ({ data: { id: "project" } }) },
    path: { get: async () => ({ data: { directory: "/status" } }) },
    session: {
      status: () => {
        started.resolve()
        return pending.promise
      },
    },
    vcs: { get: async () => ({ data: undefined }) },
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
  } as unknown as OpencodeClient
  const loading = bootstrapDirectory({
    directory: "/status",
    sdk,
    store,
    setStore,
    vcsCache: { setStore: () => {} } as unknown as VcsCache,
    loadSessions: () => {},
    translate: (key) => key,
    global: { config: {}, project: [], provider: { all: [], connected: [], default: {} } },
  })
  await started.promise
  setStore("session_status", "changed", { type: "idle" })
  setStore("session_status", "new", { type: "busy" })
  pending.resolve({ data: { changed: { type: "busy" }, remote: { type: "busy" } } })
  await loading
  expect(store.session_status.changed).toEqual({ type: "idle" })
  expect(store.session_status.new).toEqual({ type: "busy" })
  expect(store.session_status.remote).toEqual({ type: "busy" })
  expect(store.session_status.cleared).toBeUndefined()
})

test("a busy-idle-busy event sequence cannot be overwritten by an older idle response", () => {
  const [store, setStore] = createStore(state({ session: { type: "busy" } }))
  const before = Status.capture(store)
  for (const type of ["idle", "busy"] as const) {
    applyDirectoryEvent({
      directory: "/status",
      event: { type: "session.status", properties: { sessionID: "session", status: { type } } },
      store,
      setStore,
      push: () => {},
      loadLsp: () => {},
    })
  }
  expect(Status.rebase({}, before, store)).toEqual({ session: { type: "busy" } })
})

test("a later accepted HTTP change protects the same value returning during an older request", () => {
  const store = { session_status: { session: { type: "busy" } } as Record<string, SessionStatus> }
  const stale = Status.capture(store)
  store.session_status = Status.rebase({}, Status.capture(store), store)
  store.session_status = Status.rebase({ session: { type: "busy" } }, Status.capture(store), store)
  expect(Status.rebase({}, stale, store)).toEqual({ session: { type: "busy" } })
})

test("a newer HTTP confirmation of the same busy value rejects an older idle response", () => {
  const store = { session_status: { session: { type: "busy" } } as Record<string, SessionStatus> }
  const older = Status.capture(store)
  const newer = Status.capture(store)
  store.session_status = Status.rebase({ session: { type: "busy" } }, newer, store)
  store.session_status = Status.rebase({}, older, store)
  expect(store.session_status).toEqual({ session: { type: "busy" } })
})

test("a newer HTTP confirmation of an empty table rejects an older busy response", () => {
  const store = { session_status: {} as Record<string, SessionStatus> }
  const older = Status.capture(store)
  const newer = Status.capture(store)
  store.session_status = Status.rebase({}, newer, store)
  store.session_status = Status.rebase({ session: { type: "busy" } }, older, store)
  expect(store.session_status).toEqual({})
})

test("a newer HTTP response replaces an older HTTP change after both requests started", () => {
  const store = { session_status: { session: { type: "busy" } } as Record<string, SessionStatus> }
  const older = Status.capture(store)
  const newer = Status.capture(store)
  store.session_status = Status.rebase({}, older, store)
  store.session_status = Status.rebase({ session: { type: "busy" } }, newer, store)
  expect(store.session_status).toEqual({ session: { type: "busy" } })
})

test("an older merge does not relabel preserved optimistic changes as HTTP-origin updates", () => {
  const store = { session_status: { session: { type: "busy" } } as Record<string, SessionStatus> }
  const older = Status.capture(store)
  const newer = Status.capture(store)
  store.session_status.session = { type: "retry", attempt: 1, message: "local", next: 1 }
  store.session_status = Status.rebase({}, older, store)
  store.session_status = Status.rebase({ session: { type: "busy" } }, newer, store)
  expect(store.session_status.session).toEqual({ type: "retry", attempt: 1, message: "local", next: 1 })
})

test("status merging preserves deletion and mutable live changes while accepting unrelated HTTP entries", () => {
  const store = {
    session_status: {
      removed: { type: "busy" },
      changed: { type: "retry", attempt: 1, message: "retry", next: 1 },
      completed: { type: "busy" },
    } as Record<string, SessionStatus>,
  }
  const before = Status.capture(store)
  delete store.session_status.removed
  const retry = store.session_status.changed
  if (retry.type !== "retry") throw new Error("Expected retry status")
  retry.attempt = 2
  expect(Status.rebase({ removed: { type: "busy" }, remote: { type: "busy" } }, before, store)).toEqual({
    changed: { type: "retry", attempt: 2, message: "retry", next: 1 },
    remote: { type: "busy" },
  })
})
