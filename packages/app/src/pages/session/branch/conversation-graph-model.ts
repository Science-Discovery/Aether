import type { SessionGraphEdge, SessionGraphNode, SessionGraphResult } from "@opencode-ai/sdk/v2"

export type ConversationGraph = Extract<SessionGraphResult, { kind: "graph" }>

export type ConversationGraphNode = SessionGraphNode & {
  displayRow: number
  isCurrentPath: boolean
  isCurrentTarget: boolean
}

export type ConversationGraphEdge = SessionGraphEdge & {
  isCurrentPath: boolean
}

export type ConversationGraphView = {
  nodes: ConversationGraphNode[]
  edges: ConversationGraphEdge[]
  laneCount: number
}

const edgeMaps = (edges: SessionGraphEdge[]) => {
  const incoming = new Map<string, SessionGraphEdge[]>()
  const outgoing = new Map<string, SessionGraphEdge[]>()

  for (const edge of edges) {
    const nextIncoming = incoming.get(edge.to)
    if (nextIncoming) nextIncoming.push(edge)
    else incoming.set(edge.to, [edge])

    const nextOutgoing = outgoing.get(edge.from)
    if (nextOutgoing) nextOutgoing.push(edge)
    else outgoing.set(edge.from, [edge])
  }

  return { incoming, outgoing }
}

const collapseVisibleEdges = (
  nodesByID: Map<string, SessionGraphNode>,
  visibleNodeIDs: Set<string>,
  edges: SessionGraphEdge[],
  currentPathPairs: Set<string>,
) => {
  const { outgoing } = edgeMaps(edges)
  const result = new Map<string, ConversationGraphEdge>()

  for (const sourceID of visibleNodeIDs) {
    const startEdges = outgoing.get(sourceID) ?? []
    for (const startEdge of startEdges) {
      let style = startEdge.style
      let kind = startEdge.kind
      let isCurrentPath = currentPathPairs.has(`${startEdge.from}->${startEdge.to}`)
      let cursor = startEdge.to
      const visited = new Set<string>()

      while (!visibleNodeIDs.has(cursor) && !visited.has(cursor)) {
        visited.add(cursor)
        const nextEdges = outgoing.get(cursor) ?? []
        if (nextEdges.length !== 1) break
        const [nextEdge] = nextEdges
        if (nextEdge.style === "dashed") style = "dashed"
        if (kind === "continuation" && nextEdge.kind !== "continuation") kind = nextEdge.kind
        if (currentPathPairs.has(`${nextEdge.from}->${nextEdge.to}`)) isCurrentPath = true
        cursor = nextEdge.to
      }

      if (!visibleNodeIDs.has(cursor)) continue

      const finalKind = nodesByID.get(cursor)?.kind === "bud" ? "bud" : kind
      const edgeID = `${sourceID}->${cursor}`
      result.set(edgeID, {
        id: edgeID,
        from: sourceID,
        to: cursor,
        kind: finalKind,
        style,
        isCurrentPath,
      })
    }
  }

  return [...result.values()]
}

export function buildConversationGraphView(input: {
  graph: ConversationGraph
  compact: boolean
}): ConversationGraphView {
  const nodesByID = new Map(input.graph.nodes.map((node) => [node.id, node] as const))
  const sortedNodes = [...input.graph.nodes].sort((a, b) => a.row - b.row || a.lane - b.lane || a.id.localeCompare(b.id))
  const currentPathNodeIDs = new Set(input.graph.current.pathNodeIDs)
  const currentPathPairs = new Set(
    input.graph.current.pathNodeIDs.slice(1).map((to, index) => `${input.graph.current.pathNodeIDs[index]}->${to}`),
  )

  let visibleNodeIDs = new Set(sortedNodes.map((node) => node.id))
  let edges = input.graph.edges.map((edge) => ({
    ...edge,
    isCurrentPath: currentPathPairs.has(edge.id),
  }))

  if (input.compact) {
    const { incoming, outgoing } = edgeMaps(input.graph.edges)
    visibleNodeIDs = new Set(
      sortedNodes
        .filter((node) => {
          if (node.kind === "bud") return true
          const inbound = incoming.get(node.id)?.length ?? 0
          const outbound = outgoing.get(node.id)?.length ?? 0
          return inbound !== 1 || outbound !== 1
        })
        .map((node) => node.id),
    )
    edges = collapseVisibleEdges(nodesByID, visibleNodeIDs, input.graph.edges, currentPathPairs)
  }

  const nodes = sortedNodes
    .filter((node) => visibleNodeIDs.has(node.id))
    .map((node, displayRow) => ({
      ...node,
      displayRow,
      isCurrentPath: currentPathNodeIDs.has(node.id),
      isCurrentTarget: input.graph.current.targetNodeID === node.id,
    }))

  const laneCount = nodes.reduce((max, node) => Math.max(max, node.lane), 0) + 1

  return {
    nodes,
    edges: edges.filter((edge) => visibleNodeIDs.has(edge.from) && visibleNodeIDs.has(edge.to)),
    laneCount,
  }
}
