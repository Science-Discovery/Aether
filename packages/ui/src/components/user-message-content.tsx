import { createEffect, createUniqueId, on, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"

export function UserMessageContent(
  props: ParentProps<{
    id: string
    version: string
    collapse?: boolean
    onResize?: () => (() => void) | void
  }>,
) {
  const i18n = useI18n()
  const id = createUniqueId()
  const [state, setState] = createStore({ enabled: props.collapse ?? true, expanded: false, overflow: false })
  let content: HTMLDivElement | undefined
  let frame: number | undefined

  const resize = (apply: () => void) => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    const after = props.onResize?.()
    apply()
    frame = requestAnimationFrame(() => {
      frame = undefined
      after?.()
    })
  }
  const measure = () => {
    if (!content) return
    const line = Number.parseFloat(getComputedStyle(content).lineHeight)
    setState("overflow", line > 0 && content.getBoundingClientRect().height > line * 10 + 1)
  }

  createEffect(
    on(
      () => [props.id, props.version],
      () => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
        setState("expanded", false)
        measure()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.collapse ?? true,
      (enabled) => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
        setState({ enabled, expanded: false })
      },
      { defer: true },
    ),
  )

  onMount(() => {
    if (!content) return
    const reveal = () => {
      if (!state.enabled || state.expanded || !state.overflow) return
      resize(() => setState("expanded", true))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    content.addEventListener("beforematch", reveal)
    window.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("resize", measure)
    document.fonts?.addEventListener("loadingdone", measure)
    measure()
    onCleanup(() => {
      observer.disconnect()
      content?.removeEventListener("beforematch", reveal)
      window.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("resize", measure)
      document.fonts?.removeEventListener("loadingdone", measure)
    })
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return (
    <>
      <div data-slot="user-message-viewport" data-collapsed={state.enabled && !state.expanded ? "true" : undefined}>
        <div ref={content} id={id} data-slot="user-message-content">
          {props.children}
        </div>
      </div>
      <Show when={state.enabled && state.overflow}>
        <button
          type="button"
          data-slot="user-message-toggle"
          aria-expanded={state.expanded}
          aria-controls={id}
          onClick={(event) => {
            event.stopPropagation()
            resize(() => setState("expanded", !state.expanded))
          }}
        >
          {i18n.t(state.expanded ? "ui.message.showLess" : "ui.message.showMore")}
          <Icon name="chevron-down" size="small" />
        </button>
      </Show>
    </>
  )
}
