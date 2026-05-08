import { LANE_GAP, PALETTE, RAIL_PAD, ROW_HEIGHT, type GraphLine } from "./model"

export const HEADER_HEIGHT = 30
export const UNCOMMITTED_COLOR = "#808080"
export const GRAPH_SHADOW = "var(--background-base)"
export const GRAPH_LINE_WIDTH = 2
export const GRAPH_SHADOW_WIDTH = 4
export const GRAPH_DOT_RADIUS = 4
export const GRAPH_HEAD_RADIUS = 5
export const TOOLTIP_WIDTH = 340

const DELTA = ROW_HEIGHT * 0.8

export const color = (idx: number) => PALETTE[idx % PALETTE.length]

export const railWidth = (lanes: number) => lanes * LANE_GAP + RAIL_PAD * 2

export const xForLane = (lane: number) => RAIL_PAD + lane * LANE_GAP

export const yForRow = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2

export const abbrev = (hash: string) => hash.slice(0, 7)

export const ago = (date: number) => {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - date
  if (diff < 60) return "now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`
  return `${Math.floor(diff / 604800)}w`
}

export const formatDate = (date: number) => {
  const d = new Date(date * 1000)
  return d.toLocaleDateString() + " " + d.toLocaleTimeString()
}

export const linePath = (line: GraphLine) => {
  const x1 = xForLane(line.fromLane)
  const y1 = yForRow(line.fromRow)
  const x2 = xForLane(line.toLane)
  const y2 = yForRow(line.toRow)

  if (line.fromLane === line.toLane) return `M ${x1} ${y1} L ${x2} ${y2}`

  const d = Math.min(DELTA, Math.abs(y2 - y1) * 0.5)
  return `M ${x1} ${y1} C ${x1} ${y1 + d}, ${x2} ${y2 - d}, ${x2} ${y2}`
}
