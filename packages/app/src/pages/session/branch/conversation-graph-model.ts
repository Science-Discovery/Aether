import type { SessionGraphEdge, SessionGraphNode, SessionGraphResult } from "@opencode-ai/sdk/v2"

export type ConversationGraph = Extract<SessionGraphResult, { kind: "graph" }>
export type ConversationGraphOrderMode = "sequence" | "time"

export type ConversationGraphNode = SessionGraphNode & {
  displayRow: number
  displayLane: number
  colorIndex: number
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

const createSequenceMap = (nodes: SessionGraphNode[], edges: SessionGraphEdge[]) => {
  const nodeByID = new Map(nodes.map((node) => [node.id, node] as const))
  const { incoming } = edgeMaps(edges)
  const resolved = new Map<string, number>()
  const visiting = new Set<string>()

  const resolve = (nodeID: string): number => {
    const existing = resolved.get(nodeID)
    if (typeof existing === "number") return existing
    if (visiting.has(nodeID)) return 1

    visiting.add(nodeID)
    const parentEdges = incoming.get(nodeID) ?? []
    let seq = 1
    for (const edge of parentEdges) {
      if (!nodeByID.has(edge.from)) continue
      seq = Math.max(seq, resolve(edge.from) + 1)
    }
    visiting.delete(nodeID)

    resolved.set(nodeID, seq)
    return seq
  }

  for (const node of nodes) {
    resolve(node.id)
  }
  return resolved
}

const createSessionColorIndexMap = (nodes: SessionGraphNode[]) => {
  const earliestBySessionID = new Map<string, number>()

  for (const node of nodes) {
    const earliest = earliestBySessionID.get(node.sessionID)
    if (typeof earliest !== "number" || node.time < earliest) {
      earliestBySessionID.set(node.sessionID, node.time)
    }
  }

  const orderedSessionIDs = [...earliestBySessionID.keys()].sort((left, right) => {
    const timeDiff = (earliestBySessionID.get(left) ?? 0) - (earliestBySessionID.get(right) ?? 0)
    if (timeDiff !== 0) return timeDiff
    return left.localeCompare(right)
  })

  return new Map(orderedSessionIDs.map((sessionID, index) => [sessionID, index] as const))
}

const createDisplayLaneMap = (input: {
  nodes: SessionGraphNode[]
  sortedNodeIDs: string[]
  edges: SessionGraphEdge[]
  orderMode: ConversationGraphOrderMode
}) => {
  if (input.orderMode === "time") {
    return new Map(input.nodes.map((node) => [node.id, node.lane] as const))
  }

  const rowByID = new Map(input.sortedNodeIDs.map((nodeID, row) => [nodeID, row] as const))
  const { incoming } = edgeMaps(input.edges)
  const parentByNodeID = new Map<string, string>()

  for (const nodeID of input.sortedNodeIDs) {
    const nodeRow = rowByID.get(nodeID)
    if (typeof nodeRow !== "number") continue
    const parentID = (incoming.get(nodeID) ?? [])
      .map((edge) => edge.from)
      .filter((candidateID) => {
        const candidateRow = rowByID.get(candidateID)
        return typeof candidateRow === "number" && candidateRow < nodeRow
      })
      .sort((left, right) => (rowByID.get(right) ?? -1) - (rowByID.get(left) ?? -1))[0]

    if (parentID) parentByNodeID.set(nodeID, parentID)
  }

  const childrenByParentID = new Map<string, string[]>()
  for (const [nodeID, parentID] of parentByNodeID) {
    const children = childrenByParentID.get(parentID)
    if (children) children.push(nodeID)
    else childrenByParentID.set(parentID, [nodeID])
  }
  for (const [parentID, children] of childrenByParentID) {
    children.sort((left, right) => (rowByID.get(left) ?? 0) - (rowByID.get(right) ?? 0) || left.localeCompare(right))
    childrenByParentID.set(parentID, children)
  }

  const mainChildByParentID = new Map<string, string>()
  for (const [parentID, children] of childrenByParentID) {
    const first = children[0]
    if (first) mainChildByParentID.set(parentID, first)
  }

  const lastRowByNodeID = new Map<string, number>()
  for (let row = input.sortedNodeIDs.length - 1; row >= 0; row--) {
    const nodeID = input.sortedNodeIDs[row]
    const currentLast = lastRowByNodeID.get(nodeID) ?? row
    const parentID = parentByNodeID.get(nodeID)
    if (parentID) {
      const parentLast = lastRowByNodeID.get(parentID) ?? (rowByID.get(parentID) ?? 0)
      lastRowByNodeID.set(parentID, Math.max(parentLast, currentLast))
    }
    lastRowByNodeID.set(nodeID, Math.max(currentLast, row))
  }

  const releaseRowByLane = new Map<number, number>()
  const displayLaneByNodeID = new Map<string, number>()
  let nextLane = 0

  const listReusableLanes = (row: number) => {
    const reusable: number[] = []
    for (let lane = 0; lane < nextLane; lane++) {
      if ((releaseRowByLane.get(lane) ?? -1) < row) reusable.push(lane)
    }
    return reusable
  }

  const allocateLane = (row: number, minLane: number) => {
    const reusable = listReusableLanes(row).sort((a, b) => a - b)
    const preferred = reusable.find((lane) => lane >= minLane)
    if (typeof preferred === "number") return preferred
    if (reusable.length > 0) return reusable[0]
    const created = nextLane
    nextLane += 1
    return created
  }

  for (let row = 0; row < input.sortedNodeIDs.length; row++) {
    const nodeID = input.sortedNodeIDs[row]
    const parentID = parentByNodeID.get(nodeID)
    const parentLane = parentID ? displayLaneByNodeID.get(parentID) : undefined
    const mainChildID = parentID ? mainChildByParentID.get(parentID) : undefined

    let lane: number
    if (!parentID || typeof parentLane !== "number") {
      lane = allocateLane(row, 0)
    } else if (mainChildID === nodeID) {
      lane = parentLane
    } else {
      lane = allocateLane(row, parentLane + 1)
    }

    displayLaneByNodeID.set(nodeID, lane)
    const releaseRow = lastRowByNodeID.get(nodeID) ?? row
    releaseRowByLane.set(lane, Math.max(releaseRowByLane.get(lane) ?? -1, releaseRow))
  }

  return displayLaneByNodeID
}

export function buildConversationGraphView(input: {
  graph: ConversationGraph
  compact: boolean
  orderMode: ConversationGraphOrderMode
}): ConversationGraphView {
  const nodesByID = new Map(input.graph.nodes.map((node) => [node.id, node] as const))
  const sequenceByNodeID = createSequenceMap(input.graph.nodes, input.graph.edges)
  const sortedNodes = [...input.graph.nodes].sort((a, b) => {
    if (input.orderMode === "sequence") {
      const sequenceDiff = (sequenceByNodeID.get(a.id) ?? 1) - (sequenceByNodeID.get(b.id) ?? 1)
      if (sequenceDiff !== 0) return sequenceDiff
    }

    if (a.time !== b.time) return a.time - b.time
    if (a.lane !== b.lane) return a.lane - b.lane
    return a.id.localeCompare(b.id)
  })
  const sortedNodeIDs = sortedNodes.map((node) => node.id)
  const displayLaneByNodeID = createDisplayLaneMap({
    nodes: sortedNodes,
    sortedNodeIDs,
    edges: input.graph.edges,
    orderMode: input.orderMode,
  })
  const colorIndexBySessionID = createSessionColorIndexMap(input.graph.nodes)
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
      displayLane: displayLaneByNodeID.get(node.id) ?? node.lane,
      colorIndex: colorIndexBySessionID.get(node.sessionID) ?? 0,
      isCurrentPath: currentPathNodeIDs.has(node.id),
      isCurrentTarget: input.graph.current.targetNodeID === node.id,
    }))

  const laneCount = nodes.reduce((max, node) => Math.max(max, node.displayLane), 0) + 1

  return {
    nodes,
    edges: edges.filter((edge) => visibleNodeIDs.has(edge.from) && visibleNodeIDs.has(edge.to)),
    laneCount,
  }
}
