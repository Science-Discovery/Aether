import { type Component, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { href } from "@/base-path"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { showToast } from "@opencode-ai/ui/toast"
import "./pdf-viewer-shell.css"

type ViewerMode = "full" | "compact"
export type PdfViewTheme = "day" | "night" | "eye"
export type PdfAnnotationColor = "yellow" | "red" | "green" | "blue"
export type PdfAnnotation = {
  id: string
  type: "highlight" | "underline" | "strikeout" | "note"
  color: PdfAnnotationColor
  pages: Array<{ page: number; quads: Array<[number, number, number, number, number, number, number, number]> }>
  selectedText: string
  note: string
  createdAt: number
  updatedAt: number
}

type PdfAnnotationFile = {
  version: "1.2"
  source: { path: string; fingerprint: string }
  annotations: PdfAnnotation[]
}

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
  annotationPath?: string
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
  | { channel: "aether-pdf-viewer"; type: "annotationchange"; annotations: PdfAnnotation[] }
  | { channel: "aether-pdf-viewer"; type: "exportannotations" }

export const PdfViewerShell: Component<PdfViewerShellProps> = (props) => {
  const sdk = useSDK()
  const platform = usePlatform()
  const channel = crypto.randomUUID()
  bindViewThemeSync()
  let iframeRef: HTMLIFrameElement | undefined
  let ready = false
  let lastReportedPage: number | undefined
  let lastReportedLocation: string | undefined
  let lastConfigKey = ""
  let serial = 0
  let saving = Promise.resolve()
  const [viewTheme, setViewTheme] = createSignal(props.viewTheme ?? sharedViewTheme)
  const [annotations, setAnnotations] = createSignal<PdfAnnotationFile>()

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
      annotations: !!props.annotationPath,
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

  const url = (pathname: string) => {
    const url = new URL(pathname, `${sdk.url.replace(/\/+$/, "")}/`)
    url.searchParams.set("directory", sdk.directory)
    return url
  }

  const headers = () => (props.authHeader ? { Authorization: props.authHeader } : undefined)

  createEffect(() => {
    const path = props.annotationPath
    const id = ++serial
    setAnnotations(undefined)
    if (!path) return
    const target = url("file/pdf-annotations")
    target.searchParams.set("path", path)
    void fetch(target, { headers: headers() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load PDF annotations (${res.status})`)
        return res.json() as Promise<{ status: "ready" | "stale"; data: PdfAnnotationFile }>
      })
      .then((result) => {
        if (id !== serial) return
        if (result.status === "stale") {
          showToast({
            variant: "error",
            title: "PDF annotations paused",
            description: "The PDF changed after these annotations were created.",
          })
          if (!window.confirm("This PDF changed and its saved annotations may be misplaced. Reset the annotation draft?")) {
            return
          }
          const next = { ...result.data, annotations: [] }
          void fetch(url("file/pdf-annotations"), {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...headers() },
            body: JSON.stringify({ path, data: next }),
          })
            .then(async (res) => {
              if (!res.ok) throw new Error(`Failed to reset PDF annotations (${res.status})`)
              if (id === serial) setAnnotations((await res.json()) as PdfAnnotationFile)
            })
            .catch((err) => {
              showToast({ variant: "error", title: "Failed to reset PDF annotations", description: String(err) })
            })
          return
        }
        setAnnotations(result.data)
      })
      .catch((err) => {
        if (id !== serial) return
        showToast({ variant: "error", title: "Failed to load PDF annotations", description: String(err) })
      })
  })

  createEffect(() => {
    const data = annotations()
    if (!ready || !data) return
    post({ channel: "aether-pdf-viewer", type: "annotations", annotations: data.annotations })
  })

  const persist = (items: PdfAnnotation[]) => {
    const path = props.annotationPath
    const data = annotations()
    if (!path || !data) return
    const next = { ...data, annotations: items }
    setAnnotations(next)
    window.dispatchEvent(
      new CustomEvent("aether:pdf-annotations", { detail: { channel, path, data: next } }),
    )
    saving = saving
      .then(async () => {
        const res = await fetch(url("file/pdf-annotations"), {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ path, data: next }),
        })
        if (!res.ok) throw new Error(`Failed to save PDF annotations (${res.status})`)
        setAnnotations((await res.json()) as PdfAnnotationFile)
      })
      .catch((err) => {
        showToast({ variant: "error", title: "Failed to save PDF annotations", description: String(err) })
      })
  }

  const onAnnotations = (event: Event) => {
    const detail = (event as CustomEvent<{ channel: string; path: string; data: PdfAnnotationFile }>).detail
    if (!detail || detail.channel === channel || detail.path !== props.annotationPath) return
    setAnnotations(detail.data)
    if (ready) post({ channel: "aether-pdf-viewer", type: "annotations", annotations: detail.data.annotations })
  }
  window.addEventListener("aether:pdf-annotations", onAnnotations)
  onCleanup(() => window.removeEventListener("aether:pdf-annotations", onAnnotations))

  const exportPdf = async () => {
    const path = props.annotationPath
    if (!path) return
    await saving
    const res = await fetch(url("file/pdf-annotations/export"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
      throw new Error(body?.error ?? `Failed to export annotated PDF (${res.status})`)
    }
    const head = res.headers.get("Content-Disposition")
    const match = head?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
    const name = match?.[1] ? decodeURIComponent(match[1]) : `${path.split(/[\\/]/).pop()?.replace(/\.pdf$/i, "")}-annotated.pdf`
    const blob = await res.blob()
    if (platform.saveFileDialog) {
      await platform.saveFileDialog({ name, data: await blob.arrayBuffer() })
      return
    }
    const href = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = href
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(href)
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
      const data = annotations()
      if (data) post({ channel: "aether-pdf-viewer", type: "annotations", annotations: data.annotations })
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
      return
    }

    if (event.data.type === "annotationchange") {
      persist(event.data.annotations)
      return
    }

    if (event.data.type === "exportannotations") {
      void exportPdf().catch((err) => {
        showToast({ variant: "error", title: "Failed to export annotated PDF", description: String(err) })
      })
    }
  }

  window.addEventListener("message", onMessage)
  onCleanup(() => window.removeEventListener("message", onMessage))

  return (
    <div class={`pdf-viewer-shell ${props.class ?? ""}`}>
      <iframe ref={iframeRef} src={viewerSrc()} class="pdf-viewer-shell__frame" title="PDF Viewer" loading="eager" />
    </div>
  )
}
