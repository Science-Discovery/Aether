import { createMemo, createEffect, createSignal, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import {
  type LayoutVariant,
  type ReadingLayoutMode,
  CHAT_RATIO_BOUNDS,
  FILE_TREE_RATIOS,
  getReadingLayoutMode,
  getReadingLayoutVariant,
  PDF_RATIO_BOUNDS,
  VARIANT_DEFAULTS,
} from "@/pages/session/reading-layout"

type Options = {
  active: Accessor<boolean>
  reviewOpen: Accessor<boolean>
  fileTreeOpen: Accessor<boolean>
  layoutSwapped: Accessor<boolean>
}

export function useQuickReadingLayout(options: Options) {
  const [panel, setPanel] = createStore({
    pdfRatio: VARIANT_DEFAULTS["two-pane"].pdf,
    chatRatio: VARIANT_DEFAULTS["two-pane"].chat,
  })
  const [rowRef, setRowRef] = createSignal<HTMLDivElement>()
  const [rowWidth, setRowWidth] = createSignal(0)

  const variant = createMemo<LayoutVariant>(() => getReadingLayoutVariant(options.reviewOpen(), options.fileTreeOpen()))
  const layoutMode = createMemo<ReadingLayoutMode>(() => getReadingLayoutMode(variant(), options.layoutSwapped()))
  const totalWidth = createMemo(() => {
    const width = rowWidth()
    if (width > 0) return width
    if (typeof window !== "undefined") return window.innerWidth
    return 1280
  })
  const fileTreeRatio = createMemo(() => FILE_TREE_RATIOS[variant()])
  const pdfRatio = createMemo(() => panel.pdfRatio)
  const chatRatio = createMemo(() => {
    switch (layoutMode()) {
      case "two-left":
      case "two-right":
        return Math.max(0, 1 - pdfRatio())
      case "tree-left":
      case "tree-right":
        return Math.max(0, 1 - pdfRatio() - fileTreeRatio())
      default:
        return panel.chatRatio
    }
  })
  const compositeRatio = createMemo(() => pdfRatio() + chatRatio())
  const reviewRatio = createMemo(() => {
    switch (layoutMode()) {
      case "two-left":
      case "two-right":
      case "tree-left":
      case "tree-right":
        return 0
      default:
        return Math.max(0, 1 - pdfRatio() - chatRatio() - fileTreeRatio())
    }
  })
  const pdfPixelWidth = createMemo(() => Math.floor(totalWidth() * pdfRatio()))
  const chatPixelWidth = createMemo(() => Math.floor(totalWidth() * chatRatio()))
  const compositePixelWidth = createMemo(() => Math.floor(totalWidth() * compositeRatio()))
  const sidePanelWidth = createMemo(() => Math.floor(totalWidth() * Math.max(0, reviewRatio() + fileTreeRatio())))
  const fileTreePixelWidth = createMemo(() => Math.floor(totalWidth() * fileTreeRatio()))
  const pdfRatioBounds = createMemo(() => PDF_RATIO_BOUNDS[variant()])
  const chatRatioBounds = createMemo(() => CHAT_RATIO_BOUNDS[variant()])
  const pdfResizeBounds = createMemo(() => {
    const pdfBounds = pdfRatioBounds()
    const chatBounds = chatRatioBounds()
    switch (layoutMode()) {
      case "review-right":
      case "review-tree-right": {
        if (!chatBounds) return pdfBounds
        const composite = compositeRatio()
        return {
          min: Math.max(0, composite - chatBounds.max),
          max: Math.min(1, composite - chatBounds.min),
        }
      }
      default:
        return pdfBounds
    }
  })
  const compositeResizeBounds = createMemo(() => {
    const bounds = chatRatioBounds()
    if (!bounds || variant() === "two-pane" || variant() === "tree") {
      return { min: compositePixelWidth(), max: compositePixelWidth() }
    }
    const pdfBounds = pdfRatioBounds()
    const total = totalWidth()
    switch (layoutMode()) {
      case "review-left":
      case "review-tree-left":
        return {
          min: Math.floor((pdfRatio() + bounds.min) * total),
          max: Math.floor((pdfRatio() + bounds.max) * total),
        }
      default:
        return {
          min: Math.floor((chatRatio() + pdfBounds.min) * total),
          max: Math.floor((chatRatio() + pdfBounds.max) * total),
        }
    }
  })
  const sessionResizeBounds = createMemo(() => {
    const bounds = chatRatioBounds()
    if (!bounds || (layoutMode() !== "review-right" && layoutMode() !== "review-tree-right")) {
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

  createEffect(() => {
    if (!options.active()) return
    const preset = VARIANT_DEFAULTS[variant()]
    setPanel({ pdfRatio: preset.pdf, chatRatio: preset.chat })
  })

  createEffect(() => {
    const el = rowRef()
    if (!el) return
    setRowWidth(el.clientWidth)
  })

  createResizeObserver(rowRef, ({ width }) => {
    const next = Math.ceil(width)
    if (!Number.isFinite(next) || next <= 0) return
    setRowWidth(next)
  })

  const handleResizeWidth = (width: number) => {
    const total = totalWidth()
    if (total <= 0) return
    const nextPdf = Math.min(pdfResizeBounds().max, Math.max(pdfResizeBounds().min, width / total))
    switch (layoutMode()) {
      case "review-right":
      case "review-tree-right": {
        const bounds = chatRatioBounds()
        if (!bounds) return
        const nextChat = Math.min(bounds.max, Math.max(bounds.min, compositeRatio() - nextPdf))
        setPanel("chatRatio", nextChat)
        return
      }
      default:
        setPanel("pdfRatio", nextPdf)
        return
    }
  }

  const handleCompositeResize = (width: number) => {
    const total = totalWidth()
    const bounds = chatRatioBounds()
    if (total <= 0 || !bounds) return
    const nextComposite = Math.min(
      compositeResizeBounds().max / total,
      Math.max(compositeResizeBounds().min / total, width / total),
    )
    switch (layoutMode()) {
      case "review-left":
      case "review-tree-left": {
        const nextChat = Math.min(bounds.max, Math.max(bounds.min, nextComposite - pdfRatio()))
        setPanel("chatRatio", nextChat)
        return
      }
      case "review-right":
      case "review-tree-right": {
        const nextBounds = pdfRatioBounds()
        const nextPdf = Math.min(nextBounds.max, Math.max(nextBounds.min, nextComposite - chatRatio()))
        setPanel("pdfRatio", nextPdf)
        return
      }
      default:
        return
    }
  }

  const handleSessionResize = (width: number) => {
    const total = totalWidth()
    const bounds = chatRatioBounds()
    if (total <= 0 || !bounds) return
    if (layoutMode() !== "review-right" && layoutMode() !== "review-tree-right") return
    const nextChat = Math.min(bounds.max, Math.max(bounds.min, width / total))
    setPanel("chatRatio", nextChat)
  }

  return {
    setRowRef,
    rowWidth,
    variant,
    layoutMode,
    pdfPixelWidth,
    chatPixelWidth,
    compositePixelWidth,
    sidePanelWidth,
    fileTreePixelWidth,
    compositeResizeBounds,
    sessionResizeBounds,
    pdfMinWidth,
    pdfMaxWidth,
    handleResizeWidth,
    handleCompositeResize,
    handleSessionResize,
  }
}
