import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"

const messages = {
  load: "file.image.loadFailed",
  decode: "file.image.decodeFailed",
  limit: "file.image.tooLarge",
  timeout: "file.image.timeout",
} as const

export function FileImage(props: { src: string; path: string; auth?: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useSDK()
  const [state, setState] = createStore({
    url: "",
    loading: true,
    error: "" as "" | "load" | "decode" | "limit" | "timeout",
    status: 0,
    pages: 1,
    attempt: 0,
  })

  createEffect(
    on(
      () => [props.src, props.auth, props.path, state.attempt] as const,
      ([src, auth, path]) => {
        const abort = new AbortController()
        let href = ""
        let phase: "load" | "decode" = "load"
        setState({ url: "", loading: true, error: "", status: 0, pages: 1 })
        onCleanup(() => {
          abort.abort()
          if (href) URL.revokeObjectURL(href)
        })

        const load = async () => {
          const res = await (platform.fetch ?? globalThis.fetch)(src, {
            headers: auth ? { Authorization: auth } : undefined,
            signal: abort.signal,
          })
          if (abort.signal.aborted) return
          if (!res.ok) {
            setState({ loading: false, error: "load", status: res.status })
            return
          }
          const blob = await res.blob()
          if (abort.signal.aborted) return
          phase = "decode"
          const tiff = /\.tiff?$/i.test(path) || /^image\/(?:x-)?tiff(?:;|$)/i.test(blob.type)
          const image = tiff
            ? await import("@/utils/tiff-preview").then(async ({ decodeTiff }) => {
                const data = await decodeTiff(await blob.arrayBuffer(), abort.signal)
                if (abort.signal.aborted) return
                const canvas = document.createElement("canvas")
                canvas.width = data.width
                canvas.height = data.height
                const context = canvas.getContext("2d")
                if (!context) throw new Error("Canvas unavailable")
                context.putImageData(new ImageData(data.data, data.width, data.height), 0, 0)
                const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
                if (!output) throw new Error("Image encoding failed")
                if (!abort.signal.aborted) setState("pages", data.pages)
                return output
              })
            : blob
          if (abort.signal.aborted || !image) return
          href = URL.createObjectURL(image)
          setState("url", href)
        }
        void load().catch((error: unknown) => {
          if (!abort.signal.aborted)
            setState({
              loading: false,
              error:
                error instanceof RangeError && /\.tiff?$/i.test(path)
                  ? "limit"
                  : error instanceof Error && error.name === "TimeoutError"
                    ? "timeout"
                    : phase,
            })
        })
      },
    ),
  )

  const external = () =>
    sdk.client.file.open({ path: props.path }).catch(() =>
      showToast({
        variant: "error",
        title: language.t("toast.file.open.failed.title"),
        description: language.t("toast.file.open.failed.description"),
      }),
    )

  return (
    <div
      class="relative flex h-full min-h-0 items-center justify-center p-6"
      data-component="file-image"
      data-file-content
    >
      <Show when={state.url} keyed>
        {(src) => (
          <img
            src={src}
            alt={props.path}
            class="max-h-full max-w-full object-contain"
            classList={{ invisible: state.loading || !!state.error }}
            onLoad={() => {
              if (state.url === src) setState("loading", false)
            }}
            onError={() => {
              if (state.url === src) setState({ loading: false, error: "decode" })
            }}
          />
        )}
      </Show>
      <Show when={state.loading}>
        <div class="absolute text-13-regular text-text-weak" role="status">
          {language.t("common.loading")}…
        </div>
      </Show>
      <Show when={state.error}>
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
          <p class="text-13-regular text-text-weak">
            {language.t(messages[state.error || "decode"])}
            <Show when={state.status}> (HTTP {state.status})</Show>
          </p>
          <div class="flex flex-wrap justify-center gap-2">
            <Button size="small" onClick={() => setState("attempt", (value) => value + 1)}>
              {language.t("file.image.retry")}
            </Button>
            <Button size="small" variant="ghost" onClick={external}>
              {language.t("file.image.external")}
            </Button>
          </div>
        </div>
      </Show>
      <Show when={!state.loading && !state.error && state.pages > 1}>
        <div class="absolute bottom-2 rounded px-2 py-1 text-12-regular text-text-weak">
          {language.t("file.image.firstPage", { count: state.pages })}
        </div>
      </Show>
    </div>
  )
}
