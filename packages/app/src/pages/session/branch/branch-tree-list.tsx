import { For, createMemo } from "solid-js"
import { BranchTreeRow } from "./branch-tree-row"
import type { BranchTreeRow as BranchTreeRowModel } from "./branch-tree-model"

const ROW_HEIGHT = 48
const LANE_GAP = 14
const LANE_START = 18
const LANE_END_PADDING = 14
const COLORS = ["#22c55e", "#06b6d4", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6", "#3b82f6", "#f97316"]

function branchColor(index: number) {
  return COLORS[index % COLORS.length] ?? COLORS[0]
}

function curvePath(props: {
  startX: number
  startY: number
  endX: number
  endY: number
}) {
  if (props.startX === props.endX) return `M ${props.startX} ${props.startY} L ${props.endX} ${props.endY}`

  const middleY = props.endY - ROW_HEIGHT / 2
  const radius = Math.min(8, Math.abs(props.endX - props.startX) / 2, Math.abs(middleY - props.startY) / 2)
  const horizontalDirection = props.endX > props.startX ? 1 : -1

  return [
    `M ${props.startX} ${props.startY}`,
    `L ${props.startX} ${middleY - radius}`,
    `Q ${props.startX} ${middleY} ${props.startX + radius * horizontalDirection} ${middleY}`,
    `L ${props.endX - radius * horizontalDirection} ${middleY}`,
    `Q ${props.endX} ${middleY} ${props.endX} ${middleY + radius}`,
    `L ${props.endX} ${props.endY}`,
  ].join(" ")
}

export function BranchTreeList(props: {
  rows: BranchTreeRowModel[]
  onSelect: (row: BranchTreeRowModel) => void
  onFork: (row: BranchTreeRowModel) => void
  onRename: (row: BranchTreeRowModel) => void
}) {
  const railWidth = createMemo(() => {
    const maxLane = props.rows.reduce((lane, row) => Math.max(lane, row.lane), 0)
    return LANE_START + maxLane * LANE_GAP + LANE_END_PADDING
  })

  const rowByIndex = createMemo(() => {
    const map = new Map<number, BranchTreeRowModel>()
    for (const row of props.rows) map.set(row.rowIndex, row)
    return map
  })

  const svgHeight = createMemo(() => Math.max(props.rows.length * ROW_HEIGHT, ROW_HEIGHT))

  return (
    <div class="relative h-full min-h-0 overflow-auto no-scrollbar">
      <svg
        class="pointer-events-none absolute left-0 top-0 z-0"
        width={railWidth()}
        height={svgHeight()}
        viewBox={`0 0 ${railWidth()} ${svgHeight()}`}
        fill="none"
        aria-hidden
      >
        <For each={props.rows}>
          {(row) => {
            const parent = row.parentRowIndex === undefined ? undefined : rowByIndex().get(row.parentRowIndex)
            if (!parent) return null

            const startX = LANE_START + parent.lane * LANE_GAP
            const startY = parent.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
            const endX = LANE_START + row.lane * LANE_GAP
            const endY = row.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2

            return (
              <path
                d={curvePath({ startX, startY, endX, endY })}
                stroke={branchColor(row.colorIndex)}
                stroke-width="2.25"
                stroke-linecap="round"
                stroke-linejoin="round"
                opacity="0.96"
              />
            )
          }}
        </For>

        <For each={props.rows}>
          {(row) => {
            const x = LANE_START + row.lane * LANE_GAP
            const y = row.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
            const color = row.parentRowIndex === undefined ? "#94a3b8" : branchColor(row.colorIndex)
            return (
              <circle
                cx={x}
                cy={y}
                r={row.isCurrent ? "4.75" : "3.5"}
                fill="var(--background-base)"
                stroke={color}
                stroke-width={row.isCurrent ? "2.75" : "2"}
              />
            )
          }}
        </For>
      </svg>

      <div class="relative z-10">
        <For each={props.rows}>
          {(row) => (
            <BranchTreeRow
              row={row}
              railWidth={railWidth()}
              onSelect={() => props.onSelect(row)}
              onFork={() => props.onFork(row)}
              onRename={() => props.onRename(row)}
            />
          )}
        </For>
      </div>
    </div>
  )
}
