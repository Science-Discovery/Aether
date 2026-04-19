import { type Component, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import "./pdf-viewer-shell.css"

type ViewerMode = "full" | "compact"
const NIGHT_MODE_KEY = "aether-pdf-night-mode"
const nightModeSubscribers = new Set<(value: boolean) => void>()
let sharedNightMode = readNightMode()
let syncBound = false

function readNightMode() {
  if (typeof window === "undefined") return false
  try {
    return localStorage.getItem(NIGHT_MODE_KEY) === "1"
  } catch {
    return false
  }
}

function notifyNightMode() {
  for (const subscriber of nightModeSubscribers) {
    subscriber(sharedNightMode)
  }
}

function bindNightModeSync() {
  if (syncBound || typeof window === "undefined") return
  syncBound = true
  window.addEventListener("storage", (event) => {
    if (event.key !== NIGHT_MODE_KEY) return
    sharedNightMode = event.newValue === "1"
    notifyNightMode()
  })
}

function setSharedNightMode(next: boolean) {
  if (sharedNightMode === next) return
  sharedNightMode = next
  try {
    localStorage.setItem(NIGHT_MODE_KEY, next ? "1" : "0")
  } catch {}
  notifyNightMode()
}

function isFileProtocol() {
  return typeof window !== "undefined" && window.location.protocol === "file:"
}

function viewerMessageTargetOrigin() {
  // Chromium treats file:// documents as opaque origins for postMessage.
  // Use "*" and validate the message source explicitly on receipt.
  return isFileProtocol() ? "*" : window.location.origin
}

export type PdfViewerShellProps = {
  src: string
  authHeader?: string
  mode: ViewerMode
  class?: string
  page?: number
  layoutSwapped?: boolean
  onPageChange?: (page: number) => void
  onDocumentInfo?: (info: { totalPages: number }) => void
  onPdfToMarkdown?: () => void
  onOpenReadingMode?: () => void
  onExitQuickReading?: () => void
  onStartFirstRead?: () => void
  onOpenSettings?: () => void
  onTextSelectionAction?: (input: { action: "copy" | "translate" | "ask"; page: number; text: string }) => void
  onImageSelectionAction?: (input: { action: "copy" | "translate" | "ask"; page: number; imageDataUrl: string }) => void
  onSwapLayout?: () => void
}

type ViewerMessage =
  | { channel: "aether-pdf-viewer"; type: "ready" }
  | { channel: "aether-pdf-viewer"; type: "pagechange"; page: number }
  | { channel: "aether-pdf-viewer"; type: "documentinfo"; totalPages: number }
  | { channel: "aether-pdf-viewer"; type: "pdf2md" }
  | { channel: "aether-pdf-viewer"; type: "openreadingmode" }
  | { channel: "aether-pdf-viewer"; type: "exitquickreading" }
  | { channel: "aether-pdf-viewer"; type: "startfirstread" }
  | { channel: "aether-pdf-viewer"; type: "opensettings" }
  | { channel: "aether-pdf-viewer"; type: "textselectionaction"; action: "copy" | "translate" | "ask"; page: number; text: string }
  | {
      channel: "aether-pdf-viewer"
      type: "imageselectionaction"
      action: "copy" | "translate" | "ask"
      page: number
      imageDataUrl: string
    }
  | { channel: "aether-pdf-viewer"; type: "nightmode"; enabled: boolean }
  | { channel: "aether-pdf-viewer"; type: "swaplayout" }

export const PdfViewerShell: Component<PdfViewerShellProps> = (props) => {
  bindNightModeSync()
  let iframeRef: HTMLIFrameElement | undefined
  let lastReportedPage: number | undefined
  let lastConfigKey = ""
  const [ready, setReady] = createSignal(false)
  const [nightMode, setNightMode] = createSignal(sharedNightMode)

  const viewerSrc = createMemo(() => {
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      return "./pdf-viewer.html"
    }
    return "/pdf-viewer.html"
  })
  const config = createMemo(() => ({
    src: props.src,
    authHeader: props.authHeader,
    mode: props.mode,
    page: props.page,
    nightMode: nightMode(),
    layoutSwapped: !!props.layoutSwapped,
      features: {
        pdf2md: !!props.onPdfToMarkdown && props.mode === "compact",
        readingMode: !!props.onOpenReadingMode && props.mode === "compact",
        quickReadingExit: !!props.onExitQuickReading && props.mode === "full",
        firstRead: !!props.onStartFirstRead && props.mode === "full",
        settings: !!props.onOpenSettings && props.mode === "full",
        textSelectionActions: !!props.onTextSelectionAction && props.mode === "full",
        imageSelectionActions: !!props.onImageSelectionAction && props.mode === "full",
      },
    }))

  const post = (message: unknown) => {
    const frame = iframeRef?.contentWindow
    if (!frame) return
    frame.postMessage(message, viewerMessageTargetOrigin())
  }

  const sendConfig = () => {
    const nextConfig = config()
    if (!nextConfig.src || !ready()) return
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
    if (!ready() || page === undefined) return
    if (page === lastReportedPage) return
    post({
      channel: "aether-pdf-viewer",
      type: "navigate",
      page,
    })
  })

  nightModeSubscribers.add(setNightMode)
  onCleanup(() => nightModeSubscribers.delete(setNightMode))

  const onMessage = (event: MessageEvent<ViewerMessage>) => {
    if (event.source !== iframeRef?.contentWindow) return
    if (event.data?.channel !== "aether-pdf-viewer") return
    if (!isFileProtocol() && event.origin !== window.location.origin) return

    if (event.data.type === "ready") {
      setReady(true)
      lastConfigKey = ""
      sendConfig()
      return
    }

    if (event.data.type === "pagechange") {
      lastReportedPage = event.data.page
      props.onPageChange?.(event.data.page)
      return
    }

    if (event.data.type === "documentinfo") {
      props.onDocumentInfo?.({ totalPages: event.data.totalPages })
      return
    }

    if (event.data.type === "pdf2md") {
      props.onPdfToMarkdown?.()
      return
    }

    if (event.data.type === "openreadingmode") {
      props.onOpenReadingMode?.()
      return
    }

    if (event.data.type === "exitquickreading") {
      props.onExitQuickReading?.()
      return
    }

    if (event.data.type === "startfirstread") {
      props.onStartFirstRead?.()
      return
    }

    if (event.data.type === "opensettings") {
      props.onOpenSettings?.()
      return
    }

    if (event.data.type === "textselectionaction") {
      props.onTextSelectionAction?.({
        action: event.data.action,
        page: event.data.page,
        text: event.data.text,
      })
      return
    }

    if (event.data.type === "imageselectionaction") {
      props.onImageSelectionAction?.({
        action: event.data.action,
        page: event.data.page,
        imageDataUrl: event.data.imageDataUrl,
      })
      return
    }

    if (event.data.type === "nightmode") {
      setSharedNightMode(!!event.data.enabled)
      return
    }

    if (event.data.type === "swaplayout") {
      props.onSwapLayout?.()
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
        onLoad={() => {
          setReady(false)
          lastReportedPage = undefined
        }}
      />
    </div>
  )
}
