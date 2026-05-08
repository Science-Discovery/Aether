import { For, Show } from "solid-js"
import type { GraphLine, GraphNode } from "./model"
import {
  GRAPH_DOT_RADIUS,
  GRAPH_HEAD_RADIUS,
  GRAPH_LINE_WIDTH,
  GRAPH_SHADOW,
  GRAPH_SHADOW_WIDTH,
  UNCOMMITTED_COLOR,
  color,
  linePath,
  xForLane,
  yForRow,
} from "./style"

export function GitGraphSvg(props: {
  nodes: GraphNode[]
  lines: GraphLine[]
  visibleWidth: number
  height: number
  onNodeEnter: (node: GraphNode, event: MouseEvent) => void
  onNodeMove: (event: MouseEvent) => void
  onNodeLeave: () => void
  onNodeClick?: (hash: string) => void
  onNodeContextMenu?: (hash: string, event: MouseEvent) => void
}) {
  return (
    <svg
      class="pointer-events-none absolute left-0 top-0 z-20"
      width={props.visibleWidth}
      height={props.height}
      viewBox={`0 0 ${props.visibleWidth} ${props.height}`}
      preserveAspectRatio="none"
      style="overflow:hidden"
    >
      <For each={props.lines}>
        {(line) => (
          <path
            d={linePath(line)}
            fill="none"
            stroke={GRAPH_SHADOW}
            stroke-width={GRAPH_SHADOW_WIDTH}
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.9"
          />
        )}
      </For>

      <For each={props.lines}>
        {(line) => (
          <path
            d={linePath(line)}
            fill="none"
            stroke={line.committed ? color(line.colorIndex) : UNCOMMITTED_COLOR}
            stroke-width={GRAPH_LINE_WIDTH}
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        )}
      </For>

      <For each={props.nodes}>
        {(node) => {
          const cx = () => xForLane(node.lane)
          const cy = () => yForRow(node.row)
          const c = () => color(node.colorIndex)
          const fill = () => (node.isHead || node.isUncommitted ? "var(--background-base)" : c())
          const stroke = () => (node.isUncommitted ? UNCOMMITTED_COLOR : node.isHead ? c() : "var(--background-base)")

          return (
            <>
              <circle
                cx={cx()}
                cy={cy()}
                r={node.isHead ? GRAPH_HEAD_RADIUS : GRAPH_DOT_RADIUS}
                fill={fill()}
                stroke={stroke()}
                stroke-width={node.isHead ? 2 : 1}
                style="pointer-events:auto;cursor:pointer"
                onMouseEnter={(event) => props.onNodeEnter(node, event)}
                onMouseMove={props.onNodeMove}
                onMouseLeave={props.onNodeLeave}
                onClick={() => props.onNodeClick?.(node.hash)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  props.onNodeContextMenu?.(node.hash, event)
                }}
              />
              <Show when={node.isUncommitted}>
                <circle
                  cx={cx()}
                  cy={cy()}
                  r="2"
                  fill="transparent"
                  stroke={UNCOMMITTED_COLOR}
                  stroke-width="1"
                  pointer-events="none"
                />
              </Show>
            </>
          )
        }}
      </For>
    </svg>
  )
}
