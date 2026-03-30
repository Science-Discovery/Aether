import { type Component, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { createStore } from "solid-js/store"
import { OfficialReadingPdfViewer } from "./reading-pdf-viewer-official"
import { useReadingMode } from "@/context/reading-mode"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createSizing } from "@/pages/session/helpers"

const DEFAULT_PDF_WIDTH = 0.55

type PanelStore = {
  pdfWidth: number
}

export const ReadingModePanel: Component<{
  sessionID: string
  children?: import("solid-js").JSX.Element
}> = (props) => {
  const rm = useReadingMode()
  const sdk = useSDK()
  const sync = useSync()
  const size = createSizing()
  const [containerWidth, setContainerWidth] = createSignal(0)
  const [restoredInitialPage, setRestoredInitialPage] = createSignal(false)

  const [panel, setPanel] = createStore<PanelStore>({
    pdfWidth: DEFAULT_PDF_WIDTH,
  })

  let containerRef: HTMLDivElement | undefined

  const pdfUrl = createMemo(() => `${sdk.url}/reading-mode/pdf?sessionID=${encodeURIComponent(props.sessionID)}`)

  const pdfPixelWidth = createMemo(() => {
    const width = containerWidth()
    if (width <= 0) return 0
    return Math.floor(panel.pdfWidth * width)
  })

  const maxPdfWidth = createMemo(() => {
    const width = containerWidth()
    if (width <= 0) return 1000
    return Math.max(360, Math.floor(width * 0.8))
  })

  createEffect(() => {
    const info = sync.session.get(props.sessionID)
    const meta = info?.readingMode
    if (!meta) return
    rm.setSessionMeta(meta)
    if (!restoredInitialPage() && meta.lastReadPage > 1) {
      rm.setPage(meta.lastReadPage)
      setRestoredInitialPage(true)
    }
  })

  onMount(() => {
    const syncWidth = () => {
      if (!containerRef) return
      setContainerWidth(containerRef.clientWidth)
    }

    syncWidth()
    const observer = new ResizeObserver(syncWidth)
    if (containerRef) observer.observe(containerRef)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div ref={containerRef} class="relative flex size-full overflow-hidden">
      <div
        class="relative shrink-0 overflow-visible"
        style={{ width: containerWidth() > 0 ? `${pdfPixelWidth()}px` : `${panel.pdfWidth * 100}%` }}
      >
        <div class="flex h-full flex-col overflow-hidden border-r border-border-base bg-surface-base">
          <div class="min-h-0 flex-1">
            <OfficialReadingPdfViewer url={pdfUrl()} />
          </div>
        </div>

        <div class="absolute inset-y-0 right-0 z-10 w-0 overflow-visible" onPointerDown={() => size.start()}>
          <div class="pointer-events-none absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-border-base/80" />
          <ResizeHandle
            direction="horizontal"
            class="after:bg-border-base/90"
            size={pdfPixelWidth()}
            min={360}
            max={maxPdfWidth()}
            onResize={(width) => {
              const totalWidth = containerWidth()
              if (totalWidth <= 0) return
              size.touch()
              setPanel("pdfWidth", Math.min(0.85, Math.max(0.25, width / totalWidth)))
            }}
          />
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">{props.children}</div>
    </div>
  )
}
