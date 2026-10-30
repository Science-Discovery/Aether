import { For, Show, createEffect, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { AskAnchor } from "@/components/ask-editor"
import type { Reference } from "@/utils/ask-reference"
import { conversationRanges } from "./conversation-selection"

type Source = Extract<Reference, { kind: "conversation" }>
type Box = { top: number; left: number; right: number; bottom: number }
type Mark = { reference: Source; number: number; boxes: Box[]; anchor?: Box; badge?: Box }

export function placeConversationMarks(anchors: readonly (Box & { width: number })[], bounds: Box) {
  const placed: Box[] = []
  return anchors.map((anchor) => {
    const width = Math.min(anchor.width, bounds.right - bounds.left - 8)
    const height = 20
    if (width < 16 || bounds.bottom - bounds.top < height + 8) return
    const left = Math.max(bounds.left + 4, Math.min(anchor.right + 3, bounds.right - width - 4))
    const top = Math.max(bounds.top + 4, Math.min(anchor.top - 10, bounds.bottom - height - 4))
    const positions = Array.from({ length: placed.length + 1 }, (_, index) => index).flatMap((index) =>
      index === 0
        ? [{ left, top }]
        : [
            { left: left + index * (width + 4), top },
            { left: left - index * (width + 4), top },
            { left, top: top - index * (height + 4) },
            { left, top: top + index * (height + 4) },
          ],
    )
    const position = positions.find(
      (position) =>
        position.left >= bounds.left + 4 &&
        position.top >= bounds.top + 4 &&
        position.left + width <= bounds.right - 4 &&
        position.top + height <= bounds.bottom - 4 &&
        !placed.some(
          (box) =>
            position.left < box.right + 3 &&
            position.left + width > box.left - 3 &&
            position.top < box.bottom + 3 &&
            position.top + height > box.top - 3,
        ),
    )
    if (!position) return
    const box = { ...position, right: position.left + width, bottom: position.top + height }
    placed.push(box)
    return box
  })
}

export function ConversationMarks(props: {
  root: Accessor<HTMLElement | undefined>
  viewport: Accessor<HTMLElement | undefined>
  references: readonly Reference[]
  editing?: Reference
  onSelect: (reference: Source, anchor: AskAnchor) => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    marks: [] as Mark[],
    preview: [] as Box[],
    hovered: "",
    focused: "",
  })
  let frame: number | undefined

  const measure = () => {
    frame = undefined
    const root = props.root()
    const viewport = props.viewport()
    if (!root || !viewport) return
    const area = viewport.getBoundingClientRect()
    const title = viewport.querySelector<HTMLElement>("[data-session-title]")?.getBoundingClientRect()
    const bounds = {
      top: Math.max(area.top, title?.bottom ?? area.top),
      left: area.left,
      right: area.right,
      bottom: area.bottom,
    }
    const intersect = (rect: Box, clip: Box) => ({
      top: Math.max(rect.top, clip.top),
      left: Math.max(rect.left, clip.left),
      right: Math.min(rect.right, clip.right),
      bottom: Math.min(rect.bottom, clip.bottom),
    })
    const local = (box: Box) => ({
      top: box.top - area.top,
      left: box.left - area.left,
      right: box.right - area.left,
      bottom: box.bottom - area.top,
    })
    const geometry = (reference: Source) => {
      const ranges = conversationRanges(root, reference)
      const boxes = ranges.flatMap(({ range, container }) => {
        let clip = bounds
        let parent: HTMLElement | null = container
        while (parent && parent !== viewport) {
          const style = getComputedStyle(parent)
          const rect = parent.getBoundingClientRect()
          if ([style.overflowX, style.overflowY].some((value) => /^(auto|scroll|hidden|clip)$/.test(value)))
            clip = intersect(clip, {
              left: /^(auto|scroll|hidden|clip)$/.test(style.overflowX) ? rect.left : clip.left,
              right: /^(auto|scroll|hidden|clip)$/.test(style.overflowX) ? rect.right : clip.right,
              top: /^(auto|scroll|hidden|clip)$/.test(style.overflowY) ? rect.top : clip.top,
              bottom: /^(auto|scroll|hidden|clip)$/.test(style.overflowY) ? rect.bottom : clip.bottom,
            })
          parent = parent.parentElement
        }
        return Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({ rect, clip: intersect(rect, clip) }))
      })
      const last = boxes.at(-1)
      return {
        boxes: boxes
          .filter(({ clip }) => clip.right > clip.left && clip.bottom > clip.top)
          .map(({ clip }) => local(clip)),
        // A long selection may remain partly visible after its endpoint leaves the viewport.
        anchor:
          last &&
          last.rect.right <= last.clip.right &&
          last.clip.bottom > last.clip.top &&
          last.clip.right > last.clip.left
            ? local(last.clip)
            : undefined,
      }
    }
    const marks = props.references.flatMap((reference, index): Mark[] =>
      reference.kind === "conversation" ? [{ reference, number: index + 1, ...geometry(reference) }] : [],
    )
    const visible = marks.filter((mark) => mark.anchor)
    const positions = placeConversationMarks(
      visible.map((mark) => ({ ...mark.anchor!, width: Math.max(20, String(mark.number).length * 7 + 8) })),
      local(bounds),
    )
    visible.forEach((mark, index) => (mark.badge = positions[index]))
    setState({
      marks,
      preview: props.editing?.kind === "conversation" ? geometry(props.editing).boxes : [],
      hovered: marks.some((mark) => mark.badge && mark.reference.id === state.hovered) ? state.hovered : "",
      focused: marks.some((mark) => mark.badge && mark.reference.id === state.focused) ? state.focused : "",
    })
  }
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(measure)
  }
  createEffect(() => {
    props.references
    props.editing
    schedule()
  })
  onMount(() => {
    const root = props.root()
    const viewport = props.viewport()
    if (!root || !viewport) return
    const mutation = new MutationObserver(schedule)
    mutation.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-assistant-collapsed"],
    })
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    resize.observe(viewport)
    window.addEventListener("scroll", schedule, true)
    window.addEventListener("resize", schedule)
    root.addEventListener("contentvisibilityautostatechange", schedule, true)
    document.fonts?.addEventListener("loadingdone", schedule)
    schedule()
    onCleanup(() => {
      mutation.disconnect()
      resize.disconnect()
      window.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      root.removeEventListener("contentvisibilityautostatechange", schedule, true)
      document.fonts?.removeEventListener("loadingdone", schedule)
    })
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  const highlights = () =>
    props.editing
      ? state.preview
      : state.marks
          .filter((mark) => mark.reference.id === (state.hovered || state.focused))
          .flatMap((mark) => mark.boxes)

  return (
    <div data-component="conversation-marks" class="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <For each={highlights()}>
        {(box) => (
          <div
            data-component="conversation-reference-highlight"
            aria-hidden="true"
            class="absolute rounded-sm"
            style={{
              top: `${box.top}px`,
              left: `${box.left}px`,
              width: `${box.right - box.left}px`,
              height: `${box.bottom - box.top}px`,
              background: "rgb(59 130 246 / 20%)",
            }}
          />
        )}
      </For>
      <For each={state.marks.filter((mark) => mark.badge).map((mark) => mark.reference.id)}>
        {(id) => {
          const mark = createMemo(() => state.marks.find((mark) => mark.reference.id === id && mark.badge))
          return (
            <Show when={mark()}>
              {(value) => (
                <button
                  type="button"
                  data-component="conversation-reference-mark"
                  data-reference-id={id}
                  class="pointer-events-auto absolute flex items-center justify-center rounded-full border bg-background-base font-sans text-11-medium shadow-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#3b82f6]"
                  style={{
                    top: `${value().badge!.top}px`,
                    left: `${value().badge!.left}px`,
                    width: `${value().badge!.right - value().badge!.left}px`,
                    height: `${value().badge!.bottom - value().badge!.top}px`,
                    color: "#3b82f6",
                    "border-color": "rgb(59 130 246 / 55%)",
                  }}
                  aria-label={language.t("ask.reference.title", { number: value().number })}
                  title={language.t("ask.reference.title", { number: value().number })}
                  onMouseEnter={() => setState("hovered", id)}
                  onMouseLeave={() => setState("hovered", "")}
                  onFocus={() => setState("focused", id)}
                  onBlur={() => setState("focused", "")}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onSelect(value().reference, event.currentTarget.getBoundingClientRect())
                  }}
                >
                  {value().number}
                </button>
              )}
            </Show>
          )
        }}
      </For>
    </div>
  )
}
