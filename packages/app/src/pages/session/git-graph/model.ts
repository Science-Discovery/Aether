import type { CommitLogItem } from "@opencode-ai/sdk/v2"
import { layout } from "./layout"

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

export type GraphLine = {
  branch: number
  colorIndex: number
  fromRow: number
  toRow: number
  fromLane: number
  toLane: number
  committed: boolean
  lockedFirst: boolean
}

export type GraphView = {
  nodes: GraphNode[]
  lines: GraphLine[]
  lanes: number
  graphWidth: number
  widthsAtRows: number[]
}

export function computeGraphLayout(commits: CommitLogItem[] | undefined | null, head: string | null): GraphView {
  if (!commits || commits.length === 0) return { nodes: [], lines: [], lanes: 0, graphWidth: 0, widthsAtRows: [] }
  return layout(commits, head)
}

export function canDropCommit(commits: CommitLogItem[], hash: string, head: string | null | undefined) {
  if (!head) return false
  const map = new Map(commits.map((c) => [c.hash, c]))
  const item = map.get(hash)
  if (!item || item.parents.length === 0 || item.parents.length > 1) return false

  const child = new Map<string, string[]>()
  commits.forEach((c) => c.parents.forEach((p) => child.set(p, [...(child.get(p) ?? []), c.hash])))

  const walk = (h: string): boolean | null => {
    const c = map.get(h)
    if (!c || c.parents.length > 1) return null
    const list = child.get(h) ?? []
    if (list.length > 1) return null
    if (list.length === 1) {
      const next = walk(list[0]!)
      if (next !== false) return next
    }
    return h === head
  }

  return walk(hash) || false
}

export function expandedY(row: number, expandedRow: number | null | undefined, height: number) {
  const base = row * ROW_HEIGHT + ROW_HEIGHT / 2
  if (expandedRow === null || expandedRow === undefined || row <= expandedRow) return base
  return base + height
}
