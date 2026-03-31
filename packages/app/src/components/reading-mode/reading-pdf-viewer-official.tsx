import { type Component, createMemo } from "solid-js"
import { PdfViewerShell } from "@/components/pdf-viewer-shell-official"
import { useReadingMode } from "@/context/reading-mode"
import { useServer } from "@/context/server"

export const OfficialReadingPdfViewer: Component<{
  url: string
  layoutSwapped?: boolean
  onSwapLayout?: () => void
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
      onSwapLayout={props.onSwapLayout}
      class="size-full"
    />
  )
}
