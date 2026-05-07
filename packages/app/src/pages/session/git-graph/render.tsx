import { For, Show, createMemo, createSignal } from "solid-js"
import { Portal } from "solid-js/web"
import { PALETTE, ROW_HEIGHT, LANE_GAP, RAIL_PAD, type GraphEdge, type GraphNode } from "./model"

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

const formatDate = (date: number) => {
  const d = new Date(date * 1000)
  return d.toLocaleDateString() + " " + d.toLocaleTimeString()
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

function TooltipContent(props: {
  node: GraphNode
  currentBranch: string | null
  uncommitted?: { count: number; files: string[] }
}) {
  const c = color(props.node.colorIndex)

  return (
    <div
      class="text-xs text-text-base"
      style={{
        "border-left": `3px solid ${c}`,
        "max-width": "320px",
      }}
    >
      <div class="font-mono text-11-regular text-text-weaker px-3 pt-2 pb-1">
        {props.node.isUncommitted ? "Uncommitted Changes" : `Commit ${abbrev(props.node.hash)}`}
      </div>

      <Show when={props.currentBranch && !props.node.isUncommitted}>
        <div class="px-3 pb-1 text-text-weaker">
          {props.node.heads.includes(props.currentBranch!) ? (
            <span>
              Included in <span class="text-text-base font-medium">HEAD</span>
            </span>
          ) : (
            <span>
              <b>
                <i>Not</i>
              </b>{" "}
              included in <span class="text-text-base font-medium">HEAD</span>
            </span>
          )}
        </div>
      </Show>

      <Show when={props.node.isUncommitted && props.uncommitted}>
        <div class="px-3 pb-1 text-text-weaker">
          {props.uncommitted!.count} file{props.uncommitted!.count !== 1 ? "s" : ""} changed
          <div class="mt-1 max-h-[120px] overflow-y-auto">
            <For each={props.uncommitted!.files.slice(0, 20)}>
              {(file) => <div class="truncate font-mono text-[10px]">{file}</div>}
            </For>
          </div>
          <Show when={(props.uncommitted?.files.length ?? 0) > 20}>
            <div class="text-text-weaker mt-0.5">...and {props.uncommitted!.files.length - 20} more</div>
          </Show>
        </div>
      </Show>

      <Show when={props.node.heads.length > 0}>
        <div class="px-3 pb-1 text-text-weaker">
          Branches:
          <span class="text-text-base">
            {props.node.heads.slice(0, 5).join(", ")}
            {props.node.heads.length > 5 ? ` +${props.node.heads.length - 5} more` : ""}
          </span>
        </div>
      </Show>

      <Show when={props.node.tags.length > 0}>
        <div class="px-3 pb-1 text-text-weaker">
          Tags:
          <span class="text-text-base">
            {props.node.tags
              .slice(0, 5)
              .map((t) => t.name)
              .join(", ")}
            {props.node.tags.length > 5 ? ` +${props.node.tags.length - 5} more` : ""}
          </span>
        </div>
      </Show>

      <Show when={props.node.remotes.length > 0}>
        <div class="px-3 pb-1 text-text-weaker">
          Remotes:
          <span class="text-text-base">
            {props.node.remotes
              .slice(0, 5)
              .map((r) => r.name)
              .join(", ")}
            {props.node.remotes.length > 5 ? ` +${props.node.remotes.length - 5} more` : ""}
          </span>
        </div>
      </Show>

      <Show when={!props.node.isUncommitted}>
        <div class="px-3 pb-1 text-text-weaker">
          {props.node.author} · {formatDate(props.node.date)}
        </div>
        <div class="px-3 pb-2 text-text-base break-words whitespace-pre-wrap">{props.node.message}</div>
      </Show>
    </div>
  )
}

export function GitGraphList(props: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  lanes: number
  currentBranch: string | null | undefined
  uncommitted?: { count: number; files: string[] }
  selectedHash?: string | null
  onCommitClick?: (hash: string) => void
  onContextMenu?: (hash: string, event: MouseEvent) => void
}) {
  const [hovered, setHovered] = createSignal<GraphNode | null>(null)
  const [tooltipX, setTooltipX] = createSignal(0)
  const [tooltipY, setTooltipY] = createSignal(0)

  const railWidth = createMemo(() => props.lanes * LANE_GAP + RAIL_PAD * 2)
  const height = createMemo(() => Math.max(ROW_HEIGHT, props.nodes.length * ROW_HEIGHT))

  const handleCircleEnter = (node: GraphNode, e: MouseEvent) => {
    setHovered(node)
    updatePos(e)
  }

  const updatePos = (e: MouseEvent) => {
    const rect = (e.currentTarget as SVGCircleElement).getBoundingClientRect()
    const gap = 6
    const estimatedWidth = 330
    const margin = 12

    let x = rect.right + gap
    if (x + estimatedWidth > window.innerWidth - margin) {
      x = rect.left - estimatedWidth - gap
    }
    if (x < margin) x = margin

    setTooltipX(x)
    setTooltipY(rect.top + rect.height / 2)
  }

  return (
    <div class="relative h-full min-h-0">
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
                    <circle
                      cx={cx()}
                      cy={cy()}
                      r={r()}
                      fill="transparent"
                      stroke="#808080"
                      stroke-width="1.5"
                      style="pointer-events:auto;cursor:pointer"
                      onMouseEnter={(e) => handleCircleEnter(node, e)}
                      onMouseMove={(e) => updatePos(e)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => props.onCommitClick?.(node.hash)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        props.onContextMenu?.(node.hash, e)
                      }}
                    />
                  </Show>
                  <Show when={!node.isUncommitted && node.isHead}>
                    <circle
                      cx={cx()}
                      cy={cy()}
                      r={r()}
                      fill="transparent"
                      stroke={c()}
                      stroke-width="2"
                      style="pointer-events:auto;cursor:pointer"
                      onMouseEnter={(e) => handleCircleEnter(node, e)}
                      onMouseMove={(e) => updatePos(e)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => props.onCommitClick?.(node.hash)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        props.onContextMenu?.(node.hash, e)
                      }}
                    />
                  </Show>
                  <Show when={!node.isUncommitted && !node.isHead}>
                    <circle
                      cx={cx()}
                      cy={cy()}
                      r={r()}
                      fill={c()}
                      style="pointer-events:auto;cursor:pointer"
                      onMouseEnter={(e) => handleCircleEnter(node, e)}
                      onMouseMove={(e) => updatePos(e)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => props.onCommitClick?.(node.hash)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        props.onContextMenu?.(node.hash, e)
                      }}
                    />
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
                classList={{
                  "bg-surface-base": hovered()?.hash === node.hash,
                  "bg-accent-base/10": props.selectedHash === node.hash,
                }}
                style={{
                  height: `${ROW_HEIGHT}px`,
                  "padding-left": `${railWidth() + 8}px`,
                  "padding-right": "8px",
                  cursor: "pointer",
                }}
                onMouseEnter={() => setHovered(node)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => props.onCommitClick?.(node.hash)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  props.onContextMenu?.(node.hash, e)
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
                  {node.isUncommitted
                    ? `Uncommitted Changes${props.uncommitted ? ` (${props.uncommitted.count})` : ""}`
                    : node.message}
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

      <Portal>
        <Show when={hovered()}>
          {(node) => (
            <div
              class="fixed z-[1000] pointer-events-none"
              style={{
                left: `${tooltipX()}px`,
                top: `${tooltipY()}px`,
                transform: "translateY(-50%)",
              }}
            >
              <div class="rounded shadow-lg border border-border-weaker-base bg-surface-base overflow-hidden">
                <TooltipContent
                  node={node()}
                  currentBranch={props.currentBranch ?? null}
                  uncommitted={props.uncommitted}
                />
              </div>
            </div>
          )}
        </Show>
      </Portal>
    </div>
  )
}
