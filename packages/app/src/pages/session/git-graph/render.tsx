import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import type { Column, Columns } from "./columns"
import { autoColumns, fitColumns, resizeColumns, template } from "./columns"
import { ROW_HEIGHT, type GraphLine, type GraphNode } from "./model"
import { CommitDetail } from "./detail"
import { GitGraphSvg } from "./graph-svg"
import { GitGraphRow } from "./row"
import { GitGraphTooltip } from "./tooltip"
import { HEADER_HEIGHT, TOOLTIP_WIDTH, color, railWidth } from "./style"
import type { Ref } from "./refs"

const DETAIL_HEIGHT = 280
const DETAIL_MIN = 160
const DETAIL_MAX = 640

export function GitGraphList(props: {
  nodes: GraphNode[]
  lines: GraphLine[]
  lanes: number
  graphWidth?: number
  currentBranch: string | null | undefined
  uncommitted?: { count: number; files: string[] }
  selectedHash?: string | null
  selectedParentHash?: string | null
  onCommitClick?: (hash: string) => void
  onCloseDetail?: () => void
  onContextMenu?: (hash: string, event: MouseEvent) => void
  onRefContextMenu?: (hash: string, ref: Ref, event: MouseEvent) => void
}) {
  const [hover, setHover] = createStore<{ row: GraphNode | null; tip: GraphNode | null }>({ row: null, tip: null })
  const [panel, setPanel] = createStore({ height: DETAIL_HEIGHT })
  const [tooltipX, setTooltipX] = createSignal(0)
  const [tooltipY, setTooltipY] = createSignal(0)
  const [tooltipSide, setTooltipSide] = createSignal<"left" | "right">("right")
  const [width, setWidth] = createSignal(0)
  const [fixed, setFixed] = createSignal<Columns | null>(null)

  let observer: ResizeObserver | undefined

  const graphWidth = createMemo(() => props.graphWidth ?? railWidth(props.lanes))
  const cols = createMemo(() => (fixed() ? fitColumns(fixed()!, width()) : autoColumns(width(), graphWidth())))
  const expandedRow = createMemo(() =>
    props.selectedHash ? props.nodes.findIndex((node) => node.hash === props.selectedHash) : -1,
  )
  const expandedHeight = createMemo(() => (expandedRow() >= 0 ? panel.height : 0))
  const bodyHeight = createMemo(() => Math.max(ROW_HEIGHT, props.nodes.length * ROW_HEIGHT + expandedHeight()))
  const height = createMemo(() => HEADER_HEIGHT + bodyHeight())

  const bind = (el: HTMLDivElement) => {
    const sync = () => setWidth(el.clientWidth)
    sync()
    observer = new ResizeObserver(sync)
    observer.observe(el)
  }

  onCleanup(() => observer?.disconnect())

  const handleCircleEnter = (node: GraphNode, e: MouseEvent) => {
    setHover({ row: node, tip: node })
    updatePos(e)
  }

  const handleCircleLeave = () => {
    setHover({ row: null, tip: null })
  }

  const handleRowEnter = (node: GraphNode) => {
    setHover("row", node)
  }

  const handleRowLeave = () => {
    setHover({ row: null, tip: null })
  }

  const detailMax = () => Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, window.innerHeight - 160))
  const clamp = (value: number) => Math.max(DETAIL_MIN, Math.min(detailMax(), value))

  const startDetailResize = (event: MouseEvent) => {
    event.preventDefault()
    const base = panel.height
    const start = event.clientY

    const move = (e: MouseEvent) => {
      setPanel("height", clamp(base + e.clientY - start))
    }
    const up = () => {
      document.removeEventListener("mousemove", move)
      document.removeEventListener("mouseup", up)
    }

    document.addEventListener("mousemove", move)
    document.addEventListener("mouseup", up)
  }

  const startResize = (left: Column, right: Column, event: MouseEvent) => {
    event.preventDefault()
    const base = cols()
    const start = event.clientX
    setFixed(base)

    const move = (e: MouseEvent) => {
      setFixed(resizeColumns(base, left, right, e.clientX - start, width()))
    }
    const up = () => {
      document.removeEventListener("mousemove", move)
      document.removeEventListener("mouseup", up)
    }

    document.addEventListener("mousemove", move)
    document.addEventListener("mouseup", up)
  }

  const updatePos = (e: MouseEvent, offset = 0) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect()
    const gap = 6
    const margin = 12

    const anchor = offset > 0 ? rect.left + offset : rect.right
    const left = anchor - TOOLTIP_WIDTH - gap
    const right = anchor + gap
    const side = right + TOOLTIP_WIDTH > window.innerWidth - margin && left > margin ? "left" : "right"
    const x = side === "right" ? Math.min(right, window.innerWidth - TOOLTIP_WIDTH - margin) : Math.max(left, margin)

    setTooltipSide(side)
    setTooltipX(x)
    setTooltipY(rect.top + rect.height / 2)
  }

  const header = () => (
    <div
      class="sticky top-0 z-30 grid overflow-hidden border-b border-border-weaker-base bg-background-base/95 text-[11px] font-medium text-text-weaker backdrop-blur"
      style={{
        height: `${HEADER_HEIGHT}px`,
        "grid-template-columns": template(cols()),
      }}
    >
      <Head label="Graph" onResize={(event) => startResize("graph", "description", event)} />
      <Head label="Description" onResize={(event) => startResize("description", "author", event)} />
      <Head label="Author" onResize={(event) => startResize("author", "date", event)} />
      <Head label="Date" align="right" onResize={(event) => startResize("date", "commit", event)} />
      <Head label="Commit" />
    </div>
  )

  return (
    <div ref={bind} class="relative h-full min-h-0 w-full overflow-x-hidden">
      <div class="relative min-w-0 overflow-x-hidden" style={{ height: `${height()}px` }}>
        {header()}

        <div class="relative overflow-x-hidden" style={{ height: `${bodyHeight()}px` }}>
          <GitGraphSvg
            nodes={props.nodes}
            lines={props.lines}
            visibleWidth={cols().graph}
            height={bodyHeight()}
            expandedRow={expandedRow()}
            expandedHeight={expandedHeight()}
            onNodeEnter={handleCircleEnter}
            onNodeMove={updatePos}
            onNodeLeave={handleCircleLeave}
            onNodeClick={props.onCommitClick}
            onNodeContextMenu={props.onContextMenu}
          />

          <div class="relative z-10">
            <For each={props.nodes}>
              {(node) => (
                <>
                  <GitGraphRow
                    node={node}
                    columns={cols()}
                    currentBranch={props.currentBranch}
                    uncommitted={props.uncommitted}
                    hovered={hover.row?.hash === node.hash}
                    selected={props.selectedHash === node.hash}
                    onEnter={handleRowEnter}
                    onLeave={handleRowLeave}
                    onClick={props.onCommitClick}
                    onContextMenu={props.onContextMenu}
                    onRefContextMenu={props.onRefContextMenu}
                  />
                  <Show when={props.selectedHash === node.hash}>
                    <div class="grid overflow-hidden" style={{ "grid-template-columns": template(cols()) }}>
                      <div class="min-w-0 border-b border-border-weaker-base bg-surface-base" />
                      <CommitDetail
                        hash={node.hash}
                        parentHash={props.selectedParentHash ?? null}
                        height={panel.height}
                        class="col-span-4 min-w-0 border-b border-border-weaker-base"
                        onClose={() => props.onCloseDetail?.()}
                        onResizeStart={startDetailResize}
                      />
                    </div>
                  </Show>
                </>
              )}
            </For>
          </div>
        </div>
      </div>

      <Portal>
        <Show when={hover.tip}>
          {(node) => (
            <div
              class="fixed z-[1000] pointer-events-none"
              style={{
                left: `${tooltipX()}px`,
                top: `${tooltipY()}px`,
                transform: "translateY(-50%)",
              }}
            >
              <GitGraphTooltip
                node={node()}
                color={color(node().colorIndex)}
                side={tooltipSide()}
                currentBranch={props.currentBranch ?? null}
                uncommitted={props.uncommitted}
              />
            </div>
          )}
        </Show>
      </Portal>
    </div>
  )
}

function Head(props: { label: string; align?: "left" | "right"; onResize?: (event: MouseEvent) => void }) {
  return (
    <div class="relative min-w-0 overflow-hidden px-1" classList={{ "text-right": props.align === "right" }}>
      <span class="truncate">{props.label}</span>
      <Show when={props.onResize}>
        <span
          class="absolute right-0 top-0 h-full w-1 cursor-col-resize"
          onMouseDown={(event) => props.onResize?.(event)}
        />
      </Show>
    </div>
  )
}
