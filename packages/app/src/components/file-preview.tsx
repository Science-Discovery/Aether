import { ErrorBoundary, lazy, createEffect, createMemo, onCleanup, Show, Suspense, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { text } from "./file-preview/text"
import { read } from "@/utils/preview-read"

const Docx = lazy(() => import("./file-preview/docx"))
const Xlsx = lazy(() => import("./file-preview/xlsx"))
const Pptx = lazy(() => import("./file-preview/pptx"))
const Html = lazy(() => import("./file-preview/html"))

export default function FilePreview(props: {
  kind: "docx" | "xlsx" | "pptx" | "html"
  path: string
  src: string
  auth?: string
  version: number
  source?: string
  read: (path: string, signal: AbortSignal) => Promise<{ data: ArrayBuffer; mime: string }>
  draft: (path: string) => string | undefined
  subscribe: (paths: () => ReadonlySet<string>, callback: () => void) => () => void
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const t = createMemo(() => text(language.locale()))
  const [state, setState] = createStore({
    data: undefined as ArrayBuffer | undefined,
    loading: false,
    error: "",
    attempt: 0,
  })
  let controller: AbortController | undefined
  const fail = (err: unknown) =>
    setState(
      "error",
      err instanceof Error && err.name === "QuotaExceededError"
        ? t().budget
        : err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : t().error,
    )
  const retry = () => setState({ error: "", attempt: state.attempt + 1 })
  createEffect(() => {
    const src = props.src
    const auth = props.auth
    const path = props.path
    const version = props.version
    const attempt = state.attempt
    if (props.kind === "html") return
    const abort = new AbortController()
    controller = abort
    setState({ data: undefined, loading: true, error: "" })
    onCleanup(() => abort.abort())
    void (platform.fetch ?? globalThis.fetch)(src, {
      signal: abort.signal,
      headers: auth ? { Authorization: auth } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`)
        const data = await read(response, abort.signal)
        if (abort.signal.aborted) return
        setState({ data, loading: false })
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          setState("loading", false)
          fail(err)
        }
      })
    void version
    void attempt
  })
  return (
    <div
      class="flex size-full min-h-0 flex-col overflow-hidden"
      data-component="file-preview"
      data-preview-kind={props.kind}
    >
      <ErrorBoundary
        fallback={(err, reset) => (
          <div role="alert" class="p-4 text-text-base">
            {String(err)}{" "}
            <Button
              onClick={() => {
                reset()
                retry()
              }}
            >
              {t().retry}
            </Button>
          </div>
        )}
      >
        <Show
          when={!state.error}
          fallback={
            <div role="alert" class="flex flex-col items-start gap-3 p-5">
              <div>{t().error}</div>
              <div class="break-all text-sm text-text-weak">{state.error}</div>
              <Button size="small" onClick={retry}>
                {t().retry}
              </Button>
            </div>
          }
        >
          <Show
            when={!state.loading}
            fallback={
              <div role="status" class="flex items-center gap-3 p-5 text-text-weak">
                {t().loading}
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    controller?.abort()
                    setState({ loading: false, error: t().cancelled })
                  }}
                >
                  {t().cancel}
                </Button>
              </div>
            }
          >
            <Suspense
              fallback={
                <div role="status" class="p-5 text-text-weak">
                  {t().loading}
                </div>
              }
            >
              <Show
                when={props.kind === "html"}
                fallback={
                  <Show when={state.data} keyed>
                    {(data) => (
                      <Switch>
                        <Match when={props.kind === "docx"}>
                          <Docx data={data} path={props.path} onError={fail} />
                        </Match>
                        <Match when={props.kind === "xlsx"}>
                          <Xlsx data={data} path={props.path} onError={fail} />
                        </Match>
                        <Match when={props.kind === "pptx"}>
                          <Pptx data={data} path={props.path} onError={fail} />
                        </Match>
                      </Switch>
                    )}
                  </Show>
                }
              >
                <Html
                  path={props.path}
                  source={props.source ?? ""}
                  version={props.version + state.attempt}
                  read={props.read}
                  draft={props.draft}
                  subscribe={props.subscribe}
                  onError={fail}
                />
              </Show>
            </Suspense>
          </Show>
        </Show>
      </ErrorBoundary>
    </div>
  )
}
