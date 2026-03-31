import { type Component, createEffect, createMemo } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { OfficialReadingPdfViewer } from "./reading-pdf-viewer-official"
import { useReadingMode } from "@/context/reading-mode"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { createSizing } from "@/pages/session/helpers"

export const ReadingModePanel: Component<{
  sessionID: string
  width: number
  minWidth: number
  maxWidth: number
  layoutSwapped: boolean
  onSwapLayout?: () => void
  onResizeWidth: (width: number) => void
}> = (props) => {
  const rm = useReadingMode()
  const sdk = useSDK()
  const sync = useSync()
  const size = createSizing()

  const pdfUrl = createMemo(() => `${sdk.url}/reading-mode/pdf?sessionID=${encodeURIComponent(props.sessionID)}`)
  let restoredInitialPage = false

  createEffect(() => {
    const info = sync.session.get(props.sessionID)
    const meta = info?.readingMode
    if (!meta) return
    rm.setSessionMeta(meta)
    if (!restoredInitialPage && meta.lastReadPage > 1) {
      rm.setPage(meta.lastReadPage)
      restoredInitialPage = true
    }
  })

  return (
    <div class="relative h-full shrink-0 overflow-visible" style={{ width: `${props.width}px` }}>
      <div
        class="flex h-full flex-col overflow-hidden bg-surface-base"
        classList={{
          "border-r border-border-base": !props.layoutSwapped,
          "border-l border-border-base": props.layoutSwapped,
        }}
      >
        <div class="min-h-0 flex-1">
          <OfficialReadingPdfViewer url={pdfUrl()} layoutSwapped={props.layoutSwapped} onSwapLayout={props.onSwapLayout} />
        </div>
      </div>

      <div
        class="absolute inset-y-0 z-10 w-0 overflow-visible"
        classList={{
          "left-0": props.layoutSwapped,
          "right-0": !props.layoutSwapped,
        }}
        onPointerDown={() => size.start()}
      >
        <div
          class="pointer-events-none absolute inset-y-0 w-px bg-border-base/80"
          classList={{
            "left-0 -translate-x-1/2": !props.layoutSwapped,
            "right-0 translate-x-1/2": props.layoutSwapped,
          }}
        />
        <ResizeHandle
          direction="horizontal"
          edge={props.layoutSwapped ? "start" : "end"}
          class="after:bg-border-base/90"
          size={props.width}
          min={props.minWidth}
          max={props.maxWidth}
          onResize={(width) => {
            size.touch()
            props.onResizeWidth(width)
          }}
        />
      </div>
    </div>
  )
}
