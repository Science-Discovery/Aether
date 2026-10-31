import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { GlobalSyncProvider, useGlobalSync } from "./global-sync"

const calls = vi.hoisted(() => ({ create: vi.fn(), listen: vi.fn(), bootstrap: vi.fn() }))
vi.mock("./global-sdk", () => ({
  useGlobalSDK: () => ({ client: {}, createClient: calls.create, event: { listen: calls.listen } }),
}))
vi.mock("./language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("./platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
vi.mock("./global-sync/bootstrap", () => ({
  bootstrapGlobal: async () => {},
  bootstrapDirectory: calls.bootstrap,
  resolveProject: () => undefined,
}))

const disposers: (() => void)[] = []
const child = {
  id: "b",
  parentID: "a",
  forkParentSessionID: "a",
  title: "Branch B",
  directory: "/source",
  treeID: "old",
  time: { created: 1, updated: 1 },
} as Session

function mount() {
  const value: { sync?: ReturnType<typeof useGlobalSync> } = {}
  const Read = () => {
    value.sync = useGlobalSync()
    return null
  }
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    render(
      () => (
        <GlobalSyncProvider>
          <Read />
        </GlobalSyncProvider>
      ),
      host,
    ),
  )
  return value.sync!
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  calls.listen.mockReturnValue(() => {})
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
  localStorage.clear()
})

describe("global session updates outside directory providers", () => {
  test("updates only the response directory and keeps newer metadata and root counts", () => {
    const sync = mount()
    const [source, setSource] = sync.child("/source", { bootstrap: false })
    const [other, setOther] = sync.child("/other", { bootstrap: false })
    setSource("session", [{ ...child, id: "a", parentID: undefined, forkParentSessionID: undefined }, child])
    setSource("sessionTotal", 1)
    setOther("session", [{ ...child, id: "other", directory: "/other" }])
    const root = {
      ...child,
      parentID: undefined,
      forkParentSessionID: undefined,
      treeID: "new",
      time: { created: 1, updated: 2 },
    }
    sync.session.update(root)
    sync.session.update({ ...child, time: { created: 1, updated: 1 } })
    sync.session.update(root)
    expect(source.session[1]).toEqual(root)
    expect(source.sessionTotal).toBe(2)
    expect(other.session.map((session) => session.id)).toEqual(["other"])
    expect(calls.create).not.toHaveBeenCalled()
    expect(calls.bootstrap).not.toHaveBeenCalled()
  })

  test("accepts an update for an unopened directory without bootstrapping services", () => {
    const sync = mount()
    sync.session.update({ ...child, directory: "/unopened" })
    const [store] = sync.child("/unopened", { bootstrap: false })
    expect(store.session.map((session) => session.id)).toEqual([child.id])
    expect(store.session[0].directory).toBe("/unopened")
    expect(calls.create).not.toHaveBeenCalled()
    expect(calls.bootstrap).not.toHaveBeenCalled()
  })
})
