import { type Component, createEffect, createMemo, onCleanup } from "solid-js"
import "./pdf-viewer-shell.css"

type ViewerMode = "full" | "compact"

export type PdfViewerShellProps = {
  src: string
  authHeader?: string
  mode: ViewerMode
  class?: string
  page?: number
  onPageChange?: (page: number) => void
  onPdfToMarkdown?: () => void
}

type ViewerMessage =
  | { channel: "aether-pdf-viewer"; type: "ready" }
  | { channel: "aether-pdf-viewer"; type: "pagechange"; page: number }
  | { channel: "aether-pdf-viewer"; type: "pdf2md" }

export const PdfViewerShell: Component<PdfViewerShellProps> = (props) => {
  let iframeRef: HTMLIFrameElement | undefined
  let ready = false
  let lastReportedPage: number | undefined
  let lastConfigKey = ""

  const viewerSrc = createMemo(() => "/pdf-viewer.html")
  const config = createMemo(() => ({
    src: props.src,
    authHeader: props.authHeader,
    mode: props.mode,
    features: {
      pdf2md: !!props.onPdfToMarkdown && props.mode === "compact",
    },
  }))

  const post = (message: unknown) => {
    const frame = iframeRef?.contentWindow
    if (!frame) return
    frame.postMessage(message, window.location.origin)
  }

  const sendConfig = () => {
    const nextConfig = config()
    if (!nextConfig.src || !ready) return
    const key = JSON.stringify(nextConfig)
    if (key === lastConfigKey) return
    lastConfigKey = key
    post({
      channel: "aether-pdf-viewer",
      type: "config",
      config: nextConfig,
    })
  }

  createEffect(() => {
    void config()
    sendConfig()
  })

  createEffect(() => {
    const page = props.page
    if (!ready || page === undefined) return
    if (page === lastReportedPage) return
    post({
      channel: "aether-pdf-viewer",
      type: "navigate",
      page,
    })
  })

  const onMessage = (event: MessageEvent<ViewerMessage>) => {
    if (event.origin !== window.location.origin) return
    if (event.source !== iframeRef?.contentWindow) return
    if (event.data?.channel !== "aether-pdf-viewer") return

    if (event.data.type === "ready") {
      ready = true
      lastConfigKey = ""
      sendConfig()
      return
    }

    if (event.data.type === "pagechange") {
      lastReportedPage = event.data.page
      props.onPageChange?.(event.data.page)
      return
    }

    if (event.data.type === "pdf2md") {
      props.onPdfToMarkdown?.()
    }
  }

  window.addEventListener("message", onMessage)
  onCleanup(() => window.removeEventListener("message", onMessage))

  return (
    <div class={`pdf-viewer-shell ${props.class ?? ""}`}>
      <iframe
        ref={iframeRef}
        src={viewerSrc()}
        class="pdf-viewer-shell__frame"
        title="PDF Viewer"
        loading="eager"
      />
    </div>
  )
}
