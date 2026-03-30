import type { Component } from "solid-js"

export type PdfViewerShellProps = {
  src: string
  authHeader?: string
  mode: "full" | "compact"
  class?: string
  page?: number
  onPageChange?: (page: number) => void
  onPdfToMarkdown?: () => void
}

export const PdfViewerShell: Component<PdfViewerShellProps> = () => {
  throw new Error("Deprecated: use @/components/pdf-viewer-shell-official instead.")
}
