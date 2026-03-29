import { type Component, For, Show } from "solid-js"
import { type ReadingHighlightColor } from "@/context/reading-mode"

export type SelectionPopupState = {
  text: string
  page: number
  x: number
  y: number
  rects: Array<{ x1: number; y1: number; x2: number; y2: number }>
}

export const SelectionPopup: Component<{
  popup: SelectionPopupState | null
  highlightOpen: boolean
  onClose: () => void
  onHighlightMenu: () => void
  onHighlight: (color: ReadingHighlightColor) => void
  onTranslate: () => void
  onAsk: () => void
  onCopy: () => void
}> = (props) => {
  const colors: ReadingHighlightColor[] = ["yellow", "red", "green", "blue"]

  return (
    <Show when={props.popup}>
      {(popup) => (
        <div
          data-reading-selection-popup="true"
          class="fixed z-20 flex w-[240px] items-center justify-between gap-1 rounded-lg border border-border-base bg-surface-raised-base px-2 py-1 shadow-lg"
          style={{ left: `${popup().x}px`, top: `${popup().y}px`, transform: "translateX(-50%)" }}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <button type="button" class="rounded px-2 py-1 text-xs hover:bg-surface-base" onClick={props.onHighlightMenu}>
            Highlight
          </button>
          <button type="button" class="rounded px-2 py-1 text-xs hover:bg-surface-base" onClick={props.onTranslate}>
            Translate
          </button>
          <button type="button" class="rounded px-2 py-1 text-xs hover:bg-surface-base" onClick={props.onAsk}>
            Ask
          </button>
          <button type="button" class="rounded px-2 py-1 text-xs hover:bg-surface-base" onClick={props.onCopy}>
            Copy
          </button>
          <button type="button" class="rounded px-1 py-1 text-xs hover:bg-surface-base" onClick={props.onClose}>
            x
          </button>

          <Show when={props.highlightOpen}>
            <div class="absolute left-0 top-full mt-1 flex gap-1 rounded-md border border-border-base bg-surface-raised-base p-1 shadow-lg">
              <For each={colors}>
                {(color) => (
                  <button
                    type="button"
                    class="size-5 rounded-full border border-border-base"
                    style={{ "background-color": color }}
                    onClick={() => props.onHighlight(color)}
                    title={color}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
