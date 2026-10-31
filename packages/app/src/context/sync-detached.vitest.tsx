import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { State } from "./global-sync/types"
import { resetSessionPrefetch } from "./global-sync/session-prefetch"
import { SyncProvider, useSync } from "./sync"
import { SDKProvider } from "./sdk"
import { applyDirectoryEvent } from "./global-sync/event-reducer"

const calls = vi.hoisted(() => ({
  child: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  messages: vi.fn(),
  client: vi.fn(),
  update: vi.fn(),
}))
vi.mock("./global-sync", () => ({
  useGlobalSync: () => ({
    child: calls.child,
    session: { update: calls.update },
    onReconnect: () => () => {},
    todo: { set() {} },
  }),
}))
vi.mock("./global-sdk", () => ({
  useGlobalSDK: () => ({ createClient: calls.client, event: { on: () => () => {} }, url: "http://localhost" }),
}))
vi.mock("./language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@solidjs/router", () => ({ useNavigate: () => () => {} }))

const disposers: (() => void)[] = []
const child = () =>
  ({
    id: "child",
    directory: "/project",
    title: "Fork",
    parentID: "parent",
    treeID: "old",
    forkParentSessionID: "parent",
    time: { created: 1, updated: 1 },
  }) as Session
const root = () =>
  ({
    ...child(),
    parentID: undefined,
    forkParentSessionID: undefined,
    treeID: "new",
    time: { created: 1, updated: 2 },
  }) as Session

function mount() {
  const [store, setStore] = createStore({
    status: "complete",
    path: { directory: "/project" },
    session: [child(), { ...child(), id: "parent", parentID: undefined, forkParentSessionID: undefined }],
    sessionTotal: 1,
    message: {},
    part: {},
    permission: {},
    question: {},
    todo: {},
    session_status: {},
    session_diff: {},
    preference: {},
    limit: 5,
  } as State)
  calls.child.mockReturnValue([store, setStore])
  calls.update.mockImplementation((info: Session) =>
    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info } },
      store,
      setStore,
      directory: info.directory,
      push() {},
      loadLsp() {},
    }),
  )
  const value: { sync?: ReturnType<typeof useSync> } = {}
  const Read = () => {
    value.sync = useSync()
    return null
  }
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    render(
      () => (
        <SDKProvider directory={() => "/project"}>
          <SyncProvider>
            <Read />
          </SyncProvider>
        </SDKProvider>
      ),
      host,
    ),
  )
  return { store, sync: value.sync! }
}

beforeEach(() => {
  vi.resetAllMocks()
  resetSessionPrefetch()
  calls.messages.mockResolvedValue({ data: [], response: { headers: new Headers() } })
  calls.client.mockReturnValue({ session: { get: calls.get, list: calls.list, messages: calls.messages } })
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
  resetSessionPrefetch()
})

describe("SyncProvider detached session reads", () => {
  test("forwards session updates through the global reducer", () => {
    const view = mount()
    const info = root()
    view.sync.session.update(info)
    expect(calls.update).toHaveBeenCalledExactlyOnceWith(info)
    expect(view.sync.session.get("child")).toEqual(info)
    expect(view.store.sessionTotal).toBe(2)
  })

  test("a force GET started before detach cannot reattach the new root when its response arrives later", async () => {
    const response = Promise.withResolvers<{ data: Session }>()
    calls.get.mockReturnValue(response.promise)
    const view = mount()
    const pending = view.sync.session.sync("child", { force: true })
    await vi.waitFor(() => expect(calls.get).toHaveBeenCalledExactlyOnceWith({ sessionID: "child" }))
    view.sync.session.update(root())
    response.resolve({ data: child() })
    await pending
    expect(view.sync.session.get("child")).toEqual(root())
    expect(view.store.sessionTotal).toBe(2)
    expect(view.store.session.map((session) => session.id)).toEqual(["child", "parent"])
  })

  test("a delayed session.fetch list cannot overwrite detached metadata or duplicate the root", async () => {
    const response = Promise.withResolvers<{ data: Session[] }>()
    calls.list.mockReturnValue(response.promise)
    const view = mount()
    const pending = view.sync.session.fetch()
    view.sync.session.update(root())
    response.resolve({ data: [child()] })
    await pending
    expect(view.sync.session.get("child")).toEqual(root())
    expect(view.store.sessionTotal).toBe(2)
    expect(view.store.session.map((session) => session.id)).toEqual(["child", "parent"])
  })

  test("a newer GET still refreshes session metadata", async () => {
    const info = { ...child(), title: "Renamed", time: { created: 1, updated: 3 } }
    calls.get.mockResolvedValue({ data: info })
    const view = mount()
    await view.sync.session.sync("child", { force: true })
    expect(view.sync.session.get("child")).toEqual(info)
  })

  test("a GET that first observes the detached root counts its transition once before the detach response", async () => {
    calls.get.mockResolvedValue({ data: root() })
    const view = mount()
    await view.sync.session.sync("child", { force: true })
    expect(view.store.sessionTotal).toBe(2)
    view.sync.session.update(root())
    view.sync.session.update(root())
    expect(view.store.sessionTotal).toBe(2)
    expect(view.sync.session.get("child")).toEqual(root())
  })

  test("a list that first observes the detached root counts its transition once before later events", async () => {
    calls.list.mockResolvedValue({ data: [root()] })
    const view = mount()
    await view.sync.session.fetch()
    expect(view.store.sessionTotal).toBe(2)
    view.sync.session.update(root())
    expect(view.store.sessionTotal).toBe(2)
  })
})
