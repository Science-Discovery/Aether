import { type Component, createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { href } from "@/base-path"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { queue } from "./pdf-annotation-save"
import { AskEditor, type AskAnchor } from "./ask-editor"
import { pdfMarks, type Reference } from "@/utils/ask-reference"
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

const drafts = new Map<
  string,
  {
    refs: number
    pending: number
    revision?: string
    queue: ReturnType<typeof queue<PdfAnnotationFile>>
  }
>()
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

export type PdfTextSelection = {
  action: "copy" | "translate" | "ask"
  startPage: number
  endPage: number
  text: string
  selection?: string
  fingerprint?: string
  question?: string
  document?: string
  version?: string
}
export type PdfImageSelection = {
  action: "copy" | "translate" | "ask"
  page: number
  imageDataUrl: string
  selection?: string
  fingerprint?: string
  question?: string
  document?: string
  version?: string
}
type Selection = (PdfTextSelection | PdfImageSelection) & {
  selectionDocument: string
  selection: string
  rect: AskAnchor
  reference?: string
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
  askScope?: string
  askPath?: string
  references?: readonly Reference[]
  onReferenceEdit?: (id: string, question: string) => void
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
  onTextSelectionAction?: (input: PdfTextSelection) => void
  onImageSelectionAction?: (input: PdfImageSelection) => void
  onSwapLayout?: () => void
}

type ViewerMessage = PdfVersion & { selectionDocument?: string } & (
    | { channel: "aether-pdf-viewer"; type: "ready" }
    | { channel: "aether-pdf-viewer"; type: "pagechange"; page: number }
    | { channel: "aether-pdf-viewer"; type: "locationchange"; location: string }
    | { channel: "aether-pdf-viewer"; type: "documentinfo"; totalPages: number; source: PdfSource }
    | { channel: "aether-pdf-viewer"; type: "documentready"; selectionDocument: string; fingerprint: string }
    | {
        channel: "aether-pdf-viewer"
        type: "askreference"
        selectionDocument: string
        fingerprint: string
        id: string
        rect: AskAnchor
      }
    | { channel: "aether-pdf-viewer"; type: "loaderror"; message?: string }
    | { channel: "aether-pdf-viewer"; type: "pdf2md" }
    | { channel: "aether-pdf-viewer"; type: "openreadingmode" }
    | { channel: "aether-pdf-viewer"; type: "exitquickreading" }
    | { channel: "aether-pdf-viewer"; type: "startfirstread" }
    | { channel: "aether-pdf-viewer"; type: "opensettings" }
    | {
        channel: "aether-pdf-viewer"
        type: "textselectionaction"
        selectionDocument: string
        selection: string
        fingerprint?: string
        rect: AskAnchor
        action: "copy" | "translate" | "ask"
        startPage: number
        endPage: number
        text: string
      }
    | {
        channel: "aether-pdf-viewer"
        type: "imageselectionaction"
        selectionDocument: string
        selection: string
        fingerprint?: string
        rect: AskAnchor
        action: "copy" | "translate" | "ask"
        page: number
        imageDataUrl: string
      }
    | { channel: "aether-pdf-viewer"; type: "askcancel"; selectionDocument: string }
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
  const language = useLanguage()
  const channel = crypto.randomUUID()
  bindViewThemeSync()
  let iframeRef: HTMLIFrameElement | undefined
  const [viewerReady, setViewerReady] = createSignal(false)
  let lastReportedPage: number | undefined
  let lastReportedLocation: string | undefined
  let lastConfigKey = ""
  let revealed = ""
  let serial = 0
  let draft: ReturnType<typeof queue<PdfAnnotationFile>> | undefined
  const [viewTheme, setViewTheme] = createSignal(props.viewTheme ?? sharedViewTheme)
  const [ask, setAsk] = createSignal<Selection>()
  const [identity, setIdentity] = createSignal<{ document: string; fingerprint: string }>()
  const [annotations, setAnnotations] = createSignal<PdfAnnotationFile>()
  const [loaded, setLoaded] = createSignal<PdfSource>()
  const [record, setRecord] = createSignal<{
    source: PdfSource
    key: string
    entry: NonNullable<ReturnType<typeof drafts.get>>
  }>()
  const contexts = new Map<string, string>()
  const environment = () => JSON.stringify([sdk.url, sdk.directory])
  let connection = environment()
  const scope = () => JSON.stringify([sdk.url, sdk.directory, props.annotationPath, props.annotationBuild])
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
  const fingerprint = () => (identity()?.document === selectionDocument() ? identity()?.fingerprint : undefined)
  const config = createMemo(() => ({
    src: finalSrc(),
    document: props.document,
    version: props.version,
    annotationPath: props.annotationPath,
    annotationBuild: props.annotationBuild,
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

  const closeAsk = () => {
    const item = ask()
    setAsk(undefined)
    if (item) post({ channel: "aether-pdf-viewer", type: "askclose", selectionDocument: item.selectionDocument })
  }
  createEffect(() => {
    const key = selectionDocument()
    const item = ask()
    if (
      item &&
      (item.selectionDocument !== key ||
        (item.fingerprint && item.fingerprint !== fingerprint()) ||
        (item.reference && !props.references?.some((ref) => ref.id === item.reference)))
    )
      closeAsk()
  })
  const previous = createMemo(() => {
    const item = ask()
    if (!item) return
    return props.references?.find(
      (ref) =>
        ref.kind === "pdf" &&
        ref.path === (props.askPath ?? props.annotationPath) &&
        (item.reference ? ref.id === item.reference : ref.selection === item.selection) &&
        (!ref.fingerprint || ref.fingerprint === item.fingerprint) &&
        ref.startPage === ("page" in item ? item.page : item.startPage) &&
        ref.endPage === ("page" in item ? item.page : item.endPage) &&
        ref.content === ("page" in item ? "image" : "text"),
    )
  })
  const select = (item: Selection) => {
    if (item.selectionDocument !== selectionDocument() || (item.fingerprint && item.fingerprint !== fingerprint()))
      return
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

  const sendMarks = () => {
    if (!viewerReady()) return
    post({
      channel: "aether-pdf-viewer",
      type: "askreferences",
      selectionDocument: selectionDocument(),
      fingerprint: fingerprint(),
      references: pdfMarks(props.references ?? [], props.askPath ?? props.annotationPath, fingerprint()),
    })
  }
  createEffect(sendMarks)

  const url = (pathname: string) => {
    const url = new URL(pathname, `${sdk.url.replace(/\/+$/, "")}/`)
    url.searchParams.set("directory", sdk.directory)
    return url
  }

  const headers = () => (props.authHeader ? { Authorization: props.authHeader } : undefined)

  const annotationKey = (source: PdfSource) =>
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
    const next = environment()
    if (next === connection) return
    connection = next
    setLoaded(undefined)
    setIdentity(undefined)
    closeAsk()
  })

  createEffect(() => {
    const source = loaded()
    const id = ++serial
    draft = undefined
    setAnnotations(undefined)
    setRecord(undefined)
    if (!source || !annotationKey(source)) return
    const key = JSON.stringify([sdk.url, sdk.directory, annotationKey(source)])
    const entry = drafts.get(key) ?? { refs: 0, pending: 0, revision: undefined, queue: queue<PdfAnnotationFile>() }
    entry.refs++
    drafts.set(key, entry)
    draft = entry.queue
    setRecord({ source, key, entry })
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
    const target = endpoint(source)
    void fetch(target, { headers: headers() })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load PDF annotations (${res.status})`)
        return res.json() as Promise<PdfAnnotations>
      })
      .then((result) => {
        if (id !== serial) return
        if (result.status === "stale" && !entry.queue.data) {
          showToast({
            variant: "error",
            title: "PDF annotations paused",
            description: "The PDF changed after these annotations were created.",
          })
          if (
            !window.confirm("This PDF changed and its saved annotations may be misplaced. Reset the annotation draft?")
          )
            return
          setAnnotations({ ...result.data, annotations: [] })
          persist([])
          return
        }
        // The revision and body must come from the same first accepted read.
        // Later shared-view GETs cannot replace either half of that snapshot.
        if (!entry.queue.data) {
          entry.revision = result.revision
          entry.queue.load(result.data)
        }
        setAnnotations(entry.queue.data)
        failure(entry.queue, id)
      })
      .catch((err) => {
        if (id !== serial) return
        showToast({ variant: "error", title: "Failed to load PDF annotations", description: String(err) })
      })
  })

  const persist = (items: PdfAnnotation[], message?: Extract<ViewerMessage, { type: "annotationchange" }>) => {
    const ctx = record()
    const data = annotations()
    const state = draft
    if (!ctx || !data || !state || (message && !matches(ctx.source, message))) {
      if (message)
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
    const id = serial
    const target = endpoint(ctx.source)
    const auth = headers()
    const next = { ...data, annotations: items }
    const publish = () => {
      if (id === serial && draft === state) setAnnotations(state.data)
      window.dispatchEvent(new CustomEvent("aether:pdf-annotations", { detail: { channel, key: ctx.key } }))
    }
    let saved = false
    ctx.entry.pending++
    void state
      .save(next, async (data) => {
        const res = await fetch(target, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify(
            ctx.source.annotationBuild
              ? { data, revision: ctx.entry.revision }
              : { path: ctx.source.annotationPath, data },
          ),
        })
        if (!res.ok)
          throw new Error(
            res.status === 409
              ? "Annotations changed in another view. Your edits are still open; reload saved annotations to resolve the conflict."
              : `Failed to save PDF annotations (${res.status})`,
          )
        const result = (await res.json()) as PdfAnnotationFile | PdfAnnotations
        if ("revision" in result) ctx.entry.revision = result.revision
        saved = true
        return "data" in result ? result.data : result
      })
      .then(() => {
        ctx.entry.pending--
        publish()
        if (message)
          post({ channel: "aether-pdf-viewer", type: "annotationstatus", id: message.id, ...ctx.source, ok: saved })
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
    const detail = (event as CustomEvent<{ channel: string; key: string; reset?: boolean }>).detail
    if (!detail || detail.channel === channel || detail.key !== record()?.key) return
    const data = draft?.data
    if (data) {
      setAnnotations(data)
      if (detail.reset && record())
        post({
          channel: "aether-pdf-viewer",
          type: "annotations",
          ...record()!.source,
          annotations: data.annotations,
          reset: true,
        })
    }
  }
  window.addEventListener("aether:pdf-annotations", onAnnotations)
  onCleanup(() => window.removeEventListener("aether:pdf-annotations", onAnnotations))

  const exportPdf = async () => {
    const ctx = record()
    if (!ctx) return
    const state = draft
    const id = serial
    if (!state || !annotations()) throw new Error(language.t("pdf.annotation.exportFailed"))
    await state.flush()
    if (id !== serial || draft !== state) return
    const auth = headers()
    const res = await fetch(endpoint(ctx.source, true), {
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
    contexts.set(nextConfig.selectionDocument, environment())
    if (contexts.size > 32) contexts.delete(contexts.keys().next().value!)
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
    const source = record()?.source
    if (!viewerReady() || !data || !source) return
    post({ channel: "aether-pdf-viewer", type: "annotations", ...source, annotations: data.annotations })
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
      setIdentity(undefined)
      setViewerReady(true)
      lastReportedPage = undefined
      lastReportedLocation = undefined
      lastConfigKey = ""
      sendConfig()
      sendMarks()
      const data = annotations()
      const source = record()?.source
      if (data && source)
        post({
          channel: "aether-pdf-viewer",
          type: "annotations",
          ...source,
          annotations: data.annotations,
        })
      return
    }

    if (contexts.get(event.data.selectionDocument ?? "") !== environment()) return

    if (event.data.type === "documentready") {
      if (event.data.selectionDocument !== selectionDocument()) return
      setIdentity({ document: event.data.selectionDocument, fingerprint: event.data.fingerprint })
      return
    }
    if (event.data.type === "askreference") {
      const item = event.data
      if (item.selectionDocument !== selectionDocument() || !item.fingerprint || item.fingerprint !== fingerprint())
        return
      const ref = props.references?.find(
        (ref) =>
          ref.id === item.id &&
          ref.kind === "pdf" &&
          ref.path === (props.askPath ?? props.annotationPath) &&
          ref.fingerprint === item.fingerprint,
      )
      if (!ref || ref.kind !== "pdf" || !props.onReferenceEdit) return
      const base = {
        action: "ask" as const,
        selectionDocument: item.selectionDocument,
        document: item.document,
        version: item.version,
        selection: ref.selection,
        fingerprint: item.fingerprint,
        reference: ref.id,
        rect: item.rect,
      }
      select(
        ref.content === "image"
          ? { ...base, page: ref.startPage, imageDataUrl: ref.image ?? "" }
          : { ...base, startPage: ref.startPage, endPage: ref.endPage, text: ref.text },
      )
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

    if (event.data.type === "textselectionaction" || event.data.type === "imageselectionaction") {
      select(event.data)
      return
    }
    if (event.data.type === "askcancel") {
      if (event.data.selectionDocument === ask()?.selectionDocument) closeAsk()
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
      persist(event.data.annotations, event.data)
      return
    }

    if (event.data.type === "exportannotations") {
      if (!matches(loaded(), event.data)) return
      void exportPdf().catch((err) => {
        showToast({ variant: "error", title: language.t("pdf.annotation.exportFailed"), description: String(err) })
      })
      return
    }

    if (event.data.type === "reloadannotations") {
      const source = loaded()
      if (!source || !matches(source, event.data)) return
      const ctx = record()
      if (ctx?.entry.pending) return
      if (!ctx) return
      const data = ctx.entry.queue.data
      const id = serial
      void fetch(endpoint(source), { headers: headers() })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Failed to reload PDF annotations (${res.status})`)
          return res.json() as Promise<PdfAnnotations>
        })
        .then((result) => {
          if (id !== serial || record() !== ctx || ctx.entry.pending || ctx.entry.queue.data !== data) return
          if (result.status !== "ready") throw new Error("The saved annotations no longer match this PDF.")
          ctx.entry.revision = result.revision
          ctx.entry.queue.reset(result.data)
          setAnnotations(result.data)
          post({
            channel: "aether-pdf-viewer",
            type: "annotations",
            ...source,
            annotations: result.data.annotations,
            reset: true,
          })
          window.dispatchEvent(
            new CustomEvent("aether:pdf-annotations", {
              detail: { channel, key: ctx.key, reset: true },
            }),
          )
        })
        .catch((err) => {
          if (id === serial)
            showToast({ variant: "error", title: "Failed to reload PDF annotations", description: String(err) })
        })
    }
  }

  window.addEventListener("message", onMessage)
  onCleanup(() => {
    serial++
    props.onBusyChange?.(false)
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
              if (
                item.selectionDocument !== selectionDocument() ||
                (item.fingerprint && item.fingerprint !== fingerprint())
              )
                return closeAsk()
              if (item.reference) {
                if (previous()?.id === item.reference) props.onReferenceEdit?.(item.reference, question)
                return closeAsk()
              }
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
