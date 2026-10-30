import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import type { SessionGraphResult } from "@opencode-ai/sdk/v2"
import { SidebarBranchView } from "./sidebar-branch-view"

const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  navigate: vi.fn(),
  toggle: vi.fn(),
  compact: vi.fn(),
  hash: "",
  rows: () => [] as Array<{ id: string; role: "user" | "assistant" }>,
  parts: () => ({}) as Record<string, Array<{ type: "text"; text: string; synthetic?: boolean }>>,
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({ createClient: () => ({ session: { graph: mocks.graph } }) }),
}))

vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({
    child: () => [
      {
        message: {
          get refresh() {
            return mocks.rows()
          },
        },
        get part() {
          return mocks.parts()
        },
      },
    ],
  }),
}))

vi.mock("@solidjs/router", () => ({
  useParams: () => ({ dir: "project" }),
  useLocation: () => mocks,
  useNavigate: () => mocks.navigate,
}))

vi.mock("@/context/layout", () => ({
  useLayout: () => ({ pendingToggle: { set: mocks.toggle } }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({ locale: () => "en", t: (key: string) => key }),
}))

vi.mock("@/context/settings", () => ({
  useSettings: () => ({
    general: {
      branchGraphCompact: () => true,
      setBranchGraphCompact: mocks.compact,
      branchGraphFontSize: () => "md",
      branchGraphRowDensity: () => "compact",
      branchGraphOrderMode: () => "time",
    },
  }),
}))

const graph = (sessionID: string): Extract<SessionGraphResult, { kind: "graph" }> => ({
  kind: "graph",
  treeID: sessionID,
  current: { sessionID, pathNodeIDs: ["first", "middle", "last"], targetNodeID: "last" },
  nodes: ["first", "middle", "last"].map((id, row) => ({
    id,
    kind: "turn",
    sessionID,
    userMessageID: `${sessionID}-${id}`,
    lane: 0,
    row,
    time: [30, 10, 20][row],
    label: id,
    origin: "tree",
  })),
  edges: [
    { id: "first->middle", from: "first", to: "middle", kind: "continuation", style: "solid" },
    { id: "middle->last", from: "middle", to: "last", kind: "continuation", style: "solid" },
  ],
})

const disposals: Array<() => void> = []

function mount(sessionID: string, linear: boolean) {
  const host = document.createElement("div")
  document.body.append(host)
  mocks.graph.mockResolvedValue({ data: graph(sessionID) })
  disposals.push(
    render(
      () => (
        <SidebarBranchView sessionID={sessionID} currentSessionID={sessionID} directory="/project" linear={linear} />
      ),
      host,
    ),
  )
  return host
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hash = ""
  mocks.rows = () => []
  mocks.parts = () => ({})
  window.localStorage.clear()
})

afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
})

describe("SidebarBranchView linear history", () => {
  test("keeps every Codex message in conversation order and locates the fork's own message", async () => {
    const host = mount("fork", true)
    await vi.waitFor(() => expect(host.querySelectorAll("[data-graph-node-id]")).toHaveLength(3))
    expect(mocks.graph).toHaveBeenCalledWith({ sessionID: "fork" })
    expect([...host.querySelectorAll("[data-graph-node-label]")].map((row) => row.textContent)).toEqual([
      "first",
      "middle",
      "last",
    ])
    expect(
      new Set([...host.querySelectorAll("[data-graph-node-circle]")].map((node) => node.getAttribute("cx"))).size,
    ).toBe(1)
    expect(host.querySelector('[aria-label="Switch to full view"]')).toBeNull()
    expect(mocks.compact).not.toHaveBeenCalled()

    const row = host.querySelector<HTMLElement>('[data-graph-node-id="middle"]')!
    row.click()
    expect(mocks.navigate).toHaveBeenCalledWith("/project/session/fork#message-fork-middle")

    const message = document.createElement("div")
    message.id = "message-fork-middle"
    document.body.append(message)
    mocks.hash = "#message-fork-middle"
    row.click()
    expect(mocks.toggle).toHaveBeenCalledWith("project/fork", "fork-middle")
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
  })

  test("retains the shared compact setting for Aether conversation graphs", async () => {
    const host = mount("aether", false)
    await vi.waitFor(() => expect(host.querySelectorAll("[data-graph-node-id]")).toHaveLength(2))
    expect(host.querySelector('[data-graph-node-id="middle"]')).toBeNull()
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Switch to full view"]')!
    expect(button).not.toBeNull()
    button.click()
    expect(mocks.compact).toHaveBeenCalledWith(false)
  })

  test("refreshes an open native history after message sync without refreshing for assistant updates", async () => {
    const [rows, change] = createSignal<Array<{ id: string; role: "user" | "assistant" }>>([
      { id: "first", role: "user" },
      { id: "middle", role: "user" },
      { id: "last", role: "user" },
    ])
    mocks.rows = rows
    const [parts, update] = createSignal<ReturnType<typeof mocks.parts>>({})
    mocks.parts = parts
    const host = mount("refresh", true)
    await vi.waitFor(() => expect(host.querySelectorAll("[data-graph-node-id]")).toHaveLength(3))
    expect(mocks.graph).toHaveBeenCalledTimes(1)
    change((prev) => [...prev, { id: "response", role: "assistant" }])
    update({ response: [{ type: "text", text: "Streaming assistant text" }] })
    await Promise.resolve()
    expect(mocks.graph).toHaveBeenCalledTimes(1)

    const updated = graph("refresh")
    updated.nodes.push({
      ...updated.nodes[2],
      id: "synced",
      userMessageID: "refresh-synced",
      row: 3,
      label: "(no text)",
    })
    updated.edges.push({ id: "last->synced", from: "last", to: "synced", kind: "continuation", style: "solid" })
    mocks.graph.mockResolvedValue({ data: updated })
    change((prev) => [...prev, { id: "synced", role: "user" }])
    await vi.waitFor(() => expect(host.querySelectorAll("[data-graph-node-id]")).toHaveLength(4))
    expect(mocks.graph).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-graph-node-label="synced"]')?.textContent).toBe("(no text)")
    mocks.graph.mockResolvedValue({
      data: {
        ...updated,
        nodes: updated.nodes.map((node) => (node.id === "synced" ? { ...node, label: "synced" } : node)),
      },
    })
    update((prev) => ({ ...prev, synced: [{ type: "text", text: "synced" }] }))
    await vi.waitFor(() => expect(host.querySelector('[data-graph-node-label="synced"]')?.textContent).toBe("synced"))
    expect(mocks.graph).toHaveBeenCalledTimes(3)
    host.querySelector<HTMLElement>('[data-graph-node-id="synced"]')!.click()
    expect(mocks.navigate).toHaveBeenCalledWith("/project/session/refresh#message-refresh-synced")
  })
})
