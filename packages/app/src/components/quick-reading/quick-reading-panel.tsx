import type { Component } from "solid-js"
import { Show } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { PdfViewerShell } from "@/components/pdf-viewer-shell-official"
import { createSizing, type Sizing } from "@/pages/session/helpers"

export const QuickReadingPanel: Component<{
  url: string
  authHeader?: string
  width: number
  minWidth: number
  maxWidth: number
  page?: number
  layoutSwapped: boolean
  onPageChange?: (page: number) => void
  onDocumentInfo?: (info: { totalPages: number }) => void
  onTextSelectionAction?: (input: { action: "copy" | "translate" | "ask"; page: number; text: string }) => void
  onImageSelectionAction?: (input: { action: "copy" | "translate" | "ask"; page: number; imageDataUrl: string }) => void
  onSwapLayout?: () => void
  onResizeWidth?: (width: number) => void
  resizeHandleEnabled?: boolean
  sizing?: Sizing
  onExitQuickReading?: () => void
  onStartFirstRead?: () => void
  onOpenSettings?: () => void
}> = (props) => {
  const size = props.sizing ?? createSizing()

  return (
    <div class="relative h-full shrink-0 overflow-visible bg-surface-base" style={{ width: `${props.width}px` }}>
      <div
        class="flex h-full flex-col overflow-hidden bg-surface-base"
        classList={{
          "border-r border-border-base": !props.layoutSwapped,
          "border-l border-border-base": props.layoutSwapped,
        }}
      >
        <div class="min-h-0 flex-1">
          <PdfViewerShell
            src={props.url}
            authHeader={props.authHeader}
            mode="full"
            class="size-full"
            page={props.page}
            layoutSwapped={props.layoutSwapped}
            onPageChange={props.onPageChange}
            onDocumentInfo={props.onDocumentInfo}
            onTextSelectionAction={props.onTextSelectionAction}
            onImageSelectionAction={props.onImageSelectionAction}
            onSwapLayout={props.onSwapLayout}
            onExitQuickReading={props.onExitQuickReading}
            onStartFirstRead={props.onStartFirstRead}
            onOpenSettings={props.onOpenSettings}
          />
        </div>
      </div>

      <Show when={props.resizeHandleEnabled !== false && !!props.onResizeWidth}>
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
              props.onResizeWidth?.(width)
            }}
          />
        </div>
      </Show>
    </div>
  )
}
