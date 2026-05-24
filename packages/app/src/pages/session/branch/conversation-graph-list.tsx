import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { For, Show, createMemo } from "solid-js"
import type { ConversationGraphEdge, ConversationGraphNode } from "./conversation-graph-model"

const LANE_COLORS = ["#3b82f6", "#10b981", "#f97316", "#d946ef", "#14b8a6", "#f43f5e", "#eab308"]

const colorForIndex = (index: number) => LANE_COLORS[index % LANE_COLORS.length]

function formatNodeTitle(input: { label: string; providerID?: string; modelID?: string; mode?: string; time: number }) {
  const details = [input.mode, input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : undefined]
    .filter(Boolean)
    .join(" · ")
  const time = new Date(input.time).toLocaleString()
  return [input.label, details, time].filter(Boolean).join("\n")
}

export function ConversationGraphList(props: {
  currentSessionID: string
  nodes: ConversationGraphNode[]
  edges: ConversationGraphEdge[]
  laneCount: number
  rowHeight: number
  labelClass: string
  labelStyle?: Record<string, string>
  onSelect: (node: ConversationGraphNode) => void
  onFork: (node: ConversationGraphNode) => void
  onRename: (node: ConversationGraphNode) => void
  showRowActions?: boolean
}) {
  const language = useLanguage()
  const laneGap = 18
  const railPadding = 12
  const railWidth = createMemo(() => railPadding * 2 + Math.max(0, props.laneCount - 1) * laneGap + 16)
  const height = createMemo(() => Math.max(props.rowHeight, props.nodes.length * props.rowHeight))

  const nodeByID = createMemo(() => new Map(props.nodes.map((node) => [node.id, node] as const)))
  const xForLane = (lane: number) => railPadding + lane * laneGap
  const yForRow = (row: number) => row * props.rowHeight + props.rowHeight / 2

  const edgePath = (edge: ConversationGraphEdge) => {
    const from = nodeByID().get(edge.from)
    const to = nodeByID().get(edge.to)
    if (!from || !to) return ""

    const x1 = xForLane(from.displayLane)
    const y1 = yForRow(from.displayRow)
    const x2 = xForLane(to.displayLane)
    const y2 = yForRow(to.displayRow)

    if (from.displayLane === to.displayLane) {
      return `M ${x1} ${y1} L ${x2} ${y2}`
    }

    const deltaY = Math.max(12, (y2 - y1) / 3)
    return `M ${x1} ${y1} C ${x1} ${y1 + deltaY}, ${x2} ${y2 - deltaY}, ${x2} ${y2}`
  }

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
                data-graph-edge-id={edge.id}
                d={edgePath(edge)}
                fill="none"
                stroke={edge.isCurrentPath ? colorForIndex(nodeByID().get(edge.to)?.colorIndex ?? 0) : "#6b7280"}
                stroke-width={edge.isCurrentPath ? "3" : "1.25"}
                stroke-dasharray={edge.style === "dashed" ? "4 4" : undefined}
                opacity={edge.isCurrentPath ? "1" : "0.4"}
                stroke-linecap="round"
              />
            )}
          </For>

          <For each={props.nodes}>
            {(node) => {
              const x = createMemo(() => xForLane(node.displayLane))
              const y = createMemo(() => yForRow(node.displayRow))
              const color = createMemo(() => colorForIndex(node.colorIndex))
              const radius = createMemo(() => (node.isCurrentTarget ? 5.5 : 4.5))

              return (
                <>
                  <circle
                    data-graph-node-circle={node.id}
                    cx={x()}
                    cy={y()}
                    r={radius()}
                    fill={node.kind === "bud" ? "transparent" : color()}
                    stroke={color()}
                    stroke-width={node.isCurrentPath ? "2.5" : "2"}
                    opacity={node.isCurrentPath ? "1" : "0.5"}
                  />
                  <Show when={node.isCurrentTarget && node.kind === "turn"}>
                    <circle
                      data-graph-node-target-ring={node.id}
                      cx={x()}
                      cy={y()}
                      r="8"
                      fill="transparent"
                      stroke={color()}
                      stroke-width="1.5"
                      opacity="0.6"
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
                role="button"
                tabIndex={0}
                data-graph-node-id={node.id}
                class="group/graph-row flex cursor-pointer items-center border-b border-border-weaker-base outline-none transition-colors"
                classList={{
                  "bg-surface-base": node.isCurrentTarget,
                  "hover:bg-background-stronger": !node.isCurrentTarget,
                }}
                style={{
                  height: `${props.rowHeight}px`,
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
                    data-graph-node-label={node.id}
                    class={`truncate ${props.labelClass}`}
                    style={{
                      ...props.labelStyle,
                    }}
                    classList={{
                      "text-text-strong": node.isCurrentPath,
                      "text-text-weaker": !node.isCurrentPath,
                      "font-semibold": node.isCurrentPath,
                      "opacity-30": !node.isCurrentPath,
                      italic: node.kind === "bud",
                    }}
                  >
                    {node.kind === "bud" ? "…" : node.label}
                  </div>
                </div>

                <Show when={props.showRowActions ?? true}>
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
                            <DropdownMenu.ItemLabel>
                              {language.t("notification.action.goToSession")}
                            </DropdownMenu.ItemLabel>
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
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
