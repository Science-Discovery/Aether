import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

export function createUserCollapse(input: {
  enabled: () => boolean
  root: () => HTMLElement | undefined
  pause: () => void
}) {
  const [state, setState] = createStore({ enabled: input.enabled() })
  let frame: number | undefined

  createEffect(
    on(
      input.enabled,
      (enabled) => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
        const view = input.root()?.querySelector<HTMLElement>(".scroll-view__viewport")
        const changed = [...(view?.querySelectorAll<HTMLElement>('[data-slot="user-message-content"]') ?? [])].some(
          (el) => {
            const line = Number.parseFloat(getComputedStyle(el).lineHeight)
            return line > 0 && el.getBoundingClientRect().height > line * 10 + 1
          },
        )
        const rect = view?.getBoundingClientRect()
        const offset = view
          ? Number.parseFloat(getComputedStyle(view).getPropertyValue("--session-title-block")) || 0
          : 0
        const el =
          changed && view && rect
            ? [...view.querySelectorAll<HTMLElement>('[data-slot="session-turn-message-container"]')].find((el) => {
                const bounds = el.getBoundingClientRect()
                return bounds.bottom > rect.top + offset && bounds.top < rect.bottom
              })
            : undefined
        const top = el?.getBoundingClientRect().top
        if (changed) input.pause()
        setState("enabled", enabled)
        if (!el || !view || top === undefined) return
        frame = requestAnimationFrame(() => {
          frame = undefined
          if (!el.isConnected || !view.contains(el)) return
          view.scrollTop += el.getBoundingClientRect().top - top
        })
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return { enabled: () => state.enabled }
}
