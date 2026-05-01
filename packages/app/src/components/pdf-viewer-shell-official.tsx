import { type Component, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { href } from "@/base-path"
import "./pdf-viewer-shell.css"

type ViewerMode = "full" | "compact"
export type PdfViewTheme = "day" | "night" | "eye"

const VIEW_THEME_KEY = "aether-pdf-theme"
const LEGACY_NIGHT_MODE_KEY = "aether-pdf-night-mode"
const viewThemeSubscribers = new Set<(value: PdfViewTheme) => void>()
let sharedViewTheme = readViewTheme()
let syncBound = false

function readViewTheme(): PdfViewTheme {
  if (typeof window === "undefined") return "day"
  try {
    const value = localStorage.getItem(VIEW_THEME_KEY)
    if (value === "day" || value === "night" || value === "eye") return value
    return localStorage.getItem(LEGACY_NIGHT_MODE_KEY) === "1" ? "night" : "day"
  } catch {
    return "day"
  }
}

function notifyViewTheme() {
  for (const subscriber of viewThemeSubscribers) {
    subscriber(sharedViewTheme)
  }
}

function bindViewThemeSync() {
  if (syncBound || typeof window === "undefined") return
  syncBound = true
  window.addEventListener("storage", (event) => {
    if (event.key !== VIEW_THEME_KEY && event.key !== LEGACY_NIGHT_MODE_KEY) return
    sharedViewTheme = readViewTheme()
    notifyViewTheme()
  })
}

function setSharedViewTheme(next: PdfViewTheme) {
  if (sharedViewTheme === next) return
  sharedViewTheme = next
  try {
    localStorage.setItem(VIEW_THEME_KEY, next)
    localStorage.removeItem(LEGACY_NIGHT_MODE_KEY)
  } catch {}
  notifyViewTheme()
}

function isFileProtocol() {
  return typeof window !== "undefined" && window.location.protocol === "file:"
}

function viewerMessageTargetOrigin() {
  return isFileProtocol() ? "*" : window.location.origin
}

export type PdfViewerShellProps = {
  src: string
  authHeader?: string
  mode: ViewerMode
  class?: string
  viewTheme?: PdfViewTheme
  page?: number
  location?: string
  layoutSwapped?: boolean
  onPageChange?: (page: number) => void
  onLocationChange?: (location: string) => void
  onDocumentInfo?: (info: { totalPages: number }) => void
  onPdfToMarkdown?: () => void
  onOpenReadingMode?: () => void
  onExitQuickReading?: () => void
  onStartFirstRead?: () => void
  onOpenSettings?: () => void
  onTextSelectionAction?: (input: {
    action: "copy" | "translate" | "ask"
    startPage: number
    endPage: number
    text: string
  }) => void
  onImageSelectionAction?: (input: { action: "copy" | "translate" | "ask"; page: number; imageDataUrl: string }) => void
  onSwapLayout?: () => void
}

type ViewerMessage =
  | { channel: "aether-pdf-viewer"; type: "ready" }
  | { channel: "aether-pdf-viewer"; type: "pagechange"; page: number }
  | { channel: "aether-pdf-viewer"; type: "locationchange"; location: string }
  | { channel: "aether-pdf-viewer"; type: "documentinfo"; totalPages: number }
  | { channel: "aether-pdf-viewer"; type: "pdf2md" }
  | { channel: "aether-pdf-viewer"; type: "openreadingmode" }
  | { channel: "aether-pdf-viewer"; type: "exitquickreading" }
  | { channel: "aether-pdf-viewer"; type: "startfirstread" }
  | { channel: "aether-pdf-viewer"; type: "opensettings" }
  | {
      channel: "aether-pdf-viewer"
      type: "textselectionaction"
      action: "copy" | "translate" | "ask"
      startPage: number
      endPage: number
      text: string
    }
  | {
      channel: "aether-pdf-viewer"
      type: "imageselectionaction"
      action: "copy" | "translate" | "ask"
      page: number
      imageDataUrl: string
    }
  | { channel: "aether-pdf-viewer"; type: "viewtheme"; theme: PdfViewTheme }
  | { channel: "aether-pdf-viewer"; type: "swaplayout" }
  | { channel: "aether-pdf-viewer"; type: "themechange" }

export const PdfViewerShell: Component<PdfViewerShellProps> = (props) => {
  bindViewThemeSync()
  let iframeRef: HTMLIFrameElement | undefined
  let ready = false
  let lastReportedPage: number | undefined
  let lastReportedLocation: string | undefined
  let lastConfigKey = ""
  const [viewTheme, setViewTheme] = createSignal(props.viewTheme ?? sharedViewTheme)

  const viewerSrc = createMemo(() => (isFileProtocol() ? "./pdf-viewer.html" : href("/pdf-viewer.html")))
  const config = createMemo(() => ({
    src: props.src,
    authHeader: props.authHeader,
    mode: props.mode,
    viewTheme: props.viewTheme ?? viewTheme(),
    layoutSwapped: !!props.layoutSwapped,
    features: {
      pdf2md: !!props.onPdfToMarkdown,
      readingMode: !!props.onOpenReadingMode,
      quickReadingExit: !!props.onExitQuickReading,
      firstRead: !!props.onStartFirstRead,
      settings: !!props.onOpenSettings,
      textSelectionActions: !!props.onTextSelectionAction,
      imageSelectionActions: !!props.onImageSelectionAction,
      swapLayout: !!props.onSwapLayout,
    },
  }))

  createEffect(() => {
    if (!props.viewTheme) return
    setViewTheme(props.viewTheme)
  })

  const post = (message: unknown) => {
    const frame = iframeRef?.contentWindow
    if (!frame) return
    frame.postMessage(message, viewerMessageTargetOrigin())
  }

  const sendPage = () => {
    const page = props.page
    if (!ready || page === undefined) return
    if (page === lastReportedPage) return
    post({
      channel: "aether-pdf-viewer",
      type: "navigate",
      page,
    })
  }

  const sendLocation = () => {
    const location = props.location
    if (!ready || !location) return
    if (location === lastReportedLocation) return
    post({
      channel: "aether-pdf-viewer",
      type: "location",
      location,
    })
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
      config: {
        ...nextConfig,
        page: props.page,
        location: props.location,
      },
    })
  }

  createEffect(() => {
    void config()
    sendConfig()
  })

  createEffect(() => {
    void props.page
    sendPage()
  })

  createEffect(() => {
    void props.location
    sendLocation()
  })

  createEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      if (!ready) return
      post({
        channel: "aether-pdf-viewer",
        type: "themechange",
      })
    })

    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-color-scheme"],
    })

    onCleanup(() => observer.disconnect())
  })

  viewThemeSubscribers.add(setViewTheme)
  onCleanup(() => viewThemeSubscribers.delete(setViewTheme))

  const onMessage = (event: MessageEvent<ViewerMessage>) => {
    if (event.source !== iframeRef?.contentWindow) return
    if (event.data?.channel !== "aether-pdf-viewer") return
    if (!isFileProtocol() && event.origin !== window.location.origin) return

    if (event.data.type === "ready") {
      ready = true
      lastReportedPage = undefined
      lastReportedLocation = undefined
      lastConfigKey = ""
      sendConfig()
      return
    }

    if (event.data.type === "pagechange") {
      lastReportedPage = event.data.page
      props.onPageChange?.(event.data.page)
      return
    }

    if (event.data.type === "locationchange") {
      lastReportedLocation = event.data.location
      props.onLocationChange?.(event.data.location)
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
        startPage: event.data.startPage,
        endPage: event.data.endPage,
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

    if (event.data.type === "viewtheme") {
      setSharedViewTheme(event.data.theme)
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
      />
    </div>
  )
}
