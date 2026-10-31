import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { text } from "./text"
import type { DocumentProps } from "./types"

export default function Pptx(props: DocumentProps) {
  const language = useLanguage()
  const t = createMemo(() => text(language.locale()))
  const [state, setState] = createStore({ loading: true, page: 1, count: 0, zoom: 100, partial: false })
  let viewport!: HTMLDivElement
  let host!: HTMLDivElement
  let viewer: PptxViewer | undefined
  let live = true
  let serial = 0
  const abort = new AbortController()
  const zoom = (value: number) => {
    const instance = viewer
    if (!instance) return
    const id = ++serial
    const index = state.page - 1
    const percent = Math.max(25, Math.min(400, value))
    setState("zoom", percent)
    void instance
      .setZoom(percent)
      .then(() => {
        if (live && id === serial) return instance.goToSlide(index, { behavior: "instant" })
      })
      .catch((err) => {
        if (live) props.onError(err)
      })
  }
  const page = (value: number) => {
    if (!viewer || value < 1 || value > state.count) return
    serial++
    void viewer.goToSlide(value - 1).catch((err) => {
      if (live) props.onError(err)
    })
  }
  onMount(() => {
    const shadow = host.attachShadow({ mode: "open" })
    const style = document.createElement("style")
    style.textContent =
      ":host{display:block;min-height:100%;color:#171717;font:14px Arial,sans-serif}*{box-sizing:border-box}"
    const container = document.createElement("div")
    shadow.append(style, container)
    viewer = new PptxViewer(container, {
      externalMedia: "block",
      pdfjs: false,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      fitMode: "contain",
      scrollContainer: viewport,
      onSlideChange: (index) => {
        if (live) setState("page", index + 1)
      },
      onSlideError: () => {
        if (live) setState("partial", true)
      },
      onNodeError: () => {
        if (live) setState("partial", true)
      },
    })
    // Read-only slides do not follow document hyperlinks or activate media.
    const block = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    shadow.addEventListener("click", block, true)
    shadow.addEventListener(
      "keydown",
      (event) => {
        if (event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " ")) block(event)
      },
      { capture: true, signal: abort.signal },
    )
    void viewer
      .open(props.data, {
        signal: abort.signal,
        lazySlides: true,
        lazyMedia: true,
        listOptions: { windowed: true, initialSlides: 2, batchSize: 2 },
      })
      .then(() => {
        if (live) setState({ loading: false, count: viewer?.slideCount ?? 0 })
      })
      .catch((err) => {
        if (live && !abort.signal.aborted) props.onError(err)
      })
    onCleanup(() => shadow.removeEventListener("click", block, true))
  })
  onCleanup(() => {
    live = false
    abort.abort()
    viewer?.destroy()
    viewer = undefined
    host.shadowRoot?.replaceChildren()
  })
  return (
    <div class="flex size-full min-h-0 flex-col" data-component="pptx-preview">
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-weak-base px-3 py-1.5">
        <div class="flex items-center gap-1">
          <Button
            size="small"
            variant="ghost"
            disabled={state.loading || state.page <= 1}
            aria-label={t().previous}
            onClick={() => page(state.page - 1)}
          >
            ‹
          </Button>
          <span class="min-w-14 text-center text-xs text-text-base" aria-live="polite">
            {state.page} / {state.count || "–"}
          </span>
          <Button
            size="small"
            variant="ghost"
            disabled={state.loading || state.page >= state.count}
            aria-label={t().next}
            onClick={() => page(state.page + 1)}
          >
            ›
          </Button>
        </div>
        <div class="flex items-center gap-1">
          <Button
            size="small"
            variant="ghost"
            aria-label={t().zoomout}
            disabled={state.loading}
            onClick={() => zoom(state.zoom - 25)}
          >
            −
          </Button>
          <span class="w-11 text-center text-xs text-text-weak">{state.zoom}%</span>
          <Button
            size="small"
            variant="ghost"
            aria-label={t().zoomin}
            disabled={state.loading}
            onClick={() => zoom(state.zoom + 25)}
          >
            ＋
          </Button>
          <Button size="small" variant="ghost" disabled={state.loading} onClick={() => zoom(100)}>
            {t().fit}
          </Button>
        </div>
      </div>
      <Show when={state.loading}>
        <div role="status" class="flex items-center gap-2 px-4 py-2 text-xs text-text-weak">
          {t().loading}
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              abort.abort()
              props.onError(new Error(t().cancelled))
            }}
          >
            {t().cancel}
          </Button>
        </div>
      </Show>
      <Show when={state.partial}>
        <div role="status" class="px-3 py-1 text-xs text-text-weak">
          {t().partial}
        </div>
      </Show>
      <div
        ref={viewport}
        class="min-h-0 flex-1 overflow-auto bg-background-base p-3"
        role="region"
        aria-label={t().slides}
        tabIndex={0}
      >
        <div ref={host} />
      </div>
      <div class="shrink-0 border-t border-border-weak-base px-3 py-1 text-xs text-text-weak">{t().readonly}</div>
    </div>
  )
}
