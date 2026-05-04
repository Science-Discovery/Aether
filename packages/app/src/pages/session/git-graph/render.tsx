import { For, Show, createMemo } from "solid-js"
import { PALETTE, type GraphEdge, type GraphNode } from "./model"

const ROW_HEIGHT = 28
const LANE_GAP = 16
const RAIL_PAD = 12
const DELTA = ROW_HEIGHT * 0.8

const color = (idx: number) => PALETTE[idx % PALETTE.length]

const xForLane = (lane: number) => RAIL_PAD + lane * LANE_GAP
const yForRow = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2

const abbrev = (hash: string) => hash.slice(0, 7)

const ago = (date: number) => {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - date
  if (diff < 60) return "now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`
  return `${Math.floor(diff / 604800)}w`
}

const edgePath = (edge: GraphEdge) => {
  const x1 = xForLane(edge.fromLane)
  const y1 = yForRow(edge.fromRow)
  const x2 = xForLane(edge.toLane)
  const y2 = yForRow(edge.toRow)

  if (edge.fromLane === edge.toLane) {
    return `M ${x1} ${y1} L ${x2} ${y2}`
  }

  const d = Math.min(DELTA, Math.abs(y2 - y1) * 0.5)
  return `M ${x1} ${y1} C ${x1} ${y1 + d}, ${x2} ${y2 - d}, ${x2} ${y2}`
}

export function GitGraphList(props: { nodes: GraphNode[]; edges: GraphEdge[]; lanes: number }) {
  const railWidth = createMemo(() => props.lanes * LANE_GAP + RAIL_PAD * 2)
  const height = createMemo(() => Math.max(ROW_HEIGHT, props.nodes.length * ROW_HEIGHT))

  return (
    <div class="relative h-full min-h-0 overflow-auto">
      <div class="relative min-w-0" style={{ height: `${height()}px` }}>
        <svg
          class="pointer-events-none absolute left-0 top-0 z-20"
          width={railWidth()}
          height={height()}
          viewBox={`0 0 ${railWidth()} ${height()}`}
          preserveAspectRatio="none"
        >
          <For each={props.edges}>
            {(edge) => (
              <path
                d={edgePath(edge)}
                fill="none"
                stroke={color(edge.fromLane)}
                stroke-width="1.5"
                stroke-linecap="round"
                opacity="0.6"
              />
            )}
          </For>

          <For each={props.nodes}>
            {(node) => {
              const cx = createMemo(() => xForLane(node.lane))
              const cy = createMemo(() => yForRow(node.row))
              const c = createMemo(() => color(node.colorIndex))
              const r = createMemo(() => (node.isHead ? 5 : 4))

              return (
                <>
                  <Show when={node.isUncommitted}>
                    <circle cx={cx()} cy={cy()} r={r()} fill="transparent" stroke="#808080" stroke-width="1.5" />
                  </Show>
                  <Show when={!node.isUncommitted && node.isHead}>
                    <circle cx={cx()} cy={cy()} r={r()} fill="transparent" stroke={c()} stroke-width="2" />
                  </Show>
                  <Show when={!node.isUncommitted && !node.isHead}>
                    <circle cx={cx()} cy={cy()} r={r()} fill={c()} />
                  </Show>
                </>
              )
            }}
          </For>
        </svg>

        <div class="relative z-10">
          <For each={props.nodes}>
            {(node) => (
              <div
                class="flex items-center gap-2 border-b border-border-weaker-base text-sm"
                style={{
                  height: `${ROW_HEIGHT}px`,
                  "padding-left": `${railWidth() + 8}px`,
                  "padding-right": "8px",
                }}
              >
                <Show when={node.heads.length > 0 || node.isHead}>
                  <span class="shrink-0 flex items-center gap-1">
                    <For each={node.heads}>
                      {(h) => (
                        <span class="inline-flex items-center rounded bg-accent-base/10 px-1 text-[11px] text-accent-base">
                          {h === "HEAD" ? "HEAD" : h}
                        </span>
                      )}
                    </For>
                  </span>
                </Show>

                <span class="min-w-0 flex-1 truncate text-text-base">
                  {node.isUncommitted ? "Uncommitted Changes" : node.message}
                </span>

                <Show when={!node.isUncommitted}>
                  <span class="shrink-0 font-mono text-[11px] text-text-weaker">{abbrev(node.hash)}</span>
                </Show>

                <span class="shrink-0 text-[11px] text-text-weaker">{node.author}</span>

                <span class="shrink-0 w-10 text-right text-[11px] text-text-weaker">{ago(node.date)}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
