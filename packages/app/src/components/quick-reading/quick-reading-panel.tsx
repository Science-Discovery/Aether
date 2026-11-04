import type { Component, JSX } from "solid-js"
import { Show } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { PdfViewerShell, type PdfViewerShellProps } from "@/components/pdf-viewer-shell-official"
import { createRealtime } from "@/components/latex-realtime"
import { useLanguage } from "@/context/language"
import { useLatex } from "@/context/latex"
import { createSizing, type Sizing } from "@/pages/session/helpers"

export const QuickReadingPanel: Component<{
  url: string
  authHeader?: string
  annotationPath?: string
  annotationBuild?: string
  document?: string
  version?: string
  onVersionChange?: (version: string) => void
  reveal?: PdfViewerShellProps["reveal"]
  onSourceLocate?: PdfViewerShellProps["onSourceLocate"]
  onLocateUnavailable?: PdfViewerShellProps["onLocateUnavailable"]
  onBusyChange?: PdfViewerShellProps["onBusyChange"]
  header?: JSX.Element
  width: number
  minWidth: number
  maxWidth: number
  page?: number
  location?: string
  layoutSwapped: boolean
  onPageChange?: (page: number) => void
  onLocationChange?: (location: string) => void
  onDocumentInfo?: (info: { totalPages: number }) => void
  onTextSelectionAction?: PdfViewerShellProps["onTextSelectionAction"]
  onImageSelectionAction?: PdfViewerShellProps["onImageSelectionAction"]
  onSwapLayout?: () => void
  onExitQuickReading?: () => void
  onStartFirstRead?: () => void
  onOpenSettings?: () => void
  onResizeWidth?: (width: number) => void
  resizeHandleEnabled?: boolean
  sizing?: Sizing
  realtime?: boolean
}> = (props) => {
  const size = props.sizing ?? createSizing()
  const latex = useLatex()
  const language = useLanguage()
  const live = () => props.realtime === true && latex.state.realtime && latex.state.program === "lualatex"
  const realtime = createRealtime(live)
  const src = () => (live() ? (realtime.src() ?? props.url) : props.url)
  const note = () => {
    if (realtime.error()) return realtime.error()
    const status = realtime.status()
    return status === language.t("latex.realtime.live") ? "" : status
  }

  return (
    <div class="relative h-full shrink-0 overflow-visible bg-surface-base" style={{ width: `${props.width}px` }}>
      <div
        class="flex h-full flex-col overflow-hidden bg-surface-base"
        classList={{
          "border-r border-border-base": !props.layoutSwapped,
          "border-l border-border-base": props.layoutSwapped,
        }}
      >
        {props.header}
        <div class="relative min-h-0 flex-1">
          <Show when={live() && note()}>
            <div
              class="pointer-events-none absolute left-2 top-2 z-10 max-w-[80%] truncate rounded border border-border-weaker-base bg-surface-base px-2 py-1 text-12-regular shadow-sm"
              classList={{
                "text-text-danger": !!realtime.error(),
                "text-text-weak": !realtime.error(),
              }}
              role="status"
              aria-live="polite"
              data-component="latex-realtime-status"
              title={note()}
            >
              {note()}
            </div>
          </Show>
          <Show when={src()}>
            <PdfViewerShell
              src={src()}
              annotationPath={live() ? undefined : props.annotationPath}
              annotationBuild={live() ? undefined : props.annotationBuild}
              document={props.document}
              version={props.version}
              onVersionChange={props.onVersionChange}
              reveal={live() ? undefined : props.reveal}
              onSourceLocate={live() ? undefined : props.onSourceLocate}
              onLocateUnavailable={live() ? undefined : props.onLocateUnavailable}
              onBusyChange={props.onBusyChange}
              authHeader={props.authHeader}
              mode="full"
              class="size-full"
              realtime={live()}
              page={props.page}
              location={props.location}
              layoutSwapped={props.layoutSwapped}
              onPageChange={props.onPageChange}
              onLocationChange={props.onLocationChange}
              onDocumentInfo={props.onDocumentInfo}
              onTextSelectionAction={props.onTextSelectionAction}
              onImageSelectionAction={props.onImageSelectionAction}
              onExitQuickReading={props.onExitQuickReading}
              onStartFirstRead={props.onStartFirstRead}
              onSwapLayout={props.onSwapLayout}
              onOpenSettings={props.onOpenSettings}
              onPost={realtime.attach}
              onRealtimeRequest={realtime.request}
            />
          </Show>
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
