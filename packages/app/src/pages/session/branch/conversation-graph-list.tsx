import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { For, Show, createMemo } from "solid-js"
import type { ConversationGraphEdge, ConversationGraphNode } from "./conversation-graph-model"

const LANE_COLORS = ["#3b82f6", "#10b981", "#f97316", "#d946ef", "#14b8a6", "#f43f5e", "#eab308"]

const colorForLane = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]

function formatNodeTitle(input: { label: string; providerID?: string; modelID?: string; mode?: string; time: number }) {
  const details = [input.mode, input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : undefined]
    .filter(Boolean)
    .join(" · ")
  const time = new Date(input.time).toLocaleString()
  return [input.label, details, time].filter(Boolean).join("\n")
}

export function ConversationGraphList(props: {
  nodes: ConversationGraphNode[]
  edges: ConversationGraphEdge[]
  laneCount: number
  onSelect: (node: ConversationGraphNode) => void
  onFork: (node: ConversationGraphNode) => void
  onRename: (node: ConversationGraphNode) => void
}) {
  const language = useLanguage()
  const rowHeight = 44
  const laneGap = 18
  const railPadding = 18
  const railWidth = createMemo(() => railPadding * 2 + Math.max(0, props.laneCount - 1) * laneGap + 16)
  const height = createMemo(() => Math.max(rowHeight, props.nodes.length * rowHeight))

  const nodeByID = createMemo(() => new Map(props.nodes.map((node) => [node.id, node] as const)))
  const xForLane = (lane: number) => railPadding + lane * laneGap
  const yForRow = (row: number) => row * rowHeight + rowHeight / 2

  const edgePath = (edge: ConversationGraphEdge) => {
    const from = nodeByID().get(edge.from)
    const to = nodeByID().get(edge.to)
    if (!from || !to) return ""

    const x1 = xForLane(from.lane)
    const y1 = yForRow(from.displayRow)
    const x2 = xForLane(to.lane)
    const y2 = yForRow(to.displayRow)

    if (from.lane === to.lane) {
      return `M ${x1} ${y1} L ${x2} ${y2}`
    }

    const deltaY = Math.max(12, (y2 - y1) / 3)
    return `M ${x1} ${y1} C ${x1} ${y1 + deltaY}, ${x2} ${y2 - deltaY}, ${x2} ${y2}`
  }

  return (
    <div class="relative h-full min-h-0 overflow-auto">
      <div class="relative min-w-0" style={{ height: `${height()}px` }}>
        <svg
          class="pointer-events-none absolute left-0 top-0"
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
                stroke={edge.isCurrentPath ? colorForLane(nodeByID().get(edge.to)?.lane ?? 0) : "#4b5563"}
                stroke-width={edge.isCurrentPath ? "2.5" : "2"}
                stroke-dasharray={edge.style === "dashed" ? "4 4" : undefined}
                opacity={edge.isCurrentPath ? "1" : "0.9"}
                stroke-linecap="round"
              />
            )}
          </For>

          <For each={props.nodes}>
            {(node) => {
              const x = createMemo(() => xForLane(node.lane))
              const y = createMemo(() => yForRow(node.displayRow))
              const color = createMemo(() => colorForLane(node.lane))
              const radius = createMemo(() => (node.isCurrentTarget ? 5.5 : 4.5))

              return (
                <>
                  <circle
                    cx={x()}
                    cy={y()}
                    r={radius()}
                    fill={node.kind === "bud" ? "transparent" : color()}
                    stroke={color()}
                    stroke-width={node.isCurrentPath ? "2.5" : "2"}
                  />
                  <Show when={node.isCurrentTarget && node.kind === "turn"}>
                    <circle cx={x()} cy={y()} r="8" fill="transparent" stroke={color()} stroke-width="1.5" opacity="0.6" />
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
                role="button"
                tabIndex={0}
                data-graph-node-id={node.id}
                class="group/graph-row flex cursor-pointer items-center border-b border-border-weaker-base outline-none transition-colors"
                classList={{
                  "bg-surface-base": node.isCurrentTarget,
                  "hover:bg-background-stronger": !node.isCurrentTarget,
                }}
                style={{
                  height: `${rowHeight}px`,
                  "padding-left": `${railWidth() + 12}px`,
                  "padding-right": "8px",
                }}
                title={formatNodeTitle(node)}
                onClick={() => props.onSelect(node)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  props.onSelect(node)
                }}
              >
                <div class="min-w-0 flex-1">
                  <div
                    class="truncate text-12-medium"
                    classList={{
                      "text-text-strong": node.isCurrentTarget || node.isCurrentPath,
                      "text-text-base": !node.isCurrentTarget && !node.isCurrentPath,
                      italic: node.kind === "bud",
                    }}
                  >
                    {node.kind === "bud" ? "…" : node.label}
                  </div>
                </div>

                <div class="shrink-0 opacity-0 transition-opacity group-hover/graph-row:opacity-100 group-focus-within/graph-row:opacity-100">
                  <DropdownMenu placement="bottom-end">
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="size-6 rounded-md"
                      aria-label={language.t("common.moreOptions")}
                      onClick={(event: MouseEvent) => event.stopPropagation()}
                      onPointerDown={(event: PointerEvent) => event.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content onClick={(event: MouseEvent) => event.stopPropagation()}>
                        <DropdownMenu.Item onSelect={() => props.onSelect(node)}>
                          <DropdownMenu.ItemLabel>{language.t("notification.action.goToSession")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item disabled={!node.userMessageID} onSelect={() => props.onFork(node)}>
                          <DropdownMenu.ItemLabel>{language.t("command.session.fork")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => props.onRename(node)}>
                          <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
