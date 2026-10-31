import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import type { SessionGraphResult } from "@opencode-ai/sdk/v2"
import { SidebarBranchView } from "./sidebar-branch-view"

const calls = vi.hoisted(() => ({ graph: vi.fn() }))
vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({ createClient: () => ({ session: { graph: calls.graph } }) }),
}))
vi.mock("@solidjs/router", () => ({
  useParams: () => ({ dir: "project" }),
  useLocation: () => ({ hash: "" }),
  useNavigate: () => () => {},
}))
vi.mock("@/context/layout", () => ({ useLayout: () => ({}) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en", t: (key: string) => key }) }))
vi.mock("@/context/settings", () => ({
  useSettings: () => ({
    general: {
      branchGraphCompact: () => false,
      branchGraphFontSize: () => "lg",
      branchGraphRowDensity: () => "xcompact",
      branchGraphOrderMode: () => "time",
    },
  }),
}))

const disposers: (() => void)[] = []
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
})

describe("SidebarBranchView requests", () => {
  test("graph responses do not retrigger the loading effect, and a refresh triggers exactly one request", async () => {
    const first = Promise.withResolvers<{ data: SessionGraphResult }>()
    const second = Promise.withResolvers<{ data: SessionGraphResult }>()
    calls.graph.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const [state, setState] = createStore({ key: "before" })
    const host = document.createElement("div")
    document.body.append(host)
    disposers.push(
      render(
        () => (
          <SidebarBranchView
            sessionID="request-test"
            currentSessionID="request-test"
            directory="/project"
            refreshKey={state.key}
          />
        ),
        host,
      ),
    )
    expect(calls.graph).toHaveBeenCalledExactlyOnceWith({ sessionID: "request-test" })
    const graph = (): SessionGraphResult => ({
      kind: "graph",
      treeID: "tree",
      current: { sessionID: "request-test", pathNodeIDs: [] },
      nodes: [],
      edges: [],
    })
    first.resolve({ data: graph() })
    await vi.waitFor(() => expect(host.textContent).toContain("No branch view available."))
    expect(calls.graph).toHaveBeenCalledTimes(1)
    setState("key", "after")
    expect(calls.graph).toHaveBeenCalledTimes(2)
    second.resolve({ data: graph() })
    await vi.waitFor(() => expect(host.textContent).toContain("No branch view available."))
    expect(calls.graph).toHaveBeenCalledTimes(2)
  })
})
