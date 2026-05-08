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
}

export function computeGraphLayout(commits: CommitLogItem[] | undefined | null, head: string | null): GraphView {
  if (!commits || commits.length === 0) return { nodes: [], lines: [], lanes: 0 }
  return layout(commits, head)
}
