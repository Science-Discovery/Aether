import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import * as pdfjsLib from "pdfjs-dist"
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist"
import { useReadingMode } from "@/context/reading-mode"

import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import cmapSentinel from "pdfjs-dist/cmaps/78-EUC-H.bcmap?url"
import fontSentinel from "pdfjs-dist/standard_fonts/FoxitFixed.pfb?url"

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const cMapUrl = cmapSentinel.slice(0, cmapSentinel.lastIndexOf("/") + 1)
const standardFontDataUrl = fontSentinel.slice(0, fontSentinel.lastIndexOf("/") + 1)
const PDF_DOC_PARAMS = { cMapUrl, cMapPacked: true, standardFontDataUrl }

// How many pages above/below viewport to keep rendered
const BUFFER = 3
// Max concurrent PDF.js render tasks
const MAX_TASKS = 3
// Gap between pages in px
const GAP = 12
// Top padding
const PAD = 8

// ─── Single-page viewer ───────────────────────────────────────────────────────

const SinglePageViewer: Component<{ doc: PDFDocumentProxy }> = (props) => {
  const rm = useReadingMode()
  let canvasRef: HTMLCanvasElement | undefined
  let containerRef: HTMLDivElement | undefined
  let task: RenderTask | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  async function render(n: number) {
    if (!canvasRef || !containerRef) return
    const page: PDFPageProxy = await props.doc.getPage(n)
    const dpr = window.devicePixelRatio || 1
    const w = containerRef.clientWidth || 800
    const base = page.getViewport({ scale: 1 })
    const ls = rm.store.fitWidth ? (w - 24) / base.width : rm.store.zoom
    const vp = page.getViewport({ scale: ls * dpr })
    // Ceil physical pixels and round CSS size to avoid subpixel blur
    const physW = Math.ceil(vp.width)
    const physH = Math.ceil(vp.height)
    const cssW  = Math.round(physW / dpr)
    const cssH  = Math.round(physH / dpr)

    const offscreen = document.createElement("canvas")
    offscreen.width  = physW
    offscreen.height = physH
    const offCtx = offscreen.getContext("2d")
    if (!offCtx) return
    if (task) { task.cancel(); task = null }
    task = page.render({ canvasContext: offCtx, viewport: vp, canvas: offscreen })
    try {
      await task.promise
      canvasRef.width  = physW
      canvasRef.height = physH
      canvasRef.style.width  = `${cssW}px`
      canvasRef.style.height = `${cssH}px`
      canvasRef.getContext("2d")!.drawImage(offscreen, 0, 0)
    }
    catch (e: unknown) { if ((e as { name?: string })?.name !== "RenderingCancelledException") console.error(e) }
    finally { task = null }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    const n = rm.store.currentPage
    void rm.store.zoom; void rm.store.fitWidth
    timer = setTimeout(() => render(n), 30)
  }
  createEffect(schedule)
  onMount(() => {
    requestAnimationFrame(() => render(rm.store.currentPage))
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown")
        rm.setPage(Math.min(rm.store.totalPages, rm.store.currentPage + 1))
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp")
        rm.setPage(Math.max(1, rm.store.currentPage - 1))
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })
  onCleanup(() => { if (timer) clearTimeout(timer); if (task) task.cancel() })

  return (
    <div ref={containerRef} class="size-full overflow-auto bg-surface-base flex flex-col items-center py-4"
      onWheel={(e) => {
        e.preventDefault()
        if (e.deltaY > 0) rm.setPage(Math.min(rm.store.totalPages, rm.store.currentPage + 1))
        else rm.setPage(Math.max(1, rm.store.currentPage - 1))
      }}>
      <canvas ref={canvasRef} class="shadow-lg"
        style={{ filter: rm.store.nightMode ? "invert(1) hue-rotate(180deg)" : undefined }} />
    </div>
  )
}

// ─── Continuous viewer ────────────────────────────────────────────────────────
//
// Design principles (to avoid memory explosion and flicker):
//
// 1. ONLY load page 1's dimensions upfront. Use that as the default height
//    for all pages. Pages with different heights get corrected after rendering.
//
// 2. DOM nodes: use a single absolutely-positioned container whose height
//    equals totalHeight. Only BUFFER*2+visible pages have actual DOM nodes.
//    Everything else is empty space.
//
// 3. Canvas pool: a small set of canvas elements that get repositioned and
//    re-rendered as the viewport moves. No canvas creation during scrolling.
//
// 4. All geometry uses a prefix-sum array (offsets[]) updated only when a
//    page's real height is discovered. Binary search gives O(log n) page
//    lookup from any scroll position.

const ContinuousViewer: Component<{ doc: PDFDocumentProxy }> = (props) => {
  const rm = useReadingMode()
  const [ready, setReady] = createSignal(false)

  const total = props.doc.numPages

  // Per-page height at scale=1 (default = page1Height until rendered)
  let pageHeights: Float32Array = new Float32Array(total)
  // Default page dimensions from page 1
  let defaultH = 841  // A4 in pts
  let defaultW = 595

  // Prefix sum: offsets[i] = top of page i+1 at scale=1
  // offsets has (total+1) entries; offsets[0] = PAD
  let offsets: Float64Array = new Float64Array(total + 1)

  function rebuildOffsets() {
    offsets[0] = PAD
    for (let i = 0; i < total; i++) {
      offsets[i + 1] = offsets[i] + pageHeights[i] + GAP
    }
  }

  // O(1) offset lookup (multiply by scale)
  function topOf(n: number) { return offsets[n - 1] * currentScale }
  function heightOf(i: number) { return Math.round(pageHeights[i] * currentScale) }
  function widthOf(i: number) {
    // All pages assumed same width as page 1; correct after render if needed
    return Math.round(defaultW * currentScale)
  }
  function totalH() { return offsets[total] * currentScale }

  // Binary search: index of first page whose bottom >= scrollPos (in scale=1 coords)
  function pageAtPos(scrollPos: number): number {
    const target = scrollPos / currentScale
    let lo = 0, hi = total - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] + pageHeights[mid] < target) lo = mid + 1
      else hi = mid
    }
    return lo  // 0-indexed
  }

  // Render state (all imperative, zero SolidJS signals involved)
  const canvases = new Map<number, HTMLCanvasElement>()  // pageNum → canvas
  const tasks    = new Map<number, RenderTask>()
  let queue: number[] = []
  let running = 0
  let currentScale = 1.0
  let rafId: number | null = null
  // Visible page range currently in DOM
  let domLo = 0, domHi = -1

  let containerRef: HTMLDivElement | undefined
  let innerRef: HTMLDivElement | undefined  // sized to totalH, holds page divs

  function currentNightFilter() {
    return rm.store.nightMode ? "invert(1) hue-rotate(180deg)" : ""
  }

  // ── canvas helpers ─────────────────────────────────────────────────────────

  function getOrCreateCanvas(n: number): HTMLCanvasElement {
    if (!canvases.has(n)) {
      const c = document.createElement("canvas")
      c.className = "shadow-lg block"
      c.style.filter = currentNightFilter()
      canvases.set(n, c)
    }
    return canvases.get(n)!
  }

  function destroyCanvas(n: number) {
    const c = canvases.get(n)
    if (!c) return
    if (c.parentElement) c.parentElement.removeChild(c)
    // Clear the canvas to free GPU memory
    c.width = 1; c.height = 1
    canvases.delete(n)
    const t = tasks.get(n)
    if (t) { t.cancel(); tasks.delete(n) }
    queue = queue.filter(q => q !== n)
  }

  // ── page DOM slots ─────────────────────────────────────────────────────────
  // Each visible page gets a positioned <div> that holds its canvas.
  // We keep a Map of these divs; slots outside [domLo,domHi] are removed.

  const slots = new Map<number, HTMLDivElement>()

  function ensureSlot(n: number) {
    if (slots.has(n)) {
      // Update position in case scale changed
      const div = slots.get(n)!
      div.style.top = `${topOf(n)}px`
      div.style.height = `${heightOf(n - 1)}px`
      return
    }
    const div = document.createElement("div")
    div.style.position = "absolute"
    div.style.left = "0"; div.style.right = "0"
    div.style.display = "flex"; div.style.justifyContent = "center"
    div.style.top = `${topOf(n)}px`
    div.style.height = `${heightOf(n - 1)}px`
    slots.set(n, div)
    innerRef?.appendChild(div)
    // Attach canvas if it exists
    const c = canvases.get(n)
    if (c && !c.parentElement) div.appendChild(c)
  }

  function removeSlot(n: number) {
    const div = slots.get(n)
    if (div?.parentElement) div.parentElement.removeChild(div)
    slots.delete(n)
  }

  // ── render pipeline ────────────────────────────────────────────────────────

  async function renderPage(n: number) {
    if (!canvases.has(n)) { running--; drain(); return }

    const existing = tasks.get(n)
    if (existing) { existing.cancel(); tasks.delete(n) }

    let page: PDFPageProxy
    try { page = await props.doc.getPage(n) }
    catch { running--; drain(); return }

    if (!canvases.has(n)) { running--; page.cleanup(); drain(); return }

    const canvas = canvases.get(n)!
    const dpr = window.devicePixelRatio || 1
    const base1 = page.getViewport({ scale: 1 })
    const vp = page.getViewport({ scale: currentScale * dpr })
    // Ceil physical pixels and round CSS size to eliminate subpixel blur
    const physW = Math.ceil(vp.width)
    const physH = Math.ceil(vp.height)
    const cssW  = Math.round(physW / dpr)
    const cssH  = Math.round(physH / dpr)

    // If this page has a different natural height than assumed, update offsets
    if (Math.abs(base1.height - pageHeights[n - 1]) > 0.5) {
      pageHeights[n - 1] = base1.height
      rebuildOffsets()
      if (innerRef) innerRef.style.height = `${totalH()}px`
      for (const [sn, div] of slots) {
        div.style.top    = `${topOf(sn)}px`
        div.style.height = `${heightOf(sn - 1)}px`
      }
    }

    const offscreen = document.createElement("canvas")
    offscreen.width  = physW
    offscreen.height = physH
    const offCtx = offscreen.getContext("2d")
    if (!offCtx) { running--; page.cleanup(); drain(); return }

    const task = page.render({ canvasContext: offCtx, viewport: vp, canvas: offscreen })
    tasks.set(n, task)
    try {
      await task.promise
      if (!canvases.has(n)) return
      canvas.width  = physW
      canvas.height = physH
      canvas.style.width  = `${cssW}px`
      canvas.style.height = `${cssH}px`
      canvas.style.filter = currentNightFilter()
      canvas.getContext("2d")!.drawImage(offscreen, 0, 0)
    }
    catch (e: unknown) { if ((e as { name?: string })?.name !== "RenderingCancelledException") console.error(e) }
    finally { tasks.delete(n); page.cleanup(); running--; drain() }
  }

  function enqueue(pages: number[]) {
    const inQ = new Set(queue)
    // Insert closest-to-viewport pages at front
    for (let i = pages.length - 1; i >= 0; i--) {
      const n = pages[i]
      if (!inQ.has(n) && !tasks.has(n) && canvases.has(n)) { queue.unshift(n); inQ.add(n) }
    }
    drain()
  }

  function drain() {
    while (running < MAX_TASKS && queue.length > 0) {
      const n = queue.shift()!
      if (!canvases.has(n)) continue
      running++
      renderPage(n)
    }
  }

  // ── viewport management ────────────────────────────────────────────────────

  function updateViewport() {
    if (!containerRef || !ready()) return
    const scrollTop = containerRef.scrollTop
    const viewH     = containerRef.clientHeight

    // Compute render window [lo, hi] (1-indexed, inclusive)
    const winTop = Math.max(0, scrollTop - viewH * BUFFER)
    const winBot = scrollTop + viewH * (BUFFER + 1)
    const lo = pageAtPos(winTop) + 1
    let hi = lo
    while (hi < total && topOf(hi + 1) < winBot) hi++
    hi = Math.min(total, hi)

    // Remove pages that left the window
    for (let n = domLo; n <= domHi; n++) {
      if (n < lo || n > hi) {
        destroyCanvas(n)
        removeSlot(n)
      }
    }
    domLo = lo; domHi = hi

    // Add pages entering the window
    const toRender: number[] = []
    for (let n = lo; n <= hi; n++) {
      ensureSlot(n)
      if (!canvases.has(n)) {
        const c = getOrCreateCanvas(n)
        const slot = slots.get(n)
        if (slot && !c.parentElement) slot.appendChild(c)
        toRender.push(n)
      }
    }
    if (toRender.length > 0) {
      // Prioritize pages closest to viewport center
      const center = lo + Math.floor((hi - lo) / 2)
      toRender.sort((a, b) => Math.abs(a - center) - Math.abs(b - center))
      enqueue(toRender)
    }

    // Update current-page indicator
    const midPage = pageAtPos(scrollTop + viewH / 2) + 1
    if (rm.store.currentPage !== midPage) rm.setPage(midPage)
  }

  // ── scale ──────────────────────────────────────────────────────────────────

  function computeScale() {
    if (rm.store.fitWidth && containerRef) return (containerRef.clientWidth - 24) / defaultW
    return rm.store.zoom
  }

  function applyScale() {
    const s = computeScale()
    if (Math.abs(s - currentScale) < 0.001) return

    // Save current page BEFORE changing scale so we can restore scroll position
    const savedPage = rm.store.currentPage

    currentScale = s

    // Cancel all in-flight tasks
    for (const t of tasks.values()) t.cancel()
    tasks.clear(); queue = []; running = 0

    // Reposition inner container and slots
    if (innerRef) innerRef.style.height = `${totalH()}px`
    for (const [n, div] of slots) {
      div.style.top    = `${topOf(n)}px`
      div.style.height = `${heightOf(n - 1)}px`
    }

    // Restore scroll position to the same page (prevents page-jump on zoom)
    if (containerRef) containerRef.scrollTop = topOf(savedPage)

    // Re-render existing canvases at new scale
    const toRender = [...canvases.keys()].sort((a, b) => Math.abs(a - savedPage) - Math.abs(b - savedPage))
    enqueue(toRender)

    // Discover any newly visible pages
    updateViewport()
  }

  function scrollToPage(n: number) {
    if (!containerRef) return
    containerRef.scrollTop = topOf(n)
  }

  // ── init ───────────────────────────────────────────────────────────────────

  onMount(async () => {
    // Only load page 1 to get default dimensions — O(1), no memory explosion
    const pg1 = await props.doc.getPage(1)
    const vp1 = pg1.getViewport({ scale: 1 })
    defaultH = vp1.height
    defaultW = vp1.width
    pg1.cleanup()

    // Fill pageHeights with the default; real heights discovered on render
    pageHeights.fill(defaultH)
    rebuildOffsets()

    currentScale = computeScale()
    if (innerRef) innerRef.style.height = `${totalH()}px`
    setReady(true)
    updateViewport()

    const ro = new ResizeObserver(() => applyScale())
    if (containerRef) ro.observe(containerRef)
    onCleanup(() => ro.disconnect())

    const onScroll = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => { rafId = null; updateViewport() })
    }
    containerRef?.addEventListener("scroll", onScroll, { passive: true })
    onCleanup(() => containerRef?.removeEventListener("scroll", onScroll))

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      const n = rm.store.currentPage
      if (e.key === "ArrowDown" || e.key === "PageDown") scrollToPage(Math.min(total, n + 1))
      else if (e.key === "ArrowUp"   || e.key === "PageUp")   scrollToPage(Math.max(1, n - 1))
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  onCleanup(() => {
    for (const t of tasks.values()) t.cancel()
    if (rafId) cancelAnimationFrame(rafId)
  })

  // Zoom/fitWidth → re-scale
  createEffect(() => {
    void rm.store.zoom; void rm.store.fitWidth
    if (ready()) applyScale()
  })

  // Night mode → update all visible canvases immediately
  createEffect(() => {
    const f = rm.store.nightMode ? "invert(1) hue-rotate(180deg)" : ""
    for (const c of canvases.values()) c.style.filter = f
  })

  // Toolbar page jump
  let lastJumpPage = 1
  createEffect(() => {
    const n = rm.store.currentPage
    if (n === lastJumpPage || !ready() || !containerRef) return
    lastJumpPage = n
    const sv = containerRef.scrollTop
    const vh = containerRef.clientHeight
    const top = topOf(n)
    const bot = top + heightOf(n - 1)
    if (bot < sv || top > sv + vh) scrollToPage(n)
  })

  return (
    <div ref={containerRef} class="size-full overflow-y-auto overflow-x-hidden bg-surface-base">
      {/* innerRef is sized to totalH and holds all page slots */}
      <div ref={innerRef} style={{ position: "relative" }} />
    </div>
  )
}

// ─── Root viewer ──────────────────────────────────────────────────────────────

export const PdfViewer: Component<{ url: string }> = (props) => {
  const rm = useReadingMode()
  const [doc, setDoc]       = createSignal<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error,   setError  ] = createSignal<string | null>(null)

  createEffect(() => {
    const url = props.url
    if (!url) return
    setLoading(true); setError(null); setDoc(null)
    const task = pdfjsLib.getDocument({ url, ...PDF_DOC_PARAMS })
    task.promise
      .then((d) => { setDoc(d); rm.setTotalPages(d.numPages); setLoading(false) })
      .catch((e) => { setError(String(e?.message ?? "Failed to load PDF")); setLoading(false) })
    onCleanup(() => task.destroy())
  })

  return (
    <div class="size-full flex flex-col">
      <Show when={loading()}>
        <div class="flex-1 flex items-center justify-center text-text-muted text-sm">Loading PDF…</div>
      </Show>
      <Show when={error()}>
        <div class="flex-1 flex items-center justify-center text-red-400 text-sm p-4 text-center">{error()}</div>
      </Show>
      <Show when={doc()} keyed>
        {(d) => (
          <div class="flex-1 min-h-0">
            <Show when={rm.store.continuousMode} fallback={<SinglePageViewer doc={d} />}>
              <ContinuousViewer doc={d} />
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
