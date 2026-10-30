import { type Component, createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { href } from "@/base-path"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { queue } from "./pdf-annotation-save"
import { AskEditor, type AskAnchor } from "./ask-editor"
import type { Reference } from "@/utils/ask-reference"
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

const drafts = new Map<string, { refs: number; queue: ReturnType<typeof queue<PdfAnnotationFile>> }>()

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

export type PdfTextSelection = {
  action: "copy" | "translate" | "ask"
  startPage: number
  endPage: number
  text: string
  selection?: string
  question?: string
}
export type PdfImageSelection = {
  action: "copy" | "translate" | "ask"
  page: number
  imageDataUrl: string
  selection?: string
  question?: string
}
type Selection = (PdfTextSelection | PdfImageSelection) & { document: string; selection: string; rect: AskAnchor }

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
  askScope?: string
  askPath?: string
  references?: readonly Reference[]
  onPageChange?: (page: number) => void
  onLocationChange?: (location: string) => void
  onDocumentInfo?: (info: { totalPages: number }) => void
  onPdfToMarkdown?: () => void
  onOpenReadingMode?: () => void
  onExitQuickReading?: () => void
  onStartFirstRead?: () => void
  onOpenSettings?: () => void
  onTextSelectionAction?: (input: PdfTextSelection) => void
  onImageSelectionAction?: (input: PdfImageSelection) => void
  onSwapLayout?: () => void
}

type ViewerMessage =
  | { channel: "aether-pdf-viewer"; type: "ready" }
  | { channel: "aether-pdf-viewer"; type: "pagechange"; page: number }
  | { channel: "aether-pdf-viewer"; type: "locationchange"; location: string }
  | { channel: "aether-pdf-viewer"; type: "documentinfo"; totalPages: number }
  | { channel: "aether-pdf-viewer"; type: "loaderror"; message?: string }
  | { channel: "aether-pdf-viewer"; type: "pdf2md" }
  | { channel: "aether-pdf-viewer"; type: "openreadingmode" }
  | { channel: "aether-pdf-viewer"; type: "exitquickreading" }
  | { channel: "aether-pdf-viewer"; type: "startfirstread" }
  | { channel: "aether-pdf-viewer"; type: "opensettings" }
  | {
      channel: "aether-pdf-viewer"
      type: "textselectionaction"
      document: string
      selection: string
      rect: AskAnchor
      action: "copy" | "translate" | "ask"
      startPage: number
      endPage: number
      text: string
    }
  | {
      channel: "aether-pdf-viewer"
      type: "imageselectionaction"
      document: string
      selection: string
      rect: AskAnchor
      action: "copy" | "translate" | "ask"
      page: number
      imageDataUrl: string
    }
  | { channel: "aether-pdf-viewer"; type: "askcancel"; document: string }
  | { channel: "aether-pdf-viewer"; type: "viewtheme"; theme: PdfViewTheme }
  | { channel: "aether-pdf-viewer"; type: "swaplayout" }
  | { channel: "aether-pdf-viewer"; type: "themechange" }
  | { channel: "aether-pdf-viewer"; type: "annotationchange"; document: string; annotations: PdfAnnotation[] }
  | { channel: "aether-pdf-viewer"; type: "exportannotations"; document: string }

export const PdfViewerShell: Component<PdfViewerShellProps> = (props) => {
  const sdk = useSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const channel = crypto.randomUUID()
  bindViewThemeSync()
  let iframeRef: HTMLIFrameElement | undefined
  const [viewerReady, setViewerReady] = createSignal(false)
  let lastReportedPage: number | undefined
  let lastReportedLocation: string | undefined
  let lastConfigKey = ""
  let serial = 0
  let draft: ReturnType<typeof queue<PdfAnnotationFile>> | undefined
  const [viewTheme, setViewTheme] = createSignal(props.viewTheme ?? sharedViewTheme)
  const [ask, setAsk] = createSignal<Selection>()
  const [annotations, setAnnotations] = createSignal<PdfAnnotationFile>()
  const scope = () => JSON.stringify([sdk.url, sdk.directory, props.annotationPath])
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
  const selectionDocument = () => JSON.stringify([scope(), finalSrc(), props.askScope, props.askPath])
  const config = createMemo(() => ({
    src: finalSrc(),
    document: scope(),
    selectionDocument: selectionDocument(),
    authHeader: props.authHeader,
    mode: props.mode,
    viewTheme: props.viewTheme ?? viewTheme(),
    layoutSwapped: !!props.layoutSwapped,
    labels: {
      toolbar: language.t("pdf.selection.toolbar"),
      copy: language.t("pdf.selection.copy"),
      translate: language.t("pdf.selection.translate"),
      ask: language.t("pdf.selection.ask"),
      highlight: language.t("pdf.selection.highlight"),
      underline: language.t("pdf.selection.underline"),
      strikeout: language.t("pdf.selection.strikeout"),
      note: language.t("pdf.selection.note"),
      annotationAdd: language.t("pdf.annotation.add"),
      annotationEdit: language.t("pdf.annotation.edit"),
      annotationClose: language.t("pdf.annotation.close"),
      annotationType: language.t("pdf.annotation.type"),
      annotationColor: language.t("pdf.annotation.color"),
      annotationText: language.t("pdf.annotation.text"),
      annotationPlaceholder: language.t("pdf.annotation.placeholder"),
      annotationDelete: language.t("pdf.annotation.delete"),
      annotationCancel: language.t("pdf.annotation.cancel"),
      annotationSave: language.t("pdf.annotation.save"),
      annotationDeleted: language.t("pdf.annotation.deleted"),
      annotationUndo: language.t("pdf.annotation.undo"),
      annotationYellow: language.t("pdf.annotation.yellow"),
      annotationRed: language.t("pdf.annotation.red"),
      annotationGreen: language.t("pdf.annotation.green"),
      annotationBlue: language.t("pdf.annotation.blue"),
      annotationNote: language.t("pdf.annotation.note"),
    },
    features: {
      pdf2md: !!props.onPdfToMarkdown,
      readingMode: !!props.onOpenReadingMode,
      quickReadingExit: !!props.onExitQuickReading,
      firstRead: !!props.onStartFirstRead,
      settings: !!props.onOpenSettings,
      textSelectionActions: !!props.onTextSelectionAction,
      imageSelectionActions: !!props.onImageSelectionAction,
      annotations: !!props.annotationPath && !!annotations(),
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

  const closeAsk = () => {
    const item = ask()
    setAsk(undefined)
    if (item) post({ channel: "aether-pdf-viewer", type: "askclose", document: item.document })
  }
  createEffect(() => {
    const key = selectionDocument()
    const item = ask()
    if (item && item.document !== key) closeAsk()
  })
  const previous = createMemo(() => {
    const item = ask()
    if (!item) return
    return props.references?.find(
      (ref) =>
        ref.kind === "pdf" &&
        ref.path === (props.askPath ?? props.annotationPath) &&
        ref.selection === item.selection &&
        ref.startPage === ("page" in item ? item.page : item.startPage) &&
        ref.endPage === ("page" in item ? item.page : item.endPage) &&
        ref.content === ("page" in item ? "image" : "text"),
    )
  })
  const select = (item: Selection) => {
    if (item.document !== selectionDocument()) return
    if (item.action !== "ask") {
      if ("page" in item) props.onImageSelectionAction?.(item)
      else props.onTextSelectionAction?.(item)
      return
    }
    if (!item.rect || !Object.values(item.rect).every(Number.isFinite)) return
    const rect = iframeRef?.getBoundingClientRect()
    if (!rect) return
    setAsk({
      ...item,
      rect: {
        top: item.rect.top + rect.top,
        bottom: item.rect.bottom + rect.top,
        left: item.rect.left + rect.left,
        right: item.rect.right + rect.left,
      },
    })
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
    draft = undefined
    setAnnotations(undefined)
    if (!path) return
    const key = scope()
    const entry = drafts.get(key) ?? { refs: 0, queue: queue<PdfAnnotationFile>() }
    entry.refs++
    drafts.set(key, entry)
    draft = entry.queue
    onCleanup(() => {
      if (id === serial) {
        serial++
        draft = undefined
      }
      entry.refs--
      void entry.queue.flush().then(
        () => {
          if (!entry.refs && drafts.get(key) === entry) drafts.delete(key)
        },
        () => {},
      )
    })
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
          if (
            !window.confirm("This PDF changed and its saved annotations may be misplaced. Reset the annotation draft?")
          ) {
            return
          }
          setAnnotations({ ...result.data, annotations: [] })
          persist([])
          return
        }
        setAnnotations(entry.queue.load(result.data))
        failure(entry.queue, id)
      })
      .catch((err) => {
        if (id !== serial) return
        showToast({ variant: "error", title: "Failed to load PDF annotations", description: String(err) })
      })
  })

  const persist = (items: PdfAnnotation[]) => {
    const path = props.annotationPath
    const data = annotations()
    const state = draft
    if (!path || !data || !state) return
    const id = serial
    const key = scope()
    const target = url("file/pdf-annotations")
    const auth = headers()
    const next = { ...data, annotations: items }
    const publish = () => {
      if (id === serial && draft === state) setAnnotations(state.data)
      window.dispatchEvent(new CustomEvent("aether:pdf-annotations", { detail: { channel, key } }))
    }
    void state
      .save(next, async (data) => {
        const res = await fetch(target, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify({ path, data }),
        })
        if (!res.ok) throw new Error(`Failed to save PDF annotations (${res.status})`)
        return (await res.json()) as PdfAnnotationFile
      })
      .then(() => {
        publish()
        failure(state, id)
      })
    publish()
  }

  const failure = (state: ReturnType<typeof queue<PdfAnnotationFile>>, id: number) => {
    if (!state.error || id !== serial || draft !== state) return
    showToast({
      variant: "error",
      title: language.t("pdf.annotation.saveFailed"),
      description: state.error.message,
      actions: [
        {
          label: language.t("pdf.annotation.saveRetry"),
          onClick: () => {
            if (id === serial && draft === state && state.data) persist(state.data.annotations)
          },
        },
      ],
    })
  }

  const onAnnotations = (event: Event) => {
    const detail = (event as CustomEvent<{ channel: string; key: string }>).detail
    if (!detail || detail.channel === channel || detail.key !== scope()) return
    const data = draft?.data
    if (data) setAnnotations(data)
  }
  window.addEventListener("aether:pdf-annotations", onAnnotations)
  onCleanup(() => window.removeEventListener("aether:pdf-annotations", onAnnotations))

  const exportPdf = async () => {
    const path = props.annotationPath
    if (!path) return
    const state = draft
    const id = serial
    if (!state || !annotations()) throw new Error(language.t("pdf.annotation.exportFailed"))
    await state.flush()
    if (id !== serial || draft !== state) return
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
    const name = match?.[1]
      ? decodeURIComponent(match[1])
      : `${path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.pdf$/i, "")}-annotated.pdf`
    const blob = await res.blob()
    if (id !== serial || draft !== state) return
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
    const data = annotations()
    if (!viewerReady()) return
    post({ channel: "aether-pdf-viewer", type: "annotations", document: scope(), annotations: data?.annotations ?? [] })
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
      const data = annotations()
      post({
        channel: "aether-pdf-viewer",
        type: "annotations",
        document: scope(),
        annotations: data?.annotations ?? [],
      })
      return
    }

    if (event.data.type === "loaderror") {
      // The viewer keeps its DOM alive now, so a single delayed retry through
      // the src dedupe is enough to recover from a mid-write fetch. Bounded:
      // only one retry per src, so a genuinely broken file won't loop.
      const src = props.src
      if (retriedFor !== src) {
        retriedFor = src
        retryTimer = setTimeout(() => setReloadKey((key) => key + 1), 5000)
      }
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

    if (event.data.type === "textselectionaction" || event.data.type === "imageselectionaction") {
      select(event.data)
      return
    }
    if (event.data.type === "askcancel") {
      if (event.data.document === ask()?.document) closeAsk()
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
      if (event.data.document !== scope()) return
      persist(event.data.annotations)
      return
    }

    if (event.data.type === "exportannotations") {
      if (event.data.document !== scope()) return
      void exportPdf().catch((err) => {
        showToast({ variant: "error", title: language.t("pdf.annotation.exportFailed"), description: String(err) })
      })
    }
  }

  window.addEventListener("message", onMessage)
  onCleanup(() => {
    window.removeEventListener("message", onMessage)
    if (retryTimer) clearTimeout(retryTimer)
    closeAsk()
  })

  return (
    <div class={`pdf-viewer-shell ${props.class ?? ""}`}>
      <Show when={ask()} keyed>
        {(item) => (
          <AskEditor
            title={language.t("ask.editor.title")}
            preview={"text" in item ? item.text : language.t("ask.editor.title")}
            image={"imageDataUrl" in item ? item.imageDataUrl : undefined}
            question={previous()?.question}
            editing={!!previous()}
            anchor={item.rect}
            onCancel={closeAsk}
            onSave={(question) => {
              if (item.document !== selectionDocument()) return closeAsk()
              if ("page" in item) props.onImageSelectionAction?.({ ...item, question })
              else props.onTextSelectionAction?.({ ...item, question })
              closeAsk()
            }}
          />
        )}
      </Show>
      <iframe ref={iframeRef} src={viewerSrc()} class="pdf-viewer-shell__frame" title="PDF Viewer" loading="eager" />
    </div>
  )
}
