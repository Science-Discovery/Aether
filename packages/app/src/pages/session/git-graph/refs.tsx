import { For, Show } from "solid-js"
import type { GraphNode } from "./model"

type Head = {
  kind: "head"
  name: string
  full: string
  active: boolean
  remotes: { name: string; full: string }[]
}

type Remote = {
  kind: "remote"
  name: string
  full: string
  remote: string | null
}

type Tag = {
  kind: "tag"
  name: string
  full: string
  annotated: boolean
}

export type Ref = Head | Remote | Tag

const title = (item: Ref) => {
  if (item.kind === "head" && item.remotes.length > 0) return `${item.full} (${item.remotes.map((r) => r.full).join(", ")})`
  if (item.kind === "tag") return `${item.full}${item.annotated ? " (annotated)" : ""}`
  return item.full
}

const chip = (item: Ref) => ({
  "border-accent-base/70 bg-accent-base/10 text-text-base": item.kind === "head" && item.active,
  "border-border-weaker-base bg-surface-base text-text-base": item.kind === "head" && !item.active,
  "border-border-weaker-base bg-surface-base text-text-weaker": item.kind === "remote",
  "border-border-weaker-base bg-surface-base text-text-weak": item.kind === "tag",
})

const icon = (item: Ref) => ({
  "bg-accent-base text-surface-base": item.kind === "head" && item.active,
  "bg-text-weaker text-surface-base": item.kind !== "head" || !item.active,
})

export const refsFor = (node: GraphNode, branch: string | null | undefined) => {
  const heads: Head[] = node.heads.map((name) => ({
    kind: "head" as const,
    name,
    full: name,
    active: name === branch,
    remotes: [],
  }))
  const map = new Map(heads.map((head, idx) => [head.name, idx]))
  const remotes = node.remotes.flatMap((remote) => {
    if (remote.remote !== null && remote.name.startsWith(`${remote.remote}/`)) {
      const name = remote.name.slice(remote.remote.length + 1)
      const idx = map.get(name)
      if (idx !== undefined) {
        heads[idx]!.remotes.push({ name: remote.remote, full: remote.name })
        return []
      }
    }

    return [{ kind: "remote" as const, name: remote.name, full: remote.name, remote: remote.remote }]
  })
  const tags = node.tags.map((tag) => ({
    kind: "tag" as const,
    name: tag.name,
    full: tag.name,
    annotated: tag.annotated,
  }))

  return [...heads.sort((a, z) => Number(z.active) - Number(a.active)), ...remotes, ...tags]
}

function BranchIcon() {
  return (
    <svg class="size-3" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M6.3 3.3a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm0 9.9a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm7.4-9.9a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6ZM6.3 6.9v6.3m7.4-6.3v4.3a3 3 0 0 1-3 3H8.1"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

function TagIcon() {
  return (
    <svg class="size-3" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3.5 4.5v5.1l6.9 6.9 5.1-5.1-6.9-6.9H3.5Zm3.7 3.7h.1"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

export function RefChip(props: { item: Ref }) {
  return (
    <span
      class="inline-flex h-[18px] max-w-48 shrink-0 items-center overflow-hidden rounded-[5px] border text-[11px] leading-none"
      classList={chip(props.item)}
      data-git-graph-ref-kind={props.item.kind}
      data-fullref={props.item.full}
      data-remote={props.item.kind === "remote" ? (props.item.remote ?? "") : undefined}
      data-tagtype={props.item.kind === "tag" ? (props.item.annotated ? "annotated" : "lightweight") : undefined}
      title={title(props.item)}
    >
      <span class="flex h-full w-[18px] shrink-0 items-center justify-center" classList={icon(props.item)}>
        <Show when={props.item.kind === "tag"} fallback={<BranchIcon />}>
          <TagIcon />
        </Show>
      </span>
      <span class="truncate px-1.5" classList={{ "font-semibold": props.item.kind === "head" && props.item.active }}>
        {props.item.name}
      </span>
      <For each={props.item.kind === "head" ? props.item.remotes : []}>
        {(remote) => (
          <span
            class="h-full shrink-0 border-l border-current/25 px-1 italic leading-[17px] text-text-weaker"
            data-git-graph-ref-remote={remote.name}
            data-fullref={remote.full}
            title={remote.full}
          >
            {remote.name}
          </span>
        )}
      </For>
    </span>
  )
}

export function RefLabels(props: { node: GraphNode; currentBranch: string | null | undefined }) {
  const refs = () => refsFor(props.node, props.currentBranch)

  return (
    <Show when={refs().length > 0}>
      <span class="flex min-w-0 shrink-0 items-center gap-1">
        <For each={refs()}>{(ref) => <RefChip item={ref} />}</For>
      </span>
    </Show>
  )
}
