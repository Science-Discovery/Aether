import { Select } from "@opencode-ai/ui/select"
import { createMemo, type JSX } from "solid-js"

export function VariantSelect(props: {
  variants: string[]
  current?: string
  label: string
  provider: string
  onSelect: (value: string | undefined) => void
  style?: JSX.CSSProperties
}) {
  // An omitted variant and a provider effort literally named "default" are distinct choices.
  const options = createMemo(() => [
    { id: undefined, label: props.label },
    ...props.variants.map((id) => ({ id, label: id === "default" ? `${id} (${props.provider})` : id })),
  ])
  return (
    <Select
      size="normal"
      options={options()}
      current={options().find((item) => item.id === props.current) ?? options()[0]}
      value={(item) => (item.id === undefined ? "automatic" : `effort:${item.id}`)}
      label={(item) => item.label}
      onSelect={(item) => props.onSelect(item?.id)}
      class="capitalize max-w-[160px] text-text-base"
      valueClass="truncate text-13-regular text-text-base"
      triggerStyle={props.style}
      triggerProps={{ "data-action": "prompt-model-variant" }}
      variant="ghost"
    />
  )
}
