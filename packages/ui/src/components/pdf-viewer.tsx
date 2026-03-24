import { createEffect, createSignal, on, onCleanup, onMount, Show, type Component } from "solid-js"
import "./pdf-viewer.css"

export type PdfViewerProps = {
  /** PDF 文件的 Uint8Array 数据 */
  data: Uint8Array
  filename?: string
  class?: string
  onLoad?: () => void
  /** 额外的操作按钮 */
  actions?: () => import("solid-js").JSX.Element
  /** 在浏览器中打开的标签文字 */
  openLabel?: string
}

export const PdfViewer: Component<PdfViewerProps> = (props) => {
  let containerRef!: HTMLDivElement
  let canvasRef!: HTMLCanvasElement
  let textLayerRef!: HTMLDivElement

  const [numPages, setNumPages] = createSignal(0)
  const [currentPage, setCurrentPage] = createSignal(1)
  const [scale, setScale] = createSignal(1.2)
  const [pdfDoc, setPdfDoc] = createSignal<any>(null)
  const [rendering, setRendering] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [pageInput, setPageInput] = createSignal("")

  let pdfjsLib: typeof import("pdfjs-dist") | null = null
  let blobUrl: string | null = null

  const loadPdfJs = async () => {
    const lib = await import("pdfjs-dist")
    lib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href
    pdfjsLib = lib
    return lib
  }

  const renderPage = async (pageNum: number) => {
    const doc = pdfDoc()
    if (!doc || rendering()) return
    setRendering(true)

    try {
      const page = await doc.getPage(pageNum)
      const currentScale = scale()
      const viewport = page.getViewport({ scale: currentScale })

      // 渲染 canvas
      const canvas = canvasRef
      const ctx = canvas.getContext("2d")!
      const dpr = window.devicePixelRatio || 1
      canvas.width = viewport.width * dpr
      canvas.height = viewport.height * dpr
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      await page.render({ canvasContext: ctx, viewport }).promise

      // 渲染文字层 —— 必须设置 --total-scale-factor 否则文字尺寸为 0
      const textContent = await page.getTextContent()
      const textLayer = textLayerRef
      textLayer.innerHTML = ""
      // pdfjs 的 setLayerDimensions 用这个变量计算宽高和字体大小
      textLayer.style.setProperty("--total-scale-factor", `${currentScale}`)
      // 设置 scale-round 变量（防止 round() 报错）
      textLayer.style.setProperty("--scale-round-x", "1px")
      textLayer.style.setProperty("--scale-round-y", "1px")

      if (pdfjsLib) {
        const tl = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
        })
        await tl.render()
      }
    } catch (e) {
      console.error("PDF render error:", e)
    } finally {
      setRendering(false)
    }
  }

  onMount(async () => {
    try {
      const lib = await loadPdfJs()
      const loadingTask = lib.getDocument({ data: props.data.slice() })
      const doc = await loadingTask.promise
      setPdfDoc(doc)
      setNumPages(doc.numPages)
      setLoading(false)
      await renderPage(1)
      props.onLoad?.()
    } catch (e) {
      console.error("PDF load error:", e)
      setLoading(false)
    }
  })

  // 当页码或缩放变化时重新渲染
  createEffect(
    on([currentPage, scale], ([page]) => {
      if (pdfDoc()) {
        void renderPage(page)
      }
    }, { defer: true }),
  )

  onCleanup(() => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl)
      blobUrl = null
    }
  })

  const goPage = (delta: number) => {
    const next = currentPage() + delta
    if (next >= 1 && next <= numPages()) {
      setCurrentPage(next)
    }
  }

  const handlePageInput = (e: Event) => {
    e.preventDefault()
    const val = parseInt(pageInput(), 10)
    if (!isNaN(val) && val >= 1 && val <= numPages()) {
      setCurrentPage(val)
    }
    setPageInput("")
  }

  const openInBrowser = () => {
    if (!blobUrl) {
      const blob = new Blob([props.data.buffer as ArrayBuffer], { type: "application/pdf" })
      blobUrl = URL.createObjectURL(blob)
    }
    window.open(blobUrl)
  }

  const zoomIn = () => setScale((s) => Math.min(s + 0.2, 3))
  const zoomOut = () => setScale((s) => Math.max(s - 0.2, 0.4))

  return (
    <div class={`flex flex-col h-full ${props.class ?? ""}`}>
      {/* 工具栏 */}
      <div class="flex items-center justify-between gap-2 px-3 py-1.5 bg-background-base shrink-0">
        <div class="text-14-semibold text-text-strong truncate">{props.filename ?? "document.pdf"}</div>
        <div class="flex items-center gap-2 shrink-0">
          {props.actions?.()}
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
            onClick={openInBrowser}
          >
            {props.openLabel ?? "在浏览器中打开"}
          </button>
        </div>
      </div>
      {/* 导航栏 */}
      <div class="flex items-center justify-center gap-3 px-3 py-1 border-b border-border-weak-base bg-background-base shrink-0">
        <button
          type="button"
          class="px-1.5 py-0.5 text-14-medium rounded hover:bg-surface-raised-base-hover disabled:opacity-30 cursor-pointer disabled:cursor-default"
          disabled={currentPage() <= 1}
          onClick={() => goPage(-1)}
          title="上一页"
        >
          −
        </button>
        <div class="flex items-center gap-1">
          <input
            type="text"
            class="w-10 text-center text-12-regular border border-border-weak-base rounded px-1 py-0.5 bg-background-base text-text-base"
            value={pageInput() || String(currentPage())}
            onFocus={() => setPageInput(String(currentPage()))}
            onBlur={handlePageInput}
            onInput={(e) => setPageInput(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handlePageInput(e) }}
          />
          <span class="text-12-regular text-text-weak">/ {numPages()}</span>
        </div>
        <button
          type="button"
          class="px-1.5 py-0.5 text-14-medium rounded hover:bg-surface-raised-base-hover disabled:opacity-30 cursor-pointer disabled:cursor-default"
          disabled={currentPage() >= numPages()}
          onClick={() => goPage(1)}
          title="下一页"
        >
          +
        </button>
        <div class="w-px h-4 bg-border-weak-base" />
        <button
          type="button"
          class="px-1.5 py-0.5 text-12-medium rounded hover:bg-surface-raised-base-hover cursor-pointer"
          onClick={zoomOut}
          title="缩小"
        >
          −
        </button>
        <span class="text-11-regular text-text-weak tabular-nums min-w-[40px] text-center">
          {Math.round(scale() * 100)}%
        </span>
        <button
          type="button"
          class="px-1.5 py-0.5 text-12-medium rounded hover:bg-surface-raised-base-hover cursor-pointer"
          onClick={zoomIn}
          title="放大"
        >
          +
        </button>
      </div>
      {/* PDF 内容区 */}
      <Show
        when={!loading()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-text-weak text-14-regular">
            加载中...
          </div>
        }
      >
        <div ref={containerRef} class="flex-1 overflow-auto bg-background-stronger flex justify-center py-4">
          <div class="relative inline-block">
            <canvas ref={canvasRef} />
            <div
              ref={textLayerRef}
              class="textLayer"
              style={{ position: "absolute", top: "0", left: "0" }}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}
