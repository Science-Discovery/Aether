import { type Component, createMemo, onMount, createEffect } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { createStore } from "solid-js/store"
import { PdfViewer } from "./pdf-viewer"
import { PdfToolbar } from "./pdf-toolbar"
import { useReadingMode } from "@/context/reading-mode"
import { useSDK } from "@/context/sdk"

const DEFAULT_PDF_WIDTH = 0.55 // 55% default

type PanelStore = {
  pdfWidth: number // fraction 0..1
  dragging: boolean
}

export const ReadingModePanel: Component<{
  sessionID: string
  /** Right-side slot: the chat UI */
  children?: import("solid-js").JSX.Element
}> = (props) => {
  const rm = useReadingMode()
  const sdk = useSDK()

  const [panel, setPanel] = createStore<PanelStore>({
    pdfWidth: DEFAULT_PDF_WIDTH,
    dragging: false,
  })

  let containerRef: HTMLDivElement | undefined

  const pdfUrl = createMemo(() => {
    const base = sdk.url
    return `${base}/reading-mode/pdf?sessionID=${encodeURIComponent(props.sessionID)}`
  })

  const pdfPixelWidth = createMemo(() => {
    if (!containerRef) return 0
    return Math.floor(panel.pdfWidth * containerRef.clientWidth)
  })

  // Persist last page to backend on page change (debounced via effect)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  createEffect(() => {
    const page = rm.store.currentPage
    const sessionID = props.sessionID
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        const annotations = await sdk.client.readingMode.annotations.get({ sessionID })
        if (annotations.data) {
          const data = annotations.data as Record<string, unknown>
          await sdk.client.readingMode.annotations.update({
            sessionID,
            data: { ...data, lastReadPage: page },
          })
        }
      } catch {
        // non-critical, ignore
      }
    }, 1000)
  })

  // Restore last read page on mount
  onMount(async () => {
    try {
      const result = await sdk.client.readingMode.annotations.get({
        sessionID: props.sessionID,
      })
      const data = result.data as Record<string, unknown> | null | undefined
      if (data && typeof data.lastReadPage === "number") {
        rm.setPage(data.lastReadPage)
      }
    } catch {
      // ignore
    }
  })

  return (
    <div
      ref={containerRef}
      class="relative flex size-full overflow-hidden"
    >
      {/* PDF panel */}
      <div
        class="flex flex-col overflow-hidden border-r border-border-base"
        style={{ width: `${panel.pdfWidth * 100}%` }}
      >
        <PdfToolbar />
        <div class="flex-1 min-h-0">
          <PdfViewer url={pdfUrl()} />
        </div>
      </div>

      {/* Resize handle */}
      <div
        onPointerDown={() => setPanel("dragging", true)}
        onPointerUp={() => setPanel("dragging", false)}
      >
        <ResizeHandle
          direction="horizontal"
          size={pdfPixelWidth()}
          min={300}
          max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.75}
          onResize={(w) => {
            if (!containerRef) return
            setPanel("pdfWidth", w / containerRef.clientWidth)
          }}
        />
      </div>

      {/* Chat panel */}
      <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
        {props.children}
      </div>
    </div>
  )
}
