import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { htmlRender } from "./html-render"
import { htmlText } from "./html-text"
import type { HtmlRead } from "./html-convert"

export default function HtmlPreview(props: {
  path: string
  source: string
  version: number
  read: HtmlRead
  draft?: (path: string) => string | undefined
  subscribe?: (paths: () => ReadonlySet<string>, callback: () => void) => () => void
  onError: (error: unknown) => void
}) {
  const language = useLanguage()
  const text = (key: Parameters<typeof htmlText>[1]) => htmlText(language.locale(), key)
  const [state, setState] = createStore({
    html: "",
    busy: true,
    error: "",
    missing: 0,
    blocked: 0,
    revision: 0,
    deps: [] as string[],
  })
  const deps = createMemo(() => new Set(state.deps))
  const refresh = () => setState("revision", (value) => value + 1)
  const source = createMemo(() => ({
    path: props.path,
    source: props.source,
    version: props.version,
    revision: state.revision,
  }))
  createEffect(
    on(source, (snapshot) => {
      const controller = new AbortController()
      setState({ busy: true, error: "" })
      // Clear document data as soon as its identity changes; stale HTML must not
      // survive a failed refresh or a switch to another file.
      setState("html", "")
      void htmlRender({ ...snapshot, signal: controller.signal, read: props.read, draft: props.draft }).then(
        (result) => {
          if (controller.signal.aborted) return
          if (JSON.stringify(state.deps) !== JSON.stringify(result.deps)) setState("deps", result.deps)
          setState({ html: result.html, busy: false, missing: result.missing, blocked: result.blocked })
        },
        (error: unknown) => {
          if (controller.signal.aborted) return
          setState({ busy: false, error: error instanceof Error ? error.message : String(error) })
          props.onError(error)
        },
      )
      onCleanup(() => controller.abort())
    }),
  )
  createEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = props.subscribe?.(deps, () => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 180)
    })
    onCleanup(() => {
      clearTimeout(timer)
      stop?.()
    })
  })
  return (
    <div data-component="html-preview" class="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div class="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b border-border-weak-base px-3 py-1 text-xs text-text-weak">
        <span class="min-w-0 truncate" title={text("static")}>
          {state.missing ? `${text("partial")} (${state.missing})` : text("static")}
        </span>
        <button
          type="button"
          class="shrink-0 rounded px-2 py-1 hover:bg-surface-base-hover disabled:opacity-50"
          onClick={refresh}
          disabled={state.busy}
          title={text("refresh")}
          aria-label={text("refresh")}
        >
          ↻
        </button>
      </div>
      <Show
        when={!state.busy}
        fallback={
          <div role="status" class="flex flex-1 items-center justify-center p-6 text-sm text-text-weak">
            {text("loading")}
          </div>
        }
      >
        <Show
          when={!state.error}
          fallback={
            <div
              role="alert"
              class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-text-weak"
            >
              <span>{text("failed")}</span>
              <span class="max-w-full break-words text-xs">{state.error}</span>
              <button
                type="button"
                class="rounded border border-border-weak-base px-3 py-1.5 text-text-base"
                onClick={refresh}
              >
                {text("retry")}
              </button>
            </div>
          }
        >
          <iframe
            title={text("title")}
            srcdoc={state.html}
            sandbox=""
            referrerpolicy="no-referrer"
            class="min-h-0 w-full flex-1 border-0 bg-white"
            style={{ "background-color": "#fff", "color-scheme": "light" }}
          />
        </Show>
      </Show>
    </div>
  )
}
