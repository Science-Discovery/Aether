import type { FileContent } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, Match, on, Show, Switch, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"
import {
  dataUrlFromMediaValue,
  hasMediaValue,
  isBinaryContent,
  mediaKindFromPath,
  normalizeMimeType,
  svgTextFromValue,
} from "../pierre/media"

export type FileMediaOptions = {
  mode?: "auto" | "off"
  path?: string
  current?: unknown
  before?: unknown
  after?: unknown
  readFile?: (path: string) => Promise<FileContent | undefined>
  onLoad?: () => void
  onError?: (ctx: { kind: "image" | "audio" | "svg" }) => void
  /** 额外的操作按钮，渲染在文件名和"在浏览器中打开"之间 */
  actions?: () => JSX.Element
}

function mediaValue(cfg: FileMediaOptions, mode: "image" | "audio") {
  if (cfg.current !== undefined) return cfg.current
  if (mode === "image") return cfg.after ?? cfg.before
  return cfg.after ?? cfg.before
}

export function FileMedia(props: { media?: FileMediaOptions; fallback: () => JSX.Element }) {
  const i18n = useI18n()
  const cfg = () => props.media
  const [zoom, setZoom] = createSignal(1)
  const [drag, setDrag] = createSignal(false)
  const [x, setX] = createSignal(0)
  const [y, setY] = createSignal(0)
  const min = 0.25
  const max = 8
  const step = 0.1
  const clamp = (x: number) => Math.min(max, Math.max(min, x))
  const change = (x: number) => setZoom((z) => clamp(Number((z + x).toFixed(2))))
  const reset = () => {
    setZoom(1)
    setX(0)
    setY(0)
  }
  const pct = createMemo(() => `${Math.round(zoom() * 100)}%`)
  const cursor = createMemo(() => {
    if (zoom() <= 1) return "default"
    if (drag()) return "grabbing"
    return "grab"
  })
  const wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    change(e.deltaY < 0 ? step : -step)
  }
  let pid: number | undefined
  let sx = 0
  let sy = 0
  let ox = 0
  let oy = 0
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    if (zoom() <= 1) return
    pid = e.pointerId
    sx = e.clientX
    sy = e.clientY
    ox = x()
    oy = y()
    setDrag(true)
    const el = e.currentTarget as HTMLElement | null
    if (!el) return
    el.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const move = (e: PointerEvent) => {
    if (!drag()) return
    if (pid !== e.pointerId) return
    setX(ox + e.clientX - sx)
    setY(oy + e.clientY - sy)
  }
  const up = (e: PointerEvent) => {
    if (pid !== e.pointerId) return
    pid = undefined
    setDrag(false)
    const el = e.currentTarget as HTMLElement | null
    if (!el) return
    if (!el.hasPointerCapture(e.pointerId)) return
    el.releasePointerCapture(e.pointerId)
  }
  const kind = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return
    return mediaKindFromPath(media.path)
  })

  const isBinary = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return false
    if (kind()) return false
    return isBinaryContent(media.current as any)
  })

  const onLoad = () => props.media?.onLoad?.()

  const deleted = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || !k) return false
    if (k === "svg") return false
    if (media.current !== undefined) return false
    return !hasMediaValue(media.after as any) && hasMediaValue(media.before as any)
  })

  const direct = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    return dataUrlFromMediaValue(mediaValue(media, k), k)
  })

  const request = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    if (media.current !== undefined) return
    if (deleted()) return
    if (direct()) return
    if (!media.path || !media.readFile) return

    return `${k}:${media.path}`
  })

  const [loaded, setLoaded] = createSignal<
    { key: string; src: string; mime: string | undefined } | { key: string; error: true } | undefined
  >()
  const [loading, setLoading] = createSignal(false)
  let seq = 0

  const load = async (key: string) => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio") || !media.path || !media.readFile) {
      return { key, error: true as const }
    }

    return media.readFile(media.path).then(
      (result) => {
        const src = dataUrlFromMediaValue(result as any, k)
        if (!src) {
          media.onError?.({ kind: k })
          return { key, error: true as const }
        }

        return {
          key,
          src,
          mime: k === "audio" ? normalizeMimeType(result?.mimeType) : undefined,
        }
      },
      () => {
        media.onError?.({ kind: k })
        return { key, error: true as const }
      },
    )
  }

  createEffect(
    on(request, (key) => {
      seq++
      const id = seq
      if (!key) {
        setLoaded(undefined)
        setLoading(false)
        return
      }

      setLoading(true)

      void load(key).then((value) => {
        if (id !== seq) return
        setLoaded(value)
        setLoading(false)
      })
    }),
  )

  const remote = createMemo(() => {
    const input = request()
    const value = loaded()
    if (!input || !value || value.key !== input) return
    return value
  })

  const src = createMemo(() => {
    const value = remote()
    return direct() ?? (value && "src" in value ? value.src : undefined)
  })

  createEffect(
    on([src, kind], () => {
      reset()
    }),
  )

  const status = createMemo(() => {
    if (direct()) return "ready" as const
    if (!request()) return "idle" as const
    if (loading()) return "loading" as const
    const value = remote()
    if (value && "error" in value) return "error" as const
    if (src()) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo(() => {
    const value = remote()
    return value && "mime" in value ? value.mime : undefined
  })

  const svgSource = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return svgTextFromValue(media.current as any)
  })
  const svgSrc = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    return dataUrlFromMediaValue(media.current as any, "svg")
  })
  const svgInvalid = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    if (svgSource() !== undefined) return
    if (!hasMediaValue(media.current as any)) return
    return [media.path, media.current] as const
  })

  createEffect(
    on(
      svgInvalid,
      (value) => {
        if (!value) return
        cfg()?.onError?.({ kind: "svg" })
      },
      { defer: true },
    ),
  )

  let pdfObjectUrl: string | null = null

  const cleanupPdfUrl = () => {
    if (pdfObjectUrl) {
      URL.revokeObjectURL(pdfObjectUrl)
      pdfObjectUrl = null
    }
  }

  createEffect(() => {
    return () => {
      cleanupPdfUrl()
    }
  })

  const kindLabel = (value: "image" | "audio") =>
    i18n.t(value === "image" ? "ui.fileMedia.kind.image" : "ui.fileMedia.kind.audio")

  return (
    <Switch>
      <Match when={kind() === "image" || kind() === "audio"}>
        <Show
          when={src()}
          fallback={(() => {
            const media = cfg()
            const k = kind()
            if (!media || (k !== "image" && k !== "audio")) return props.fallback()
            const label = kindLabel(k)

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(value) => {
            const k = kind()
            if (k !== "image" && k !== "audio") return props.fallback()
            if (k === "image") {
              return (
                <div class="flex flex-col gap-2 bg-background-stronger px-6 py-4">
                  <div class="flex items-center justify-end gap-1">
                    <IconButton
                      icon="dash"
                      variant="ghost"
                      size="small"
                      aria-label="Zoom out"
                      title="Zoom out"
                      onClick={() => change(-step)}
                      disabled={zoom() <= min}
                    />
                    <button
                      type="button"
                      class="rounded px-2 py-1 text-12-medium text-text-secondary hover:bg-surface-raised-base-hover hover:text-text-primary"
                      onClick={reset}
                      aria-label="Reset zoom"
                      title="Reset zoom"
                    >
                      {pct()}
                    </button>
                    <IconButton
                      icon="plus"
                      variant="ghost"
                      size="small"
                      aria-label="Zoom in"
                      title="Zoom in"
                      onClick={() => change(step)}
                      disabled={zoom() >= max}
                    />
                  </div>
                  <div class="flex justify-center overflow-auto" onWheel={wheel}>
                    <img
                      src={value()}
                      alt={cfg()?.path}
                      class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain transition-transform"
                      style={{
                        transform: `translate(${x()}px, ${y()}px) scale(${zoom()})`,
                        "transform-origin": "center center",
                        cursor: cursor(),
                      }}
                      onLoad={onLoad}
                      onDblClick={reset}
                      onPointerDown={down}
                      onPointerMove={move}
                      onPointerUp={up}
                      onPointerCancel={up}
                    />
                  </div>
                </div>
              )
            }

            return (
              <div class="flex justify-center bg-background-stronger px-6 py-4">
                <audio class="w-full max-w-xl" controls preload="metadata" onLoadedMetadata={onLoad}>
                  <source src={value()} type={audioMime()} />
                </audio>
              </div>
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "svg"}>
        {(() => {
          if (svgSource() === undefined && svgSrc() == null) return props.fallback()

          return (
            <div class="flex flex-col gap-4 px-6 py-4">
              <Show when={svgSource() !== undefined}>{props.fallback()}</Show>
              <Show when={svgSrc()}>
                {(value) => (
                  <div class="flex justify-center">
                    <img
                      src={value()}
                      alt={cfg()?.path}
                      class="max-h-[60vh] max-w-full rounded border border-border-weak-base bg-background-base object-contain"
                      onLoad={onLoad}
                    />
                  </div>
                )}
              </Show>
            </div>
          )
        })()}
      </Match>
      <Match when={kind() === "pdf"}>
        {(() => {
          const dataUrl = dataUrlFromMediaValue(cfg()?.current, "pdf")
          const filename = cfg()?.path?.split("/").pop() ?? "document.pdf"
          if (dataUrl) {
            cleanupPdfUrl()

            const base64 = dataUrl.split(",")[1]
            if (base64) {
              const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
              const blob = new Blob([bytes], { type: "application/pdf" })
              pdfObjectUrl = URL.createObjectURL(blob)
            }

            return (
              <div class="flex flex-col gap-4 px-6 pb-4 h-full">
                <div class="flex items-center justify-between">
                  <div class="text-14-semibold text-text-strong">{filename}</div>
                  <div class="flex items-center gap-2">
                    {cfg()?.actions?.()}
                    <button
                      type="button"
                      class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover hover:border-border-strong-base transition-colors cursor-pointer"
                      onClick={() => {
                        if (pdfObjectUrl) {
                          window.open(pdfObjectUrl)
                        }
                      }}
                    >
                      {i18n.t("ui.fileMedia.pdf.open")}
                    </button>
                  </div>
                </div>
                <div class="flex flex-1 justify-center bg-background-stronger">
                  <embed
                    src={pdfObjectUrl || ""}
                    title={filename}
                    class="w-full max-w-full border border-border-weak-base rounded h-[80vh]"
                    onLoad={onLoad}
                  />
                </div>
              </div>
            )
          }
          return (
            <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <div class="text-14-semibold text-text-strong">{filename}</div>
              <div class="text-14-regular text-text-weak">{i18n.t("ui.fileMedia.state.loading", { kind: "PDF" })}</div>
            </div>
          )
        })()}
      </Match>
      <Match when={isBinary()}>
        <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-14-semibold text-text-strong">
            {cfg()?.path?.split("/").pop() ?? i18n.t("ui.fileMedia.binary.title")}
          </div>
          <div class="text-14-regular text-text-weak">
            {(() => {
              const path = cfg()?.path
              if (!path) return i18n.t("ui.fileMedia.binary.description.default")
              return i18n.t("ui.fileMedia.binary.description.path", { path })
            })()}
          </div>
        </div>
      </Match>
      <Match when={true}>{props.fallback()}</Match>
    </Switch>
  )
}
