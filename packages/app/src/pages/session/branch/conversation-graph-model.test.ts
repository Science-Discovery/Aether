import type { SessionGraphResult } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { buildConversationGraphView } from "./conversation-graph-model"

type GraphPayload = Extract<SessionGraphResult, { kind: "graph" }>
type GraphNode = GraphPayload["nodes"][number]
type GraphEdge = GraphPayload["edges"][number]

const node = (input: {
  id: string
  sessionID: string
  time: number
  lane?: number
  row?: number
  kind?: GraphNode["kind"]
  label?: string
  userMessageID?: string
  origin?: GraphNode["origin"]
}): GraphNode => ({
  id: input.id,
  kind: input.kind ?? "turn",
  sessionID: input.sessionID,
  lane: input.lane ?? 0,
  row: input.row ?? 0,
  time: input.time,
  label: input.label ?? input.id,
  origin: input.origin ?? "tree",
  ...(input.kind === "turn" ? { userMessageID: input.userMessageID ?? `${input.id}-user` } : {}),
})

const edge = (input: {
  from: string
  to: string
  kind?: GraphEdge["kind"]
  style?: GraphEdge["style"]
}): GraphEdge => ({
  id: `${input.from}->${input.to}`,
  from: input.from,
  to: input.to,
  kind: input.kind ?? "continuation",
  style: input.style ?? "solid",
})

const graph = (input: {
  nodes: GraphNode[]
  edges?: GraphEdge[]
  pathNodeIDs?: string[]
  targetNodeID?: string
  sessionID?: string
}): GraphPayload => ({
  kind: "graph",
  treeID: "tree-1",
  current: {
    sessionID: input.sessionID ?? input.nodes.at(-1)?.sessionID ?? "session-root",
    pathNodeIDs: input.pathNodeIDs ?? [],
    latestNodeID: undefined,
    targetNodeID: input.targetNodeID,
  },
  nodes: input.nodes,
  edges: input.edges ?? [],
})

describe("buildConversationGraphView time mode lane compaction", () => {
  test("keeps a linear session on one lane", () => {
    const view = buildConversationGraphView({
      graph: graph({
        nodes: [
          node({ id: "a1", sessionID: "session-a", time: 1 }),
          node({ id: "a2", sessionID: "session-a", time: 2 }),
          node({ id: "a3", sessionID: "session-a", time: 3 }),
        ],
        edges: [edge({ from: "a1", to: "a2" }), edge({ from: "a2", to: "a3" })],
        pathNodeIDs: ["a1", "a2", "a3"],
        targetNodeID: "a3",
      }),
      compact: false,
      orderMode: "time",
    })

    expect(view.nodes.map((item) => item.displayLane)).toEqual([0, 0, 0])
    expect(view.laneCount).toBe(1)
  })

  test("reuses the leftmost released lane for later sessions", () => {
    const view = buildConversationGraphView({
      graph: graph({
        nodes: [
          node({ id: "root-1", sessionID: "root", time: 1, lane: 0 }),
          node({ id: "root-2", sessionID: "root", time: 2, lane: 0 }),
          node({ id: "child-1", sessionID: "child-1", time: 3, lane: 1 }),
          node({ id: "child-2", sessionID: "child-1", time: 4, lane: 1 }),
          node({ id: "child-3", sessionID: "child-2", time: 5, lane: 2 }),
          node({ id: "child-4", sessionID: "child-2", time: 6, lane: 2 }),
        ],
        edges: [
          edge({ from: "root-1", to: "root-2" }),
          edge({ from: "root-2", to: "child-1", kind: "branch" }),
          edge({ from: "child-1", to: "child-2" }),
          edge({ from: "root-2", to: "child-3", kind: "branch" }),
          edge({ from: "child-3", to: "child-4" }),
        ],
      }),
      compact: false,
      orderMode: "time",
    })

    expect(view.nodes.map((item) => [item.id, item.displayLane])).toEqual([
      ["root-1", 0],
      ["root-2", 0],
      ["child-1", 0],
      ["child-2", 0],
      ["child-3", 0],
      ["child-4", 0],
    ])
    expect(view.laneCount).toBe(1)
  })

  test("keeps a session on a stable lane while it is still active", () => {
    const view = buildConversationGraphView({
      graph: graph({
        nodes: [
          node({ id: "a1", sessionID: "session-a", time: 1, lane: 0 }),
          node({ id: "b1", sessionID: "session-b", time: 2, lane: 1 }),
          node({ id: "a2", sessionID: "session-a", time: 3, lane: 0 }),
        ],
        edges: [edge({ from: "a1", to: "a2" }), edge({ from: "a1", to: "b1", kind: "branch" })],
      }),
      compact: false,
      orderMode: "time",
    })

    expect(view.nodes.map((item) => [item.id, item.displayLane])).toEqual([
      ["a1", 0],
      ["b1", 1],
      ["a2", 0],
    ])
    expect(view.laneCount).toBe(2)
  })

  test("preserves time-mode row order while compacting lanes", () => {
    const view = buildConversationGraphView({
      graph: graph({
        nodes: [
          node({ id: "b", sessionID: "session-b", time: 10, lane: 1 }),
          node({ id: "a", sessionID: "session-a", time: 10, lane: 2 }),
          node({ id: "c", sessionID: "session-c", time: 11, lane: 0 }),
        ],
      }),
      compact: false,
      orderMode: "time",
    })

    expect(view.nodes.map((item) => item.id)).toEqual(["b", "a", "c"])
  })

  test("uses the same display lanes in full and compact views", () => {
    const payload = graph({
      nodes: [
        node({ id: "n1", sessionID: "session-a", time: 1, lane: 0 }),
        node({ id: "n2", sessionID: "session-a", time: 2, lane: 0 }),
        node({ id: "n3", sessionID: "session-a", time: 3, lane: 0 }),
      ],
      edges: [edge({ from: "n1", to: "n2" }), edge({ from: "n2", to: "n3" })],
      pathNodeIDs: ["n1", "n2", "n3"],
      targetNodeID: "n3",
    })

    const full = buildConversationGraphView({
      graph: payload,
      compact: false,
      orderMode: "time",
    })
    const compact = buildConversationGraphView({
      graph: payload,
      compact: true,
      orderMode: "time",
    })

    const fullLaneByID = new Map(full.nodes.map((item) => [item.id, item.displayLane] as const))
    expect(compact.nodes.map((item) => [item.id, item.displayLane])).toEqual([
      ["n1", fullLaneByID.get("n1")!],
      ["n3", fullLaneByID.get("n3")!],
    ])
  })

  test("treats bud nodes as part of their session for lane assignment", () => {
    const view = buildConversationGraphView({
      graph: graph({
        nodes: [
          node({ id: "root-1", sessionID: "root", time: 1, lane: 0 }),
          node({ id: "root-2", sessionID: "root", time: 2, lane: 0 }),
          node({ id: "bud-1", sessionID: "branch", time: 3, lane: 1, kind: "bud", label: "", origin: "tree" }),
        ],
        edges: [edge({ from: "root-1", to: "root-2" }), edge({ from: "root-2", to: "bud-1", kind: "bud" })],
        pathNodeIDs: ["root-1", "root-2", "bud-1"],
        targetNodeID: "bud-1",
        sessionID: "branch",
      }),
      compact: false,
      orderMode: "time",
    })

    expect(view.nodes.map((item) => [item.id, item.displayLane])).toEqual([
      ["root-1", 0],
      ["root-2", 0],
      ["bud-1", 0],
    ])
  })
})

describe("buildConversationGraphView sequence mode", () => {
  test("keeps the existing sequence-first layout behavior", () => {
    const view = buildConversationGraphView({
      graph: graph({
        nodes: [
          node({ id: "root-1", sessionID: "root", time: 1, lane: 0 }),
          node({ id: "root-2", sessionID: "root", time: 2, lane: 0 }),
          node({ id: "child-a", sessionID: "child-a", time: 3, lane: 1 }),
          node({ id: "child-b", sessionID: "child-b", time: 4, lane: 2 }),
        ],
        edges: [
          edge({ from: "root-1", to: "root-2" }),
          edge({ from: "root-2", to: "child-a", kind: "branch" }),
          edge({ from: "root-2", to: "child-b", kind: "branch" }),
        ],
      }),
      compact: false,
      orderMode: "sequence",
    })

    expect(view.nodes.map((item) => item.id)).toEqual(["root-1", "root-2", "child-a", "child-b"])
    expect(view.nodes.map((item) => [item.id, item.displayLane])).toEqual([
      ["root-1", 0],
      ["root-2", 0],
      ["child-a", 0],
      ["child-b", 1],
    ])
  })
})
