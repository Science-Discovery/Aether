import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createMemo, createSignal } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface ImagePreviewProps {
  src: string
  alt?: string
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
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

  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <div data-slot="image-preview-tools">
              <IconButton
                icon="dash"
                variant="ghost"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() => change(-step)}
                disabled={zoom() <= min}
              />
              <button type="button" data-slot="image-preview-reset" onClick={reset} aria-label="Reset zoom" title="Reset zoom">
                {pct()}
              </button>
              <IconButton
                icon="plus"
                variant="ghost"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() => change(step)}
                disabled={zoom() >= max}
              />
            </div>
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body" onWheel={wheel}>
            <img
              src={props.src}
              alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
              data-slot="image-preview-image"
              style={{ transform: `translate(${x()}px, ${y()}px) scale(${zoom()})`, cursor: cursor() }}
              onDblClick={reset}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
