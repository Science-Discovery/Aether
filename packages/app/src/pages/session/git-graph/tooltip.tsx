import { For, Show } from "solid-js"
import type { JSX } from "solid-js"
import type { GraphNode } from "./model"
import { RefChip, refsFor } from "./refs"
import { abbrev, formatDate } from "./style"

const Section = (props: { children: JSX.Element }) => (
  <div class="border-t border-border-weaker-base px-3 py-1">{props.children}</div>
)

function RefList(props: { refs: ReturnType<typeof refsFor> }) {
  return (
    <span class="ml-1 inline-flex max-w-[240px] flex-wrap items-center gap-1 align-middle">
      <For each={props.refs.slice(0, 8)}>{(ref) => <RefChip item={ref} />}</For>
      <Show when={props.refs.length > 8}>
        <span class="text-[11px] text-text-weaker">+{props.refs.length - 8}</span>
      </Show>
    </span>
  )
}

export function GitGraphTooltip(props: {
  node: GraphNode
  color: string
  side: "left" | "right"
  currentBranch: string | null
  uncommitted?: { count: number; files: string[] }
}) {
  const refs = () => refsFor(props.node, props.currentBranch)
  const heads = () => refs().filter((ref) => ref.kind === "head")
  const remotes = () => refs().filter((ref) => ref.kind === "remote")
  const tags = () => refs().filter((ref) => ref.kind === "tag")

  return (
    <div
      class="relative text-xs text-text-base"
      style={{
        width: "340px",
      }}
    >
      <div
        class="absolute top-1/2 h-0.5 w-6 -translate-y-1/2"
        classList={{
          "left-0": props.side === "right",
          "right-0": props.side === "left",
        }}
        style={{ "background-color": props.color }}
      />
      <div
        class="absolute top-1/2 size-2 -translate-y-1/2 rotate-45 border-b border-l border-border-weaker-base bg-surface-base"
        classList={{
          "left-[21px]": props.side === "right",
          "right-[21px]": props.side === "left",
        }}
      />
      <div
        class="relative overflow-hidden rounded-md border-2 bg-surface-base shadow-lg"
        classList={{
          "ml-6": props.side === "right",
          "mr-6": props.side === "left",
        }}
        style={{ "border-color": props.color }}
      >
        <div class="px-3 py-1 text-center font-mono text-11-regular font-semibold text-text-base">
          {props.node.isUncommitted ? "Uncommitted Changes" : `Commit ${abbrev(props.node.hash)}`}
        </div>

        <Show when={props.currentBranch && !props.node.isUncommitted}>
          <Section>
            {props.node.heads.includes(props.currentBranch!) ? (
              <span>
                Included in <span class="font-medium text-text-base">HEAD</span>
              </span>
            ) : (
              <span>
                <b>
                  <i>Not</i>
                </b>{" "}
                included in <span class="font-medium text-text-base">HEAD</span>
              </span>
            )}
          </Section>
        </Show>

        <Show when={props.node.isUncommitted && props.uncommitted}>
          <Section>
            {props.uncommitted!.count} file{props.uncommitted!.count !== 1 ? "s" : ""} changed
            <div class="mt-1 max-h-[120px] overflow-y-auto">
              <For each={props.uncommitted!.files.slice(0, 20)}>
                {(file) => <div class="truncate font-mono text-[10px] text-text-weaker">{file}</div>}
              </For>
            </div>
            <Show when={(props.uncommitted?.files.length ?? 0) > 20}>
              <div class="mt-0.5 text-text-weaker">...and {props.uncommitted!.files.length - 20} more</div>
            </Show>
          </Section>
        </Show>

        <Show when={heads().length > 0}>
          <Section>
            Branches:
            <RefList refs={heads()} />
          </Section>
        </Show>

        <Show when={tags().length > 0}>
          <Section>
            Tags:
            <RefList refs={tags()} />
          </Section>
        </Show>

        <Show when={remotes().length > 0}>
          <Section>
            Remotes:
            <RefList refs={remotes()} />
          </Section>
        </Show>

        <Show when={!props.node.isUncommitted}>
          <Section>
            <div class="text-text-weaker">
              {props.node.author} · {formatDate(props.node.date)}
            </div>
            <div class="mt-1 break-words whitespace-pre-wrap text-text-base">{props.node.message}</div>
          </Section>
        </Show>
      </div>
    </div>
  )
}
