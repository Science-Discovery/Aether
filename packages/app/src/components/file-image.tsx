import { createEffect, on, onCleanup, onMount, Show } from "solid-js"
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
    width: 0,
    height: 0,
    columns: 0,
    rows: 0,
    scale: 1,
    angle: 0,
    x: 0,
    y: 0,
    fit: true,
    dragging: false,
  })
  let viewport!: HTMLDivElement
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined

  const ready = () => !state.loading && !state.error && state.width > 0 && state.height > 0
  const ratio = (angle = state.angle) => {
    if (!state.width || !state.height || !state.columns || !state.rows) return 1
    return Math.min(
      1,
      Math.max(1, state.columns - 32) / (angle % 180 ? state.height : state.width),
      Math.max(1, state.rows - 32) / (angle % 180 ? state.width : state.height),
    )
  }
  const pan = (x: number, y: number, scale = state.scale, angle = state.angle) => {
    const width = Math.max(0, ((angle % 180 ? state.height : state.width) * scale - state.columns) / 2)
    const height = Math.max(0, ((angle % 180 ? state.width : state.height) * scale - state.rows) / 2)
    return { x: Math.max(-width, Math.min(width, x)), y: Math.max(-height, Math.min(height, y)) }
  }
  const release = () => {
    const id = drag?.id
    drag = undefined
    setState("dragging", false)
    if (id !== undefined && viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id)
  }
  const zoom = (value: number, x = 0, y = 0) => {
    if (!ready()) return
    release()
    const scale = Math.max(Math.min(0.05, ratio()), Math.min(16, value))
    setState({
      ...pan(x - ((x - state.x) * scale) / state.scale, y - ((y - state.y) * scale) / state.scale, scale),
      scale,
      fit: false,
    })
  }
  const rotate = (delta: number) => {
    release()
    const angle = (state.angle + delta + 360) % 360
    setState({ angle, scale: state.fit ? ratio(angle) : state.scale, x: 0, y: 0 })
  }
  const reset = (fit: boolean) => {
    release()
    setState({ fit, scale: fit ? ratio() : 1, x: 0, y: 0 })
  }
  const resize = () => {
    release()
    setState({ columns: viewport.clientWidth, rows: viewport.clientHeight })
    setState(state.fit ? { scale: ratio(), x: 0, y: 0 } : pan(state.x, state.y))
  }

  onMount(() => {
    const wheel = (event: WheelEvent) => {
      if (!ready()) return
      event.preventDefault()
      event.stopPropagation()
      const rect = viewport.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.rows : 1)
      zoom(
        state.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002),
        event.clientX - rect.left - state.columns / 2,
        event.clientY - rect.top - state.rows / 2,
      )
    }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    viewport.addEventListener("wheel", wheel, { passive: false })
    resize()
    onCleanup(() => {
      release()
      observer.disconnect()
      viewport.removeEventListener("wheel", wheel)
    })
  })

  createEffect(
    on(
      () => [props.src, props.auth, props.path, state.attempt] as const,
      ([src, auth, path]) => {
        const abort = new AbortController()
        let href = ""
        let phase: "load" | "decode" = "load"
        release()
        setState({
          url: "",
          loading: true,
          error: "",
          status: 0,
          pages: 1,
          width: 0,
          height: 0,
          scale: 1,
          angle: 0,
          x: 0,
          y: 0,
          fit: true,
        })
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
      class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-component="file-image"
      data-file-content
    >
      <Show when={ready()}>
        <div
          class="flex shrink-0 flex-wrap items-center justify-center gap-1 border-b border-border-weak-base px-2 py-1.5"
          role="group"
          aria-label={language.t("file.image.controls")}
        >
          <div class="flex items-center gap-1">
            <Button
              size="small"
              variant="ghost"
              title={language.t("file.image.zoomOut")}
              aria-label={language.t("file.image.zoomOut")}
              onClick={() => zoom(state.scale / 1.25)}
            >
              <span aria-hidden="true">−</span>
            </Button>
            <span class="min-w-12 text-center text-12-regular text-text-weak tabular-nums" data-image-scale>
              {Math.round(state.scale * 1000) / 10}%
            </span>
            <Button
              size="small"
              variant="ghost"
              title={language.t("file.image.zoomIn")}
              aria-label={language.t("file.image.zoomIn")}
              onClick={() => zoom(state.scale * 1.25)}
            >
              <span aria-hidden="true">+</span>
            </Button>
          </div>
          <div class="flex items-center gap-1">
            <Button
              size="small"
              variant="ghost"
              title={language.t("file.image.rotateLeft")}
              aria-label={language.t("file.image.rotateLeft")}
              onClick={() => rotate(-90)}
            >
              <span aria-hidden="true">↶</span>
            </Button>
            <Button
              size="small"
              variant="ghost"
              title={language.t("file.image.rotateRight")}
              aria-label={language.t("file.image.rotateRight")}
              onClick={() => rotate(90)}
            >
              <span aria-hidden="true">↷</span>
            </Button>
          </div>
          <div class="flex items-center gap-1">
            <Button
              size="small"
              variant="ghost"
              title={language.t("file.image.fit")}
              aria-label={language.t("file.image.fit")}
              aria-pressed={state.fit}
              onClick={() => reset(true)}
            >
              {language.t("file.image.fit")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              title={language.t("file.image.original")}
              aria-label={language.t("file.image.original")}
              aria-pressed={!state.fit && state.scale === 1}
              onClick={() => reset(false)}
            >
              1:1
            </Button>
          </div>
        </div>
      </Show>
      <div
        ref={viewport}
        class="relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-active"
        classList={{ "cursor-grab": ready() && !state.dragging, "cursor-grabbing": state.dragging }}
        style={{ "touch-action": "none" }}
        data-image-viewport
        tabIndex={ready() ? 0 : -1}
        role="region"
        aria-label={language.t("file.image.viewport")}
        onPointerDown={(event) => {
          if (!ready() || event.button !== 0 || drag) return
          event.preventDefault()
          viewport.focus({ preventScroll: true })
          drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: state.x, top: state.y }
          viewport.setPointerCapture(event.pointerId)
          setState("dragging", true)
        }}
        onPointerMove={(event) => {
          if (!drag || drag.id !== event.pointerId) return
          setState(pan(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y))
        }}
        onPointerUp={(event) => {
          if (drag?.id === event.pointerId) release()
        }}
        onPointerCancel={(event) => {
          if (drag?.id === event.pointerId) release()
        }}
        onLostPointerCapture={(event) => {
          if (drag?.id === event.pointerId) release()
        }}
        on:keydown={(event) => {
          if (!ready() || event.ctrlKey || event.metaKey || event.altKey) return
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault()
            event.stopPropagation()
            setState(
              pan(
                state.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0),
                state.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0),
              ),
            )
          }
          if (event.key === "+" || event.key === "=" || event.key === "-") {
            event.preventDefault()
            event.stopPropagation()
            zoom(state.scale * (event.key === "-" ? 0.8 : 1.25))
          }
          if (event.key === "0") {
            event.preventDefault()
            event.stopPropagation()
            reset(true)
          }
        }}
      >
        <Show when={state.url} keyed>
          {(src) => (
            <img
              src={src}
              alt={props.path}
              class="pointer-events-none absolute top-1/2 left-1/2 max-h-none max-w-none select-none"
              classList={{ invisible: state.loading || !!state.error }}
              style={{
                width: `${state.width}px`,
                height: `${state.height}px`,
                transform: `translate(-50%, -50%) translate(${state.x}px, ${state.y}px) rotate(${state.angle}deg) scale(${state.scale})`,
              }}
              draggable={false}
              onLoad={(event) => {
                if (state.url !== src) return
                setState({
                  loading: false,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
                setState({ scale: ratio(), x: 0, y: 0 })
              }}
              onError={() => {
                if (state.url === src) setState({ loading: false, error: "decode" })
              }}
            />
          )}
        </Show>
        <Show when={state.loading}>
          <div class="absolute inset-0 flex items-center justify-center text-13-regular text-text-weak" role="status">
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
          <div class="pointer-events-none absolute right-2 bottom-2 left-2 text-center text-12-regular text-text-weak">
            {language.t("file.image.firstPage", { count: state.pages })}
          </div>
        </Show>
      </div>
    </div>
  )
}
