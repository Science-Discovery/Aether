import { type Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import * as pdfjsLib from "pdfjs-dist"
import {
  EventBus,
  PDFLinkService,
  PDFSinglePageViewer as PdfJsSinglePageViewer,
  PDFViewer as PdfJsViewer,
  ScrollMode,
  SpreadMode,
} from "pdfjs-dist/web/pdf_viewer.mjs"
import { type ReadingHighlight, type ReadingHighlightColor, useReadingMode } from "@/context/reading-mode"
import { extractPageText } from "./pdf-text-layer"
import { renderAnnotationLayer } from "./pdf-annotation-layer"
import { SelectionPopup, type SelectionPopupState } from "./selection-popup"

import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import cmapSentinel from "pdfjs-dist/cmaps/78-EUC-H.bcmap?url"
import fontSentinel from "pdfjs-dist/standard_fonts/FoxitFixed.pfb?url"
import "pdfjs-dist/web/pdf_viewer.css"
import "./reading-pdf-viewer.css"

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const cMapUrl = cmapSentinel.slice(0, cmapSentinel.lastIndexOf("/") + 1)
const standardFontDataUrl = fontSentinel.slice(0, fontSentinel.lastIndexOf("/") + 1)
const PDF_DOC_PARAMS = { cMapUrl, cMapPacked: true, standardFontDataUrl }

type PDFDocumentProxy = any
type ViewerApi = InstanceType<typeof PdfJsViewer> | InstanceType<typeof PdfJsSinglePageViewer>
type NormalizedRect = SelectionPopupState["rects"][number]
type DocumentMetrics = {
  pageWidth: number
  pageHeight: number
}
type SelectionResult = {
  range: Range
  page: number
  text: string
  rects: NormalizedRect[]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clearSelection() {
  window.getSelection()?.removeAllRanges()
}

function getSelectionRects(range: Range) {
  return Array.from(range.getClientRects()).filter((item) => item.width > 0 && item.height > 0)
}

function getSelectionAnchor(range: Range) {
  const rects = getSelectionRects(range)
  if (rects.length === 0) {
    const rect = range.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      centerX: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
    }
  }

  const left = Math.min(...rects.map((rect) => rect.left))
  const right = Math.max(...rects.map((rect) => rect.right))
  const top = Math.min(...rects.map((rect) => rect.top))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return {
    centerX: left + (right - left) / 2,
    top,
    bottom,
  }
}

function findPageElement(root: HTMLDivElement, node: Node | null | undefined) {
  const element = node instanceof Element ? node : node?.parentElement
  if (!element) return null
  const page = element.closest(".page[data-page-number]")
  if (page instanceof HTMLDivElement && root.contains(page)) return page
  return null
}

function normalizeRects(pageElement: HTMLDivElement, rects: DOMRectList | DOMRect[]) {
  const pageRect = pageElement.getBoundingClientRect()
  if (pageRect.width <= 0 || pageRect.height <= 0) return []

  return Array.from(rects)
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => {
      const left = clamp((Math.max(rect.left, pageRect.left) - pageRect.left) / pageRect.width, 0, 1)
      const top = clamp((Math.max(rect.top, pageRect.top) - pageRect.top) / pageRect.height, 0, 1)
      const right = clamp((Math.min(rect.right, pageRect.right) - pageRect.left) / pageRect.width, 0, 1)
      const bottom = clamp((Math.min(rect.bottom, pageRect.bottom) - pageRect.top) / pageRect.height, 0, 1)
      return { x1: left, y1: top, x2: right, y2: bottom }
    })
    .filter((rect) => rect.x2 > rect.x1 && rect.y2 > rect.y1)
}

function createHighlight(page: number, color: ReadingHighlightColor, text: string, rects: NormalizedRect[]): ReadingHighlight {
  return {
    id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "highlight",
    page,
    color,
    rects,
    selectedText: text,
    note: "",
    createdAt: Date.now(),
  }
}

async function extractDocumentMetrics(doc: PDFDocumentProxy): Promise<DocumentMetrics> {
  const page = await doc.getPage(1)
  try {
    const viewport = page.getViewport({ scale: 1 })
    return {
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    }
  } finally {
    page.cleanup?.()
  }
}

function groupAnnotations(annotations: ReadingHighlight[]) {
  const grouped = new Map<number, ReadingHighlight[]>()
  for (const annotation of annotations) {
    const list = grouped.get(annotation.page)
    if (list) list.push(annotation)
    else grouped.set(annotation.page, [annotation])
  }
  return grouped
}

function syncAnnotationPage(viewer: ViewerApi, pageNumber: number, grouped: Map<number, ReadingHighlight[]>) {
  const pageView = viewer.getPageView(pageNumber - 1)
  const pageElement = pageView?.div
  if (!(pageElement instanceof HTMLDivElement)) return
  renderAnnotationLayer(pageElement, grouped.get(pageNumber) ?? [])
}

function syncAnnotations(viewer: ViewerApi, annotations: ReadingHighlight[]) {
  const grouped = groupAnnotations(annotations)
  for (let pageNumber = 1; pageNumber <= viewer.pagesCount; pageNumber++) {
    syncAnnotationPage(viewer, pageNumber, grouped)
  }
}

async function buildContextPages(doc: PDFDocumentProxy, page: number, range: 0 | 1 | 2) {
  const start = Math.max(1, page - range)
  const end = Math.min(doc.numPages, page + range)
  const pages: string[] = []

  for (let current = start; current <= end; current++) {
    const text = await extractPageText(await doc.getPage(current))
    pages.push(`[Page ${current}]\n${text || "(no text extracted from this page)"}`)
  }

  return pages.join("\n\n")
}

async function buildQuestionDraft(
  doc: PDFDocumentProxy,
  page: number,
  selectedText: string,
  settings: NonNullable<ReturnType<typeof useReadingMode>["store"]["sessionMeta"]>["settings"],
) {
  const placeholder = "(write your question here before sending)"
  const contextPages = await buildContextPages(doc, page, settings.contextPageRange)
  return settings.questionPrompt
    .replace("{selected_content}", selectedText)
    .replace("{user_question}", placeholder)
    .replace("{context_pages}", contextPages)
}

async function buildFirstReadPrompt(doc: PDFDocumentProxy, fileName: string, prompt: string) {
  const limit = Math.min(doc.numPages, 20)
  const pages: string[] = []

  for (let page = 1; page <= limit; page++) {
    const text = await extractPageText(await doc.getPage(page))
    pages.push(`[Page ${page}]\n${text || "(no text extracted from this page)"}`)
  }

  const suffix =
    doc.numPages > limit ? `\n\nNote: the file has ${doc.numPages} pages; only the first ${limit} are included here.` : ""
  return `${prompt}\n\nBelow is the content of PDF "${fileName}" (pages 1-${limit}):\n\n${pages.join("\n\n")}${suffix}`
}
function createSelectionController(input: {
  getDoc: () => PDFDocumentProxy | null
  root: () => HTMLDivElement | undefined
  addHighlight: (page: number, color: ReadingHighlightColor, text: string, rects: NormalizedRect[]) => void
}) {
  const rm = useReadingMode()
  const [popup, setPopup] = createSignal<SelectionPopupState | null>(null)
  const [highlightOpen, setHighlightOpen] = createSignal(false)

  const hidePopup = () => {
    setPopup(null)
    setHighlightOpen(false)
  }

  const currentSelection = (): SelectionResult | null => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

    const root = input.root()
    if (!root) return null

    const range = selection.getRangeAt(0)
    const pageElement =
      findPageElement(root, range.commonAncestorContainer) ??
      findPageElement(root, selection.anchorNode) ??
      findPageElement(root, selection.focusNode)
    if (!pageElement) return null

    const page = Number(pageElement.dataset.pageNumber ?? 0)
    const text = selection.toString().trim()
    const rects = normalizeRects(pageElement, range.getClientRects())
    if (!page || !text || rects.length === 0) return null

    return { range, page, text, rects }
  }

  const updatePopup = () => {
    const current = currentSelection()
    if (!current) {
      hidePopup()
      return
    }

    const anchor = getSelectionAnchor(current.range)
    if (!anchor) {
      hidePopup()
      return
    }

    const menuWidth = 240
    const menuHeight = 40
    const halfWidth = menuWidth / 2
    const x = clamp(anchor.centerX, halfWidth + 8, Math.max(halfWidth + 8, window.innerWidth - halfWidth - 8))
    let y = anchor.bottom + 8
    if (y + menuHeight > window.innerHeight) y = anchor.top - menuHeight - 8
    y = clamp(y, 8, Math.max(8, window.innerHeight - menuHeight - 8))

    setPopup({
      text: current.text,
      page: current.page,
      rects: current.rects,
      x,
      y,
    })
    setHighlightOpen(false)
  }

  return {
    popup,
    highlightOpen,
    setHighlightOpen,
    hidePopup,
    updatePopup,
    refresh() {
      if (!popup()) return
      updatePopup()
    },
    copy: async () => {
      const text = currentSelection()?.text ?? popup()?.text
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // ignore clipboard errors
      }
      clearSelection()
      hidePopup()
    },
    translate: () => {
      const current = currentSelection() ?? popup()
      const meta = rm.store.sessionMeta
      if (!current || !meta) return
      rm.setPendingAction({
        kind: "send",
        source: "translate",
        text: `${meta.settings.translatePrompt}\n\n${current.text}`,
      })
      clearSelection()
      hidePopup()
    },
    ask: async () => {
      const current = currentSelection() ?? popup()
      const doc = input.getDoc()
      const meta = rm.store.sessionMeta
      if (!current || !doc || !meta) return
      const text = await buildQuestionDraft(doc, current.page, current.text, meta.settings)
      const marker = "(write your question here before sending)"
      rm.setPendingAction({
        kind: "compose",
        source: "ask",
        text,
        cursor: Math.max(0, text.indexOf(marker)),
      })
      clearSelection()
      hidePopup()
    },
    highlight: (color: ReadingHighlightColor) => {
      const current = currentSelection() ?? popup()
      if (!current || current.rects.length === 0) return
      input.addHighlight(current.page, color, current.text, current.rects)
      clearSelection()
      hidePopup()
    },
  }
}

function computeFitWidthScale(container: HTMLDivElement | undefined, metrics: DocumentMetrics | null) {
  if (!container || !metrics) return null
  const availableWidth = Math.max(320, Math.round(container.clientWidth - 24))
  return clamp(availableWidth / metrics.pageWidth, 0.25, 4)
}

function applyViewerState(
  viewer: ViewerApi,
  page: number,
  fitWidth: boolean,
  zoom: number,
  container: HTMLDivElement | undefined,
  metrics: DocumentMetrics | null,
) {
  const targetPage = clamp(page, 1, Math.max(1, viewer.pagesCount))
  if (viewer.currentPageNumber !== targetPage) {
    viewer.currentPageNumber = targetPage
  }

  const targetScale = fitWidth ? (computeFitWidthScale(container, metrics) ?? zoom) : zoom
  if (Math.abs(viewer.currentScale - targetScale) > 0.001 || viewer.currentScaleValue === "page-width") {
    viewer.currentScale = targetScale
  }
}

export const ReadingPdfViewer: Component<{ url: string }> = (props) => {
  const rm = useReadingMode()
  const [doc, setDoc] = createSignal<PDFDocumentProxy | null>(null)
  const [metrics, setMetrics] = createSignal<DocumentMetrics | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [firstReadTriggered, setFirstReadTriggered] = createSignal(false)

  let containerRef: HTMLDivElement | undefined
  let viewerRef: HTMLDivElement | undefined

  let viewer: ViewerApi | null = null
  let storePageFromViewer: number | null = null
  let viewerCleanup: Array<() => void> = []
  let resizeObserver: ResizeObserver | null = null

  const controller = createSelectionController({
    getDoc: doc,
    root: () => containerRef,
    addHighlight: (page, color, text, rects) => {
      if (rects.length === 0) return
      rm.setAnnotations([...rm.store.annotations, createHighlight(page, color, text, rects)])
    },
  })

  const destroyViewer = () => {
    controller.hidePopup()
    resizeObserver?.disconnect()
    resizeObserver = null
    for (const cleanup of viewerCleanup) cleanup()
    viewerCleanup = []
    viewer?.cleanup()
    viewer = null
    viewerRef?.replaceChildren()
  }

  onMount(() => {
    const onMouseUp = () => setTimeout(() => controller.updatePopup(), 0)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("[data-reading-selection-popup='true']")) return
      if (!target?.closest(".textLayer")) controller.hidePopup()
    }
    const onSelectionChange = () => {
      const root = containerRef
      const selection = window.getSelection()
      const anchor = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement
      if (!root || !anchor || !root.contains(anchor)) {
        controller.hidePopup()
        return
      }
      requestAnimationFrame(() => controller.updatePopup())
    }
    const onScroll = () => controller.refresh()

    containerRef?.addEventListener("mouseup", onMouseUp)
    containerRef?.addEventListener("pointerdown", onPointerDown)
    containerRef?.addEventListener("scroll", onScroll, { passive: true })
    document.addEventListener("selectionchange", onSelectionChange)

    onCleanup(() => {
      containerRef?.removeEventListener("mouseup", onMouseUp)
      containerRef?.removeEventListener("pointerdown", onPointerDown)
      containerRef?.removeEventListener("scroll", onScroll)
      document.removeEventListener("selectionchange", onSelectionChange)
    })
  })
  createEffect(() => {
    const url = props.url
    if (!url) return
    setLoading(true)
    setError(null)
    setDoc(null)
    setMetrics(null)
    setFirstReadTriggered(false)

    const task = pdfjsLib.getDocument({ url, ...PDF_DOC_PARAMS })
    task.promise
      .then(async (loaded) => {
        const nextMetrics = await extractDocumentMetrics(loaded)
        setMetrics(nextMetrics)
        setDoc(loaded)
        rm.setTotalPages(loaded.numPages)
        setLoading(false)
      })
      .catch((err) => {
        setError(String(err?.message ?? "Failed to load PDF"))
        setLoading(false)
      })

    onCleanup(() => task.destroy())
  })

  createEffect(() => {
    const loaded = doc()
    const docMetrics = metrics()
    const continuous = rm.store.continuousMode
    if (!loaded || !docMetrics || !containerRef || !viewerRef) return

    destroyViewer()

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({
      eventBus,
      ignoreDestinationZoom: true,
    })
    const nextViewer: ViewerApi = continuous
      ? new PdfJsViewer({
          container: containerRef,
          viewer: viewerRef,
          eventBus,
          linkService,
          removePageBorders: false,
          enableDetailCanvas: false,
          maxCanvasPixels: 2 ** 28,
          minDurationToUpdateCanvas: 0,
        })
      : new PdfJsSinglePageViewer({
          container: containerRef,
          viewer: viewerRef,
          eventBus,
          linkService,
          removePageBorders: false,
          enableDetailCanvas: false,
          maxCanvasPixels: 2 ** 28,
          minDurationToUpdateCanvas: 0,
        })

    nextViewer.spreadMode = SpreadMode.NONE
    nextViewer.scrollMode = continuous ? ScrollMode.VERTICAL : ScrollMode.PAGE

    const listen = (name: string, handler: Function) => {
      eventBus.on(name, handler)
      viewerCleanup.push(() => eventBus.off(name, handler))
    }

    listen("pagesinit", () => {
      nextViewer.spreadMode = SpreadMode.NONE
      nextViewer.scrollMode = continuous ? ScrollMode.VERTICAL : ScrollMode.PAGE
      rm.setTotalPages(nextViewer.pagesCount)
      applyViewerState(nextViewer, rm.store.currentPage, rm.store.fitWidth, rm.store.zoom, containerRef, docMetrics)
      syncAnnotations(nextViewer, rm.store.annotations)
    })

    listen("pagechanging", (evt: { pageNumber?: number }) => {
      const pageNumber = evt.pageNumber
      if (!pageNumber) return
      storePageFromViewer = pageNumber
      if (pageNumber !== rm.store.currentPage) {
        rm.setPage(pageNumber)
      }
      controller.hidePopup()
    })

    listen("scalechanging", (evt: { scale?: number }) => {
      if (typeof evt.scale === "number" && Number.isFinite(evt.scale) && Math.abs(rm.store.zoom - evt.scale) > 0.001) {
        rm.setZoom(evt.scale)
      }
      const fitScale = computeFitWidthScale(containerRef, docMetrics)
      const fitWidth =
        rm.store.fitWidth &&
        typeof evt.scale === "number" &&
        fitScale !== null &&
        Math.abs(evt.scale - fitScale) < 0.01
      if (rm.store.fitWidth !== fitWidth) {
        rm.setFitWidth(fitWidth)
      }
      controller.hidePopup()
    })

    listen("pagerendered", (evt: { pageNumber?: number }) => {
      if (!evt.pageNumber) return
      syncAnnotationPage(nextViewer, evt.pageNumber, groupAnnotations(rm.store.annotations))
    })

    viewer = nextViewer
    linkService.setViewer(nextViewer)
    linkService.setDocument(loaded)
    nextViewer.setDocument(loaded)
    applyViewerState(nextViewer, rm.store.currentPage, rm.store.fitWidth, rm.store.zoom, containerRef, docMetrics)
    syncAnnotations(nextViewer, rm.store.annotations)

    void nextViewer.pagesPromise?.then(() => {
      if (viewer !== nextViewer) return
      syncAnnotations(nextViewer, rm.store.annotations)
    })

    resizeObserver = new ResizeObserver(() => {
      if (viewer !== nextViewer) return
      if (rm.store.fitWidth) {
        applyViewerState(nextViewer, nextViewer.currentPageNumber, true, rm.store.zoom, containerRef, docMetrics)
      }
      controller.refresh()
    })
    resizeObserver.observe(containerRef)

    onCleanup(() => {
      if (viewer === nextViewer) destroyViewer()
    })
  })
  createEffect(() => {
    const activeViewer = viewer
    const page = rm.store.currentPage
    if (!activeViewer?.pdfDocument) return
    const target = clamp(page, 1, Math.max(1, activeViewer.pagesCount))
    if (storePageFromViewer === target) {
      storePageFromViewer = null
      return
    }
    if (activeViewer.currentPageNumber !== target) {
      activeViewer.currentPageNumber = target
      controller.hidePopup()
    }
  })

  createEffect(() => {
    const activeViewer = viewer
    const docMetrics = metrics()
    const fitWidth = rm.store.fitWidth
    const zoom = rm.store.zoom
    if (!activeViewer?.pdfDocument || !docMetrics) return
    applyViewerState(activeViewer, activeViewer.currentPageNumber, fitWidth, zoom, containerRef, docMetrics)
  })

  createEffect(() => {
    const activeViewer = viewer
    const annotations = rm.store.annotations
    if (!activeViewer?.pdfDocument) return
    syncAnnotations(activeViewer, annotations)
  })

  createEffect(() => {
    const loaded = doc()
    const meta = rm.store.sessionMeta
    if (!loaded || !meta || firstReadTriggered()) return
    if (!meta.settings.autoFirstRead || meta.firstReadCompleted) return

    setFirstReadTriggered(true)
    void buildFirstReadPrompt(loaded, meta.pdfFileName, meta.settings.firstReadPrompt)
      .then((text) => {
        rm.setPendingAction({
          kind: "send",
          source: "first-read",
          text,
        })
      })
      .catch((err) => {
        console.error(err)
        setFirstReadTriggered(false)
      })
  })

  onCleanup(() => {
    destroyViewer()
  })

  return (
    <div class="reading-pdf-viewer-shell relative size-full" data-night={rm.store.nightMode ? "true" : "false"}>
      <div class="relative size-full">
        <div ref={containerRef} class="pdfViewerContainer absolute inset-0 overflow-auto bg-surface-base" tabindex={0}>
          <div ref={viewerRef} class="pdfViewer" />
        </div>

        <SelectionPopup
          popup={controller.popup()}
          highlightOpen={controller.highlightOpen()}
          onClose={controller.hidePopup}
          onHighlightMenu={() => controller.setHighlightOpen(!controller.highlightOpen())}
          onHighlight={controller.highlight}
          onTranslate={controller.translate}
          onAsk={controller.ask}
          onCopy={() => void controller.copy()}
        />

        <Show when={loading()}>
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-text-muted">
            Loading PDF...
          </div>
        </Show>

        <Show when={error()}>
          {(message) => (
            <div class="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-red-400">
              {message()}
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
