import { Component, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

type PromptDragOverlayProps = {
  type: "image" | "@mention" | null
  label: string
}

const kindToIcon = {
  image: "photo",
  "@mention": "link",
} as const

export const PromptDragOverlay: Component<PromptDragOverlayProps> = (props) => {
  return (
    <Show when={props.type !== null}>
      <div class="absolute bottom-1 left-0 right-0 z-10 flex items-center justify-center pointer-events-none">
        <div class="flex items-center gap-1.5 text-text-weaker">
          <Icon name={props.type ? kindToIcon[props.type] : kindToIcon.image} class="size-4" />
          <span class="text-12-regular">{props.label}</span>
        </div>
      </div>
    </Show>
  )
}
