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

export type PdfVersion = { document?: string; version?: string; src?: string }
export type PdfReveal = {
  id: string
  document: string
  version: string
  page: number
  rect: [number, number, number, number]
}
export type PdfLocate = { document: string; version: string; page: number; x: number; y: number }
export type PdfLocateUnavailable = {
  reason: "busy" | "unavailable"
  document: string
  version: string
  id?: string
}
type PdfSource = PdfVersion & { src: string; annotationPath?: string; annotationBuild?: string }
type PdfAnnotations = { status: "ready" | "stale"; data: PdfAnnotationFile; revision?: string }

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
  document?: string
  version?: string
  authHeader?: string
  mode: ViewerMode
  class?: string
  viewTheme?: PdfViewTheme
  page?: number
  location?: string
  layoutSwapped?: boolean
  annotationPath?: string
  annotationBuild?: string
  reveal?: PdfReveal
  onSourceLocate?: (input: PdfLocate) => void
  onLocateUnavailable?: (input: PdfLocateUnavailable) => void
  onBusyChange?: (busy: boolean) => void
  onVersionChange?: (version: string) => void
  onPageChange?: (page: number) => void
  onLocationChange?: (location: string) => void
  onDocumentInfo?: (info: { totalPages: number } & PdfVersion) => void
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
    document?: string
    version?: string
  }) => void
  onImageSelectionAction?: (
    input: { action: "copy" | "translate" | "ask"; page: number; imageDataUrl: string } & PdfVersion,
  ) => void
  onSwapLayout?: () => void
}

type ViewerMessage = PdfVersion &
  (
    | { channel: "aether-pdf-viewer"; type: "ready" }
    | { channel: "aether-pdf-viewer"; type: "pagechange"; page: number }
    | { channel: "aether-pdf-viewer"; type: "locationchange"; location: string }
    | { channel: "aether-pdf-viewer"; type: "documentinfo"; totalPages: number; source: PdfSource }
    | { channel: "aether-pdf-viewer"; type: "loaderror"; message?: string; src?: string }
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
    | { channel: "aether-pdf-viewer"; type: "annotationchange"; annotations: PdfAnnotation[]; id: number }
    | { channel: "aether-pdf-viewer"; type: "exportannotations" }
    | { channel: "aether-pdf-viewer"; type: "reloadannotations" }
    | ({ channel: "aether-pdf-viewer"; type: "sourcelocate" } & PdfLocate)
    | ({ channel: "aether-pdf-viewer"; type: "locateunavailable" } & PdfLocateUnavailable)
    | { channel: "aether-pdf-viewer"; type: "busychange"; busy: boolean }
  )

export const PdfViewerShell: Component<PdfViewerShellProps> = (props) => {
  const sdk = useSDK()
  const platform = usePlatform()
  const channel = crypto.randomUUID()
  bindViewThemeSync()
  let iframeRef: HTMLIFrameElement | undefined
  const [viewerReady, setViewerReady] = createSignal(false)
  let lastReportedPage: number | undefined
  let lastReportedLocation: string | undefined
  let lastConfigKey = ""
  let revealed = ""
  let serial = 0
  let saving = Promise.resolve()
  const [viewTheme, setViewTheme] = createSignal(props.viewTheme ?? sharedViewTheme)
  const [annotations, setAnnotations] = createSignal<PdfAnnotationFile>()
  const [loaded, setLoaded] = createSignal<PdfSource>()
  const [record, setRecord] = createSignal<{
    source: PdfSource
    revision?: string
    pending: number
    failed?: boolean
  }>()
  // Bumped to force a viewer reload through its src dedupe after a failed load
  // (e.g. a fetch that raced a non-atomic write). One retry per src change.
  const [reloadKey, setReloadKey] = createSignal(0)
  let retriedFor: string | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const viewerSrc = createMemo(() => (isFileProtocol() ? "./pdf-viewer.html" : href("/pdf-viewer.html")))
  const finalSrc = createMemo(() => {
    const key = reloadKey()
    if (!key) return props.src
    const join = props.src.includes("?") ? "&" : "?"
    return `${props.src}${join}r=${key}`
  })
  const config = createMemo(() => ({
    src: finalSrc(),
    document: props.document,
    version: props.version,
    annotationPath: props.annotationPath,
    annotationBuild: props.annotationBuild,
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
      annotations: !!(props.annotationPath || props.annotationBuild),
      swapLayout: !!props.onSwapLayout,
      sourceLocate: !!props.onSourceLocate,
      activity: !!props.onBusyChange,
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

  const identity = (source: PdfSource) =>
    source.annotationBuild ? `latex:${source.annotationBuild}` : source.annotationPath

  const endpoint = (source: PdfSource, exportPdf = false) => {
    const target = source.annotationBuild
      ? url(`latex/build/${encodeURIComponent(source.annotationBuild)}/annotations${exportPdf ? "/export" : ""}`)
      : url(`file/pdf-annotations${exportPdf ? "/export" : ""}`)
    if (!exportPdf && source.annotationPath && !source.annotationBuild)
      target.searchParams.set("path", source.annotationPath)
    return target
  }

  const matches = (source: PdfVersion | undefined, message: PdfVersion) =>
    !!source && source.version === message.version && source.document === message.document && source.src === message.src

  createEffect(() => {
    const source = loaded()
    const id = ++serial
    setAnnotations(undefined)
    setRecord(undefined)
    if (!source || !identity(source)) return
    const target = endpoint(source)
    const auth = headers()
    void fetch(target, { headers: auth })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load PDF annotations (${res.status})`)
        return res.json() as Promise<PdfAnnotations>
      })
      .then((result) => {
        if (id !== serial) return
        if (result.status === "stale") {
          showToast({
            variant: "error",
            title: "PDF annotations paused",
            description: "The PDF changed after these annotations were created.",
          })
          if (
            !window.confirm("This PDF changed and its saved annotations may be misplaced. Reset the annotation draft?")
          ) {
            return
          }
          const next = { ...result.data, annotations: [] }
          void fetch(target, {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ path: source.annotationPath, data: next }),
          })
            .then(async (res) => {
              if (!res.ok) throw new Error(`Failed to reset PDF annotations (${res.status})`)
              const data = (await res.json()) as PdfAnnotationFile
              if (id !== serial) return
              setRecord({ source, pending: 0 })
              setAnnotations(data)
            })
            .catch((err) => {
              showToast({ variant: "error", title: "Failed to reset PDF annotations", description: String(err) })
            })
          return
        }
        setRecord({ source, revision: result.revision, pending: 0 })
        setAnnotations(result.data)
      })
      .catch((err) => {
        if (id !== serial) return
        showToast({ variant: "error", title: "Failed to load PDF annotations", description: String(err) })
      })
  })

  createEffect(() => {
    const data = annotations()
    const source = record()?.source
    if (!viewerReady() || !data || !source) return
    post({ channel: "aether-pdf-viewer", type: "annotations", annotations: data.annotations, ...source })
  })

  const persist = (message: Extract<ViewerMessage, { type: "annotationchange" }>) => {
    const ctx = record()
    const data = annotations()
    if (!ctx || !data || !matches(ctx.source, message)) {
      post({
        channel: "aether-pdf-viewer",
        type: "annotationstatus",
        id: message.id,
        document: message.document,
        version: message.version,
        src: message.src,
        ok: false,
      })
      return
    }
    const next = { ...data, annotations: message.annotations }
    const target = endpoint(ctx.source)
    const auth = headers()
    ctx.pending++
    setAnnotations(next)
    saving = saving
      .then(async () => {
        const res = await fetch(target, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify(
            ctx.source.annotationBuild
              ? { data: next, revision: ctx.revision }
              : { path: ctx.source.annotationPath, data: next },
          ),
        })
        if (!res.ok)
          throw new Error(
            res.status === 409
              ? "Annotations changed in another view. Your edits are still open; reload saved annotations to resolve the conflict."
              : `Failed to save PDF annotations (${res.status})`,
          )
        const result = (await res.json()) as PdfAnnotationFile | PdfAnnotations
        const saved = "data" in result ? result.data : result
        if ("revision" in result) ctx.revision = result.revision
        ctx.failed = false
        window.dispatchEvent(
          new CustomEvent("aether:pdf-annotations", {
            detail: { channel, path: identity(ctx.source), data: saved, revision: ctx.revision },
          }),
        )
        post({ channel: "aether-pdf-viewer", type: "annotationstatus", id: message.id, ...ctx.source, ok: true })
      })
      .catch((err) => {
        ctx.failed = true
        showToast({ variant: "error", title: "Failed to save PDF annotations", description: String(err) })
        post({ channel: "aether-pdf-viewer", type: "annotationstatus", id: message.id, ...ctx.source, ok: false })
      })
      .finally(() => {
        ctx.pending--
      })
  }

  const onAnnotations = (event: Event) => {
    const detail = (event as CustomEvent<{ channel: string; path: string; data: PdfAnnotationFile; revision?: string }>)
      .detail
    const ctx = record()
    if (
      !ctx ||
      ctx.pending ||
      ctx.failed ||
      !detail ||
      detail.channel === channel ||
      detail.path !== identity(ctx.source)
    )
      return
    ctx.revision = detail.revision
    setAnnotations(detail.data)
  }
  window.addEventListener("aether:pdf-annotations", onAnnotations)
  onCleanup(() => window.removeEventListener("aether:pdf-annotations", onAnnotations))

  const exportPdf = async () => {
    const ctx = record()
    if (!ctx) return
    const target = endpoint(ctx.source, true)
    const auth = headers()
    await saving
    if (ctx.failed) throw new Error("Save annotations before exporting this PDF.")
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ path: ctx.source.annotationPath }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
      throw new Error(body?.error ?? `Failed to export annotated PDF (${res.status})`)
    }
    const head = res.headers.get("Content-Disposition")
    const match = head?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
    const name = match?.[1]
      ? decodeURIComponent(match[1])
      : `${(ctx.source.annotationPath ?? ctx.source.annotationBuild ?? "document")
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.pdf$/i, "")}-annotated.pdf`
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
    if (!viewerReady() || page === undefined) return
    if (page === lastReportedPage) return
    post({
      channel: "aether-pdf-viewer",
      type: "navigate",
      page,
      document: props.document,
      version: props.version,
    })
  }

  const sendLocation = () => {
    const location = props.location
    if (!viewerReady() || !location) return
    if (location === lastReportedLocation) return
    post({
      channel: "aether-pdf-viewer",
      type: "location",
      location,
      document: props.document,
      version: props.version,
    })
  }

  const sendConfig = () => {
    const nextConfig = config()
    if (!nextConfig.src || !viewerReady()) return
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
    const target = props.reveal
    const source = loaded()
    if (!target || !source || !viewerReady() || revealed === target.id) return
    // A requested PDF may still be loading while the previous build remains visible.
    if (target.document !== source.document || target.version !== source.version) return
    revealed = target.id
    // Solid store arrays are proxies and cannot cross the iframe structured-clone boundary.
    post({ channel: "aether-pdf-viewer", type: "reveal", ...target, rect: Array.from(target.rect), src: source.src })
  })

  createEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      if (!viewerReady()) return
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
      setViewerReady(true)
      lastReportedPage = undefined
      lastReportedLocation = undefined
      lastConfigKey = ""
      sendConfig()
      return
    }

    if (event.data.type === "loaderror") {
      // The viewer keeps its DOM alive now, so a single delayed retry through
      // the src dedupe is enough to recover from a mid-write fetch. Bounded:
      // only one retry per src, so a genuinely broken file won't loop.
      const src = props.src
      if (event.data.src && event.data.src !== finalSrc()) return
      if (retriedFor !== src) {
        retriedFor = src
        retryTimer = setTimeout(() => {
          if (src === props.src) setReloadKey((key) => key + 1)
        }, 5000)
      }
      return
    }

    if (event.data.type === "pagechange") {
      if (props.document ? event.data.document !== props.document : event.data.src !== finalSrc()) return
      lastReportedPage = event.data.page
      props.onPageChange?.(event.data.page)
      return
    }

    if (event.data.type === "locationchange") {
      if (props.document ? event.data.document !== props.document : event.data.src !== finalSrc()) return
      lastReportedLocation = event.data.location
      props.onLocationChange?.(event.data.location)
      return
    }

    if (event.data.type === "documentinfo") {
      setLoaded(event.data.source)
      if (event.data.version) props.onVersionChange?.(event.data.version)
      props.onDocumentInfo?.({
        totalPages: event.data.totalPages,
        document: event.data.document,
        version: event.data.version,
      })
      return
    }

    if (event.data.type === "sourcelocate") {
      if (!props.onSourceLocate || !matches(loaded(), event.data)) return
      const data = event.data
      if (typeof data.document !== "string" || !data.document || typeof data.version !== "string" || !data.version)
        return
      if (data.document !== props.document || !Number.isInteger(data.page) || data.page < 1) return
      if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return
      props.onSourceLocate({ document: data.document, version: data.version, page: data.page, x: data.x, y: data.y })
      return
    }

    if (event.data.type === "busychange") {
      if (!matches(loaded(), event.data) || typeof event.data.busy !== "boolean") return
      props.onBusyChange?.(event.data.busy)
      return
    }

    if (event.data.type === "locateunavailable") {
      if (!matches(loaded(), event.data)) return
      const data = event.data
      if (typeof data.document !== "string" || !data.document || typeof data.version !== "string" || !data.version)
        return
      if (data.document !== props.document || (data.reason !== "busy" && data.reason !== "unavailable")) return
      if (data.id ? props.reveal?.id !== data.id : !props.onSourceLocate) return
      props.onLocateUnavailable?.({ document: data.document, version: data.version, reason: data.reason, id: data.id })
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
        document: event.data.document,
        version: event.data.version,
      })
      return
    }

    if (event.data.type === "imageselectionaction") {
      props.onImageSelectionAction?.({
        action: event.data.action,
        page: event.data.page,
        imageDataUrl: event.data.imageDataUrl,
        document: event.data.document,
        version: event.data.version,
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
      persist(event.data)
      return
    }

    if (event.data.type === "exportannotations") {
      if (!matches(loaded(), event.data)) return
      void exportPdf().catch((err) => {
        showToast({ variant: "error", title: "Failed to export annotated PDF", description: String(err) })
      })
      return
    }

    if (event.data.type === "reloadannotations") {
      const source = loaded()
      if (!source || !matches(source, event.data)) return
      setLoaded({ ...source })
    }
  }

  window.addEventListener("message", onMessage)
  onCleanup(() => {
    serial++
    props.onBusyChange?.(false)
    window.removeEventListener("message", onMessage)
    if (retryTimer) clearTimeout(retryTimer)
  })

  return (
    <div class={`pdf-viewer-shell ${props.class ?? ""}`}>
      <iframe ref={iframeRef} src={viewerSrc()} class="pdf-viewer-shell__frame" title="PDF Viewer" loading="eager" />
    </div>
  )
}
