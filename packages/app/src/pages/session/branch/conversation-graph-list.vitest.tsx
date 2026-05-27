import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { ConversationGraphList } from "./conversation-graph-list"
import type { ConversationGraphEdge, ConversationGraphNode } from "./conversation-graph-model"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { children?: unknown; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => ({
  DropdownMenu: Object.assign((props: { children?: unknown }) => props.children, {
    Trigger: (props: { children?: unknown }) => props.children,
    Portal: (props: { children?: unknown }) => props.children,
    Content: (props: { children?: unknown }) => props.children,
    Item: (props: { children?: unknown }) => props.children,
    ItemLabel: (props: { children?: unknown }) => props.children,
  }),
}))

const node = (input: {
  id: string
  sessionID: string
  label: string
  displayRow: number
  displayLane: number
  colorIndex?: number
  isCurrentPath?: boolean
  isCurrentTarget?: boolean
  kind?: ConversationGraphNode["kind"]
  userMessageID?: string
}): ConversationGraphNode => ({
  id: input.id,
  sessionID: input.sessionID,
  label: input.label,
  displayRow: input.displayRow,
  displayLane: input.displayLane,
  colorIndex: input.colorIndex ?? 0,
  isCurrentPath: input.isCurrentPath ?? false,
  isCurrentTarget: input.isCurrentTarget ?? false,
  kind: input.kind ?? "turn",
  userMessageID: input.userMessageID ?? `${input.id}-user`,
  lane: input.displayLane,
  row: input.displayRow,
  time: input.displayRow + 1,
  origin: "tree",
})

const edge = (input: {
  from: string
  to: string
  isCurrentPath?: boolean
  kind?: ConversationGraphEdge["kind"]
  style?: ConversationGraphEdge["style"]
}): ConversationGraphEdge => ({
  id: `${input.from}->${input.to}`,
  from: input.from,
  to: input.to,
  isCurrentPath: input.isCurrentPath ?? false,
  kind: input.kind ?? "continuation",
  style: input.style ?? "solid",
})

function mount(props: {
  currentSessionID?: string
  nodes: ConversationGraphNode[]
  edges?: ConversationGraphEdge[]
}) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <ConversationGraphList
        currentSessionID={props.currentSessionID ?? "session-child"}
        nodes={props.nodes}
        edges={props.edges ?? []}
        laneCount={2}
        rowHeight={24}
        labelClass="text-12-medium"
        onSelect={() => undefined}
        onFork={() => undefined}
        onRename={() => undefined}
        showRowActions={false}
      />
    ),
    host,
  )
  return { host, off }
}

function rowLabel(host: HTMLElement, text: string) {
  return [...host.querySelectorAll("[data-graph-node-label]")].find(
    (element) => element.textContent?.trim() === text,
  ) as HTMLDivElement | undefined
}

function nodeCircle(host: HTMLElement, id: string) {
  return host.querySelector(`[data-graph-node-circle="${id}"]`) as SVGCircleElement | null
}

function edgePath(host: HTMLElement, id: string) {
  return host.querySelector(`[data-graph-edge-id="${id}"]`) as SVGPathElement | null
}

beforeEach(() => {
  document.body.innerHTML = ""
})

afterEach(() => {
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

describe("ConversationGraphList path text highlighting", () => {
  test("highlights inherited prefix labels that belong to the current path", () => {
    const { host, off } = mount({
      nodes: [
        node({ id: "root-1", sessionID: "session-root", label: "1+1", displayRow: 0, displayLane: 0, isCurrentPath: true }),
        node({ id: "root-2", sessionID: "session-root", label: "1+2", displayRow: 1, displayLane: 0, isCurrentPath: true }),
        node({
          id: "child-1",
          sessionID: "session-child",
          label: "2+2",
          displayRow: 2,
          displayLane: 1,
          isCurrentPath: true,
          isCurrentTarget: true,
        }),
      ],
      edges: [
        edge({ from: "root-1", to: "root-2", isCurrentPath: true }),
        edge({ from: "root-2", to: "child-1", isCurrentPath: true, kind: "branch" }),
      ],
    })

    expect(rowLabel(host, "1+1")?.className).toContain("text-text-strong")
    expect(rowLabel(host, "1+2")?.className).toContain("text-text-strong")
    expect(rowLabel(host, "2+2")?.className).toContain("text-text-strong")
    expect(rowLabel(host, "1+1")?.className).toContain("font-semibold")
    expect(rowLabel(host, "2+2")?.className).toContain("font-semibold")

    off()
  })

  test("keeps sibling branch labels weak when they are not on the current path", () => {
    const { host, off } = mount({
      nodes: [
        node({ id: "root-1", sessionID: "session-root", label: "1+1", displayRow: 0, displayLane: 0, isCurrentPath: true }),
        node({ id: "root-2", sessionID: "session-root", label: "1+2", displayRow: 1, displayLane: 0, isCurrentPath: true }),
        node({
          id: "child-current",
          sessionID: "session-child",
          label: "2+2",
          displayRow: 2,
          displayLane: 1,
          isCurrentPath: true,
          isCurrentTarget: true,
        }),
        node({
          id: "child-sibling",
          sessionID: "session-sibling",
          label: "3+3",
          displayRow: 3,
          displayLane: 0,
          isCurrentPath: false,
        }),
      ],
      edges: [
        edge({ from: "root-1", to: "root-2", isCurrentPath: true }),
        edge({ from: "root-2", to: "child-current", isCurrentPath: true, kind: "branch" }),
        edge({ from: "root-2", to: "child-sibling", isCurrentPath: false, kind: "branch" }),
      ],
    })

    expect(rowLabel(host, "1+1")?.className).toContain("text-text-strong")
    expect(rowLabel(host, "2+2")?.className).toContain("text-text-strong")
    expect(rowLabel(host, "3+3")?.className).toContain("text-text-weaker")
    expect(rowLabel(host, "3+3")?.className).toContain("opacity-100")

    off()
  })

  test("dims non-current nodes and labels while keeping current edges unchanged", () => {
    const { host, off } = mount({
      nodes: [
        node({ id: "root-1", sessionID: "session-root", label: "1+1", displayRow: 0, displayLane: 0, isCurrentPath: true }),
        node({
          id: "child-current",
          sessionID: "session-child",
          label: "2+2",
          displayRow: 1,
          displayLane: 1,
          isCurrentPath: true,
        }),
        node({
          id: "child-sibling",
          sessionID: "session-sibling",
          label: "3+3",
          displayRow: 2,
          displayLane: 0,
          isCurrentPath: false,
        }),
      ],
      edges: [
        edge({ from: "root-1", to: "child-current", isCurrentPath: true, kind: "branch" }),
        edge({ from: "root-1", to: "child-sibling", isCurrentPath: false, kind: "branch" }),
      ],
    })

    expect(nodeCircle(host, "root-1")?.getAttribute("opacity")).toBe("1")
    expect(nodeCircle(host, "child-current")?.getAttribute("opacity")).toBe("1")
    expect(nodeCircle(host, "child-sibling")?.getAttribute("opacity")).toBe("0.5")

    expect(rowLabel(host, "1+1")?.className).toContain("font-semibold")
    expect(rowLabel(host, "2+2")?.className).toContain("font-semibold")
    expect(rowLabel(host, "1+1")?.className).not.toContain("opacity-100")
    expect(rowLabel(host, "2+2")?.className).not.toContain("opacity-100")
    expect(rowLabel(host, "3+3")?.className).toContain("opacity-100")

    expect(edgePath(host, "root-1->child-current")?.getAttribute("opacity")).toBe("1")
    expect(edgePath(host, "root-1->child-sibling")?.getAttribute("opacity")).toBe("0.4")

    off()
  })
})
