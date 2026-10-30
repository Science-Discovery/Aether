import type { Reference } from "@/utils/ask-reference"
import type { PdfTextSelection, PdfImageSelection } from "@/components/pdf-viewer-shell-official"
import { type Component, createMemo } from "solid-js"
import { PdfViewerShell } from "@/components/pdf-viewer-shell-official"
import { useReadingMode } from "@/context/reading-mode"
import { useServer } from "@/context/server"

export const OfficialReadingPdfViewer: Component<{
  url: string
  askScope: string
  askPath?: string
  references: readonly Reference[]
  onReferenceEdit: (id: string, question: string) => void
  layoutSwapped?: boolean
  onSwapLayout?: () => void
  onOpenSettings?: () => void
  onTextSelectionAction?: (input: PdfTextSelection) => void
  onImageSelectionAction?: (input: PdfImageSelection) => void
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
      askScope={props.askScope}
      askPath={props.askPath}
      references={props.references}
      onReferenceEdit={props.onReferenceEdit}
      authHeader={authHeader()}
      mode="full"
      page={rm.store.currentPage}
      layoutSwapped={props.layoutSwapped}
      onPageChange={(page) => rm.setPage(page)}
      onDocumentInfo={({ totalPages }) => rm.setTotalPages(totalPages)}
      onOpenSettings={props.onOpenSettings}
      onTextSelectionAction={props.onTextSelectionAction}
      onImageSelectionAction={props.onImageSelectionAction}
      onSwapLayout={props.onSwapLayout}
      class="size-full"
    />
  )
}
