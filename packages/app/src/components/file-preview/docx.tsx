import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { parseAsync, renderDocument } from "docx-preview"
import { useLanguage } from "@/context/language"
import { factory, source } from "./docx-dom"
import { text } from "./text"
import type { DocumentProps } from "./types"

export default function Docx(props: DocumentProps) {
  const language = useLanguage()
  const t = createMemo(() => text(language.locale()))
  const [state, setState] = createStore({ frame: 0, ready: false, scale: 1, fit: true })
  let frame: HTMLIFrameElement | undefined
  let observer: ResizeObserver | undefined
  let serial = 0
  const fit = () => {
    if (!state.ready || !state.fit) return
    const pages = frame?.contentDocument?.querySelectorAll<HTMLElement>("section.docx")
    if (!pages?.length) return
    const width = Math.max(...Array.from(pages, (page) => page.offsetWidth))
    if (!width || !frame?.clientWidth) return
    setState("scale", Math.min(1, Math.max(0.1, frame.clientWidth / (width + 32))))
  }
  const zoom = (factor: number) => setState({ fit: false, scale: Math.min(3, Math.max(0.1, state.scale * factor)) })
  const cancel = () => {
    serial++
    observer?.disconnect()
    frame?.contentDocument?.getElementById("document")?.replaceChildren()
    props.onError(new Error(t().cancelled))
  }

  createEffect(
    on(
      () => [props.data, state.frame] as const,
      ([data, ready]) => {
        const id = ++serial
        observer?.disconnect()
        setState({ ready: false, scale: 1, fit: true })
        const doc = ready ? frame?.contentDocument : undefined
        const root = doc?.getElementById("document")
        if (!doc || !root) return
        root.replaceChildren()
        const alive = () => id === serial
        const opts = {
          useBase64URL: true,
          renderAltChunks: false,
          renderComments: false,
          experimental: false,
          h: factory(doc, alive),
        }
        // The library has no Abort API. A disposed frame rejects later output;
        // an already-running synchronous parse cannot be preempted by cancellation.
        void parseAsync(data, opts)
          .then((model) => {
            if (!alive()) return
            return renderDocument(model, opts)
          })
          .then((nodes) => {
            if (!alive() || !nodes) return
            root.replaceChildren(...nodes)
            setState("ready", true)
            observer = new ResizeObserver(fit)
            if (frame) observer.observe(frame)
            doc.querySelectorAll("section.docx").forEach((page) => observer?.observe(page))
            fit()
          })
          .catch((error: unknown) => {
            if (alive()) props.onError(error)
          })
      },
    ),
  )

  createEffect(() => {
    const scale = state.scale
    const ready = state.ready
    const root = frame?.contentDocument?.getElementById("document")
    if (root && ready) root.style.zoom = String(scale)
  })

  onCleanup(() => {
    serial++
    observer?.disconnect()
    frame?.contentDocument?.getElementById("document")?.replaceChildren()
  })

  return (
    <div class="flex size-full min-h-0 flex-col" data-component="docx-preview">
      <div class="flex min-w-0 shrink-0 items-center gap-1 border-b border-border-weaker-base px-2 py-1">
        <span class="mr-auto truncate px-1 text-sm text-text-weak" title={props.path}>
          {props.path.split(/[\\/]/).pop()}
        </span>
        <Button
          size="small"
          variant="ghost"
          aria-label={t().zoomout}
          title={t().zoomout}
          disabled={!state.ready}
          onClick={() => zoom(1 / 1.2)}
        >
          −
        </Button>
        <span class="w-12 text-center text-xs tabular-nums text-text-weak" data-docx-scale>
          {Math.round(state.scale * 100)}%
        </span>
        <Button
          size="small"
          variant="ghost"
          aria-label={t().zoomin}
          title={t().zoomin}
          disabled={!state.ready}
          onClick={() => zoom(1.2)}
        >
          +
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={!state.ready}
          onClick={() => {
            setState("fit", true)
            fit()
          }}
        >
          {t().fit}
        </Button>
      </div>
      <div class="relative min-h-0 flex-1">
        <Show when={!state.ready}>
          <div role="status" class="absolute inset-0 z-10 flex items-start gap-3 bg-background-base p-4 text-text-weak">
            {t().loading}
            <Button size="small" variant="ghost" onClick={cancel}>
              {t().cancel}
            </Button>
          </div>
        </Show>
        <iframe
          ref={frame}
          title={t().word}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcdoc={source}
          class="size-full border-0"
          onLoad={() => setState("frame", (value) => value + 1)}
        />
      </div>
      <div class="shrink-0 border-t border-border-weaker-base px-3 py-1 text-xs text-text-weak">{t().readonly}</div>
    </div>
  )
}
