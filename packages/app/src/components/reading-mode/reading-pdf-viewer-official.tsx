import { type Component, createMemo } from "solid-js"
import { PdfViewerShell } from "@/components/pdf-viewer-shell-official"
import { useReadingMode } from "@/context/reading-mode"
import { useServer } from "@/context/server"

export const OfficialReadingPdfViewer: Component<{
  url: string
  layoutSwapped?: boolean
  onSwapLayout?: () => void
  onCloseReadingMode?: () => void
  onOpenSettings?: () => void
  onTextSelectionAction?: (input: { action: "copy" | "translate" | "ask"; page: number; text: string }) => void
  onImageSelectionAction?: (input: { action: "copy" | "translate" | "ask"; page: number; imageDataUrl: string }) => void
}> = (props) => {
  const rm = useReadingMode()
  const server = useServer()

  const authHeader = createMemo(() => {
    const current = server.current
    const http = current?.http
    if (!http?.password) return undefined
    return `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
  })

  return (
    <PdfViewerShell
      src={props.url}
      authHeader={authHeader()}
      mode="full"
      page={rm.store.currentPage}
      layoutSwapped={props.layoutSwapped}
      onPageChange={(page) => rm.setPage(page)}
      onDocumentInfo={({ totalPages }) => rm.setTotalPages(totalPages)}
      onCloseReadingMode={props.onCloseReadingMode}
      onOpenSettings={props.onOpenSettings}
      onTextSelectionAction={props.onTextSelectionAction}
      onImageSelectionAction={props.onImageSelectionAction}
      onSwapLayout={props.onSwapLayout}
      class="size-full"
    />
  )
}
