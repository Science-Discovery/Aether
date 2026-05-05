import type { CommitLogItem } from "@opencode-ai/sdk/v2"

export const PALETTE = [
  "#0085d9",
  "#d9008f",
  "#00d90a",
  "#d98500",
  "#a300d9",
  "#ff0000",
  "#00d9cc",
  "#e138e8",
  "#85d900",
  "#dc5b23",
  "#6f24d6",
  "#ffcc00",
]

export const ROW_HEIGHT = 28
export const LANE_GAP = 16
export const RAIL_PAD = 12

export const UNCOMMITTED = "UNCOMMITTED"

export type GraphNode = {
  hash: string
  row: number
  lane: number
  colorIndex: number
  isHead: boolean
  isUncommitted: boolean
  message: string
  author: string
  date: number
  heads: string[]
  tags: { name: string; annotated: boolean }[]
  remotes: { name: string; remote: string | null }[]
}

export type GraphEdge = {
  fromRow: number
  toRow: number
  fromLane: number
  toLane: number
  isMerge: boolean
}

export type GraphView = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  lanes: number
}

const available = (bag: { end: number }[], start: number) => {
  for (let i = 0; i < bag.length; i++) {
    if (start > bag[i].end) return i
  }
  bag.push({ end: 0 })
  return bag.length - 1
}

const idx = (commits: CommitLogItem[]) => {
  const map = new Map<string, number>()
  for (let i = 0; i < commits.length; i++) map.set(commits[i].hash, i)
  return map
}

export function computeGraphLayout(commits: CommitLogItem[], head: string | null): GraphView {
  const n = commits.length
  if (n === 0) return { nodes: [], edges: [], lanes: 0 }

  const lookup = idx(commits)
  const slot = commits.map(() => ({ lane: -1, nextX: 0, parent: 0 }))
  const bag: { end: number }[] = []

  for (let i = 0; i < n; i++) {
    while (slot[i].parent < commits[i].parents.length) {
      const parentHash = commits[i].parents[slot[i].parent]
      const parentRow = lookup.get(parentHash)

      if (parentRow === undefined) {
        slot[i].parent++
        continue
      }

      const here = slot[i]
      const there = slot[parentRow]
      const isMerge = slot[i].parent > 0

      if (here.lane !== -1 && there.lane !== -1 && isMerge) {
        for (let j = i + 1; j < n; j++) {
          if (j === parentRow) {
            slot[i].parent++
            break
          }
          slot[j].nextX++
        }
        continue
      }

      const laneIdx = available(bag, i)
      let cur = i
      let target = parentRow

      if (here.lane === -1) {
        here.lane = laneIdx
        here.nextX++
      }

      for (let j = i + 1; j < n; j++) {
        const s = slot[j]

        if (j === target) {
          const wasLaned = s.lane !== -1
          if (s.lane === -1) s.lane = laneIdx
          bag[laneIdx] = { end: j }
          s.nextX++

          slot[cur].parent++

          if (wasLaned) {
            slot[i].parent++
            break
          }

          cur = target
          if (slot[cur].parent >= commits[cur].parents.length) break

          const next = commits[cur].parents[slot[cur].parent]
          const nxt = lookup.get(next)
          if (nxt === undefined) {
            slot[i].parent++
            break
          }
          target = nxt
        } else {
          s.nextX++
        }
      }

      bag[laneIdx] = { end: Math.max(bag[laneIdx].end, i) }
    }
  }

  const lanes = bag.length || 1
  const color = (l: number) => l % PALETTE.length

  const nodes: GraphNode[] = commits.map((c, i) => {
    const lane = slot[i].lane >= 0 ? slot[i].lane : 0
    return {
      hash: c.hash,
      row: i,
      lane,
      colorIndex: color(lane),
      isHead: c.hash === head,
      isUncommitted: c.hash === UNCOMMITTED,
      message: c.message,
      author: c.author,
      date: c.date,
      heads: c.heads,
      tags: c.tags,
      remotes: c.remotes,
    }
  })

  const edges: GraphEdge[] = []
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < commits[i].parents.length; p++) {
      const parentRow = lookup.get(commits[i].parents[p])
      if (parentRow === undefined) continue
      edges.push({
        fromRow: i,
        toRow: parentRow,
        fromLane: slot[i].lane >= 0 ? slot[i].lane : 0,
        toLane: slot[parentRow].lane >= 0 ? slot[parentRow].lane : 0,
        isMerge: p > 0,
      })
    }
  }

  return { nodes, edges, lanes }
}
