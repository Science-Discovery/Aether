import { Show } from "solid-js"
import type { Columns } from "./columns"
import type { GraphNode } from "./model"
import { RefLabels } from "./refs"
import { ROW_HEIGHT } from "./model"
import { template } from "./columns"
import { abbrev, ago, color } from "./style"

export function GitGraphRow(props: {
  node: GraphNode
  columns: Columns
  currentBranch: string | null | undefined
  uncommitted?: { count: number; files: string[] }
  hovered: boolean
  selected: boolean
  onEnter: (node: GraphNode, event: MouseEvent) => void
  onLeave: () => void
  onClick?: (hash: string) => void
  onContextMenu?: (hash: string, event: MouseEvent) => void
}) {
  const message = () =>
    props.node.isUncommitted
      ? `Uncommitted Changes${props.uncommitted ? ` (${props.uncommitted.count})` : ""}`
      : props.node.message

  return (
    <div
      class="grid cursor-pointer items-center overflow-hidden border-b border-border-weaker-base text-[13px] transition-colors"
      classList={{
        "bg-surface-base-hover": props.hovered,
        "bg-surface-base-active": props.selected,
      }}
      style={{
        height: `${ROW_HEIGHT}px`,
        "grid-template-columns": template(props.columns),
      }}
      onMouseEnter={(event) => props.onEnter(props.node, event)}
      onMouseLeave={props.onLeave}
      onClick={() => props.onClick?.(props.node.hash)}
      onContextMenu={(event) => {
        event.preventDefault()
        props.onContextMenu?.(props.node.hash, event)
      }}
    >
      <div class="min-w-0 overflow-hidden" />
      <div class="flex min-w-0 items-center gap-1 overflow-hidden px-1">
        <Show when={props.node.isHead}>
          <span
            class="size-2 shrink-0 rounded-full border-2"
            style={{
              "border-color": color(props.node.colorIndex),
            }}
            title="This commit is currently checked out"
          />
        </Show>
        <RefLabels node={props.node} currentBranch={props.currentBranch} />
        <span
          class="min-w-0 flex-1 truncate text-text-base"
          classList={{
            "font-semibold": props.node.isHead,
            "text-text-weaker": props.node.isUncommitted,
          }}
          title={message()}
        >
          {message()}
        </span>
      </div>
      <div class="min-w-0 truncate px-1 text-text-weaker" title={props.node.author}>
        {props.node.author}
      </div>
      <div class="min-w-0 truncate px-1 text-right text-text-weaker" title={new Date(props.node.date * 1000).toString()}>
        {props.node.isUncommitted ? "" : ago(props.node.date)}
      </div>
      <div class="min-w-0 truncate px-1 font-mono text-[11px] text-text-weaker" title={props.node.hash}>
        {props.node.isUncommitted ? "" : abbrev(props.node.hash)}
      </div>
    </div>
  )
}
