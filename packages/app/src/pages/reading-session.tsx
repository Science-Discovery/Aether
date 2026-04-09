import { type Component, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { ReadingModeProvider } from "@/context/reading-mode"
import { ReadingModePanel } from "@/components/reading-mode/reading-mode-panel"
import { TerminalProvider } from "@/context/terminal"
import { FileProvider } from "@/context/file"
import { PromptProvider } from "@/context/prompt"
import { CommentsProvider } from "@/context/comments"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSizing } from "@/pages/session/helpers"
import SessionPage from "./session"

type LayoutVariant = "two-pane" | "tree" | "review" | "review-tree"
type ReadingLayoutMode =
  | "two-left"
  | "two-right"
  | "tree-left"
  | "tree-right"
  | "review-left"
  | "review-right"
  | "review-tree-left"
  | "review-tree-right"

const LAYOUT_STORAGE_PREFIX = "aether-reading-layout:"
const VARIANT_DEFAULTS: Record<LayoutVariant, { pdf: number; chat: number }> = {
  "two-pane": { pdf: 0.55, chat: 0.45 },
  tree: { pdf: 0.5, chat: 0.35 },
  review: { pdf: 0.4, chat: 0.25 },
  "review-tree": { pdf: 0.4, chat: 0.25 },
}

const FILE_TREE_RATIOS: Record<LayoutVariant, number> = {
  "two-pane": 0,
  tree: 0.15,
  review: 0,
  "review-tree": 0.12,
}

const PDF_RATIO_BOUNDS: Record<LayoutVariant, { min: number; max: number }> = {
  "two-pane": { min: 0.3, max: 0.75 },
  tree: { min: 0.3, max: 0.6 },
  review: { min: 0.3, max: 0.45 },
  "review-tree": { min: 0.3, max: 0.4 },
}

const CHAT_RATIO_BOUNDS: Partial<Record<LayoutVariant, { min: number; max: number }>> = {
  review: { min: 0.25, max: 0.4 },
  "review-tree": { min: 0.25, max: 0.3 },
}

const ReadingSession: Component = () => {
  const params = useParams<{ id: string; dir?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const sdk = useSDK()
  const layout = useLayout()
  const { view } = useSessionLayout()

  const overridePdfUrl = createMemo(() => {
    const pdfPath = searchParams.pdf
    if (!pdfPath) return undefined
    return `${sdk.url}/file/raw?path=${encodeURIComponent(pdfPath)}&directory=${encodeURIComponent(sdk.directory)}`
  })

  const handleCloseReadingMode = () => {
    navigate(`/${encodeURIComponent(params.dir ?? "")}/session/${params.id}`)
  }
  const [containerWidth, setContainerWidth] = createSignal(0)
  const [layoutSwapped, setLayoutSwapped] = createSignal(false)
  const [layoutReady, setLayoutReady] = createSignal(false)
  const sizing = createSizing()
  const [panel, setPanel] = createStore({
    pdfRatio: VARIANT_DEFAULTS["two-pane"].pdf,
    chatRatio: VARIANT_DEFAULTS["two-pane"].chat,
  })

  let containerRef: HTMLDivElement | undefined
  let previousReviewOpen = false
  let previousFileTreeOpen = false

  const storageKey = createMemo(() => `${LAYOUT_STORAGE_PREFIX}${params.id}`)
  const totalWidth = createMemo(() => {
    const width = containerWidth()
    if (width > 0) return width
    if (typeof window !== "undefined") return window.innerWidth
    return 1280
  })
  const reviewOpen = createMemo(() => layoutReady() && view().reviewPanel.opened())
  const fileTreeOpen = createMemo(() => layoutReady() && layout.fileTree.opened())
  const variant = createMemo<LayoutVariant>(() => {
    if (reviewOpen() && fileTreeOpen()) return "review-tree"
    if (reviewOpen()) return "review"
    if (fileTreeOpen()) return "tree"
    return "two-pane"
  })
  const mode = createMemo<ReadingLayoutMode>(() => {
    switch (variant()) {
      case "two-pane":
        return layoutSwapped() ? "two-right" : "two-left"
      case "tree":
        return layoutSwapped() ? "tree-right" : "tree-left"
      case "review":
        return layoutSwapped() ? "review-right" : "review-left"
      case "review-tree":
        return layoutSwapped() ? "review-tree-right" : "review-tree-left"
    }
  })

  const fileTreeRatio = createMemo(() => FILE_TREE_RATIOS[variant()])
  const pdfRatio = createMemo(() => panel.pdfRatio)
  const chatRatio = createMemo(() => {
    switch (mode()) {
      case "two-left":
      case "two-right":
        return Math.max(0, 1 - pdfRatio())
      case "tree-left":
      case "tree-right":
        return Math.max(0, 1 - pdfRatio() - fileTreeRatio())
      case "review-left":
      case "review-right":
      case "review-tree-left":
      case "review-tree-right":
        return panel.chatRatio
    }
  })
  const compositeRatio = createMemo(() => {
    switch (mode()) {
      case "two-left":
      case "two-right":
      case "tree-left":
      case "tree-right":
      case "review-left":
      case "review-right":
      case "review-tree-left":
      case "review-tree-right":
        return pdfRatio() + chatRatio()
    }
  })
  const reviewRatio = createMemo(() => {
    switch (mode()) {
      case "two-left":
      case "two-right":
      case "tree-left":
      case "tree-right":
        return 0
      case "review-left":
      case "review-right":
      case "review-tree-left":
      case "review-tree-right":
        return Math.max(0, 1 - pdfRatio() - chatRatio() - fileTreeRatio())
    }
  })

  const pdfPixelWidth = createMemo(() => Math.floor(totalWidth() * pdfRatio()))
  const chatPixelWidth = createMemo(() => Math.floor(totalWidth() * chatRatio()))
  const compositePixelWidth = createMemo(() => Math.floor(totalWidth() * compositeRatio()))
  const sidePanelWidth = createMemo(() => {
    return Math.floor(totalWidth() * Math.max(0, reviewRatio() + fileTreeRatio()))
  })
  const fileTreePixelWidth = createMemo(() => Math.floor(totalWidth() * fileTreeRatio()))
  const pdfRatioBounds = createMemo(() => PDF_RATIO_BOUNDS[variant()])
  const chatRatioBounds = createMemo(() => CHAT_RATIO_BOUNDS[variant()])
  const pdfResizeBounds = createMemo(() => {
    const pdfBounds = pdfRatioBounds()
    const chatBounds = chatRatioBounds()
    switch (mode()) {
      case "two-left":
      case "two-right":
      case "tree-left":
      case "tree-right":
      case "review-left":
      case "review-tree-left":
        return pdfBounds
      case "review-right":
      case "review-tree-right": {
        if (!chatBounds) return pdfBounds
        const composite = compositeRatio()
        return {
          min: Math.max(0, composite - chatBounds.max),
          max: Math.min(1, composite - chatBounds.min),
        }
      }
    }
  })
  const compositeResizeBounds = createMemo(() => {
    const bounds = chatRatioBounds()
    if (!bounds || variant() === "two-pane" || variant() === "tree") {
      return { min: compositePixelWidth(), max: compositePixelWidth() }
    }
    const pdfBounds = pdfRatioBounds()
    const total = totalWidth()
    switch (mode()) {
      case "review-left":
      case "review-tree-left":
        return {
          min: Math.floor((pdfRatio() + bounds.min) * total),
          max: Math.floor((pdfRatio() + bounds.max) * total),
        }
      case "review-right":
      case "review-tree-right":
        return {
          min: Math.floor((chatRatio() + pdfBounds.min) * total),
          max: Math.floor((chatRatio() + pdfBounds.max) * total),
        }
      default:
        return { min: compositePixelWidth(), max: compositePixelWidth() }
    }
  })
  const sessionResizeBounds = createMemo(() => {
    const bounds = chatRatioBounds()
    if (!bounds || (mode() !== "review-right" && mode() !== "review-tree-right")) {
      return { min: 0, max: 0 }
    }
    const total = totalWidth()
    return {
      min: Math.floor(bounds.min * total),
      max: Math.floor(bounds.max * total),
    }
  })
  const pdfMinWidth = createMemo(() => Math.floor(totalWidth() * pdfResizeBounds().min))
  const pdfMaxWidth = createMemo(() => Math.floor(totalWidth() * pdfResizeBounds().max))

  onMount(() => {
    try {
      const savedLayout = localStorage.getItem(storageKey())
      setLayoutSwapped(savedLayout ? savedLayout === "pdf-right" : true)
    } catch {}

    previousReviewOpen = view().reviewPanel.opened()
    previousFileTreeOpen = layout.fileTree.opened()

    if (previousReviewOpen) view().reviewPanel.close()
    if (previousFileTreeOpen) layout.fileTree.close()

    setLayoutReady(true)

    const syncWidth = () => {
      if (!containerRef) return
      setContainerWidth(containerRef.clientWidth)
    }

    syncWidth()
    const observer = new ResizeObserver(syncWidth)
    if (containerRef) observer.observe(containerRef)
    onCleanup(() => {
      observer.disconnect()
      if (previousReviewOpen) view().reviewPanel.open()
      else view().reviewPanel.close()
      if (previousFileTreeOpen) layout.fileTree.open()
      else layout.fileTree.close()
    })
  })

  createEffect(() => {
    if (!layoutReady()) return
    const preset = VARIANT_DEFAULTS[variant()]
    setPanel({
      pdfRatio: preset.pdf,
      chatRatio: preset.chat,
    })
  })

  createEffect(() => {
    if (!layoutReady()) return
    try {
      localStorage.setItem(storageKey(), layoutSwapped() ? "pdf-right" : "pdf-left")
    } catch {}
  })

  const handleSwapLayout = () => {
    setLayoutSwapped((value) => !value)
  }

  const handleResizeWidth = (width: number) => {
    const total = totalWidth()
    if (total <= 0) return
    const nextPdf = Math.min(pdfResizeBounds().max, Math.max(pdfResizeBounds().min, width / total))
    switch (mode()) {
      case "two-left":
      case "two-right":
      case "tree-left":
      case "tree-right":
      case "review-left":
      case "review-tree-left":
        setPanel("pdfRatio", nextPdf)
        return
      case "review-right":
      case "review-tree-right": {
        const nextChat = Math.min(chatRatioBounds()!.max, Math.max(chatRatioBounds()!.min, compositeRatio() - nextPdf))
        setPanel("chatRatio", nextChat)
        return
      }
    }
  }

  const handleResizeCompositeWidth = (width: number) => {
    const total = totalWidth()
    const bounds = chatRatioBounds()
    if (total <= 0 || !bounds) return
    const nextComposite = Math.min(compositeResizeBounds().max / total, Math.max(compositeResizeBounds().min / total, width / total))
    switch (mode()) {
      case "review-left":
      case "review-tree-left": {
        const nextChat = Math.min(bounds.max, Math.max(bounds.min, nextComposite - pdfRatio()))
        setPanel("chatRatio", nextChat)
        return
      }
      case "review-right":
      case "review-tree-right": {
        const pdfBounds = pdfRatioBounds()
        const nextPdf = Math.min(pdfBounds.max, Math.max(pdfBounds.min, nextComposite - chatRatio()))
        setPanel("pdfRatio", nextPdf)
        return
      }
      default:
        return
    }
  }

  const handleResizeSessionWidth = (width: number) => {
    const total = totalWidth()
    const bounds = chatRatioBounds()
    if (
      total <= 0 ||
      !bounds ||
      (mode() !== "review-right" && mode() !== "review-tree-right")
    ) {
      return
    }
    const nextChat = Math.min(bounds.max, Math.max(bounds.min, width / total))
    setPanel("chatRatio", nextChat)
  }

  return (
    <ReadingModeProvider>
      <TerminalProvider>
        <FileProvider>
          <PromptProvider>
            <CommentsProvider>
              <div ref={containerRef} class="size-full overflow-hidden">
                <SessionPage
                  readingPane={
                    <ReadingModePanel
                      sessionID={params.id!}
                      width={pdfPixelWidth()}
                      minWidth={pdfMinWidth()}
                      maxWidth={Math.max(pdfMinWidth(), pdfMaxWidth())}
                      layoutSwapped={layoutSwapped()}
                    onSwapLayout={handleSwapLayout}
                    onCloseReadingMode={handleCloseReadingMode}
                    onResizeWidth={handleResizeWidth}
                    resizeHandleEnabled={mode() !== "review-right" && mode() !== "review-tree-right"}
                    overridePdfUrl={overridePdfUrl()}
                    sizing={sizing}
                  />
                  }
                  readingPanePosition={layoutSwapped() ? "after" : "before"}
                  readingPaneWidth={pdfPixelWidth()}
                  readingCompositeWidth={compositePixelWidth()}
                  readingCompositeMinWidth={compositeResizeBounds().min}
                  readingCompositeMaxWidth={compositeResizeBounds().max}
                  onReadingCompositeResize={handleResizeCompositeWidth}
                  readingSessionResizeSize={chatPixelWidth()}
                  readingSessionResizeMin={sessionResizeBounds().min}
                  readingSessionResizeMax={sessionResizeBounds().max}
                  onReadingSessionResize={handleResizeSessionWidth}
                  readingReviewOpen={reviewOpen()}
                  readingFileTreeOpen={fileTreeOpen()}
                  readingSidePanelWidth={sidePanelWidth()}
                  readingFileTreeWidth={fileTreePixelWidth()}
                  readingFileTreeResizable={false}
                  readingSizing={sizing}
                />
              </div>
            </CommentsProvider>
          </PromptProvider>
        </FileProvider>
      </TerminalProvider>
    </ReadingModeProvider>
  )
}

export default ReadingSession
