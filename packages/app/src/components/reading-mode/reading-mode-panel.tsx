import { type Component, createMemo, onMount, createEffect, createSignal, onCleanup } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { createStore } from "solid-js/store"
import { ReadingPdfViewer } from "./reading-pdf-viewer"
import { PdfToolbar } from "./pdf-toolbar"
import { useReadingMode } from "@/context/reading-mode"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { useGlobalSync } from "@/context/global-sync"
import { sendFollowupDraft } from "@/components/prompt-input/submit"
import { createSizing } from "@/pages/session/helpers"

const DEFAULT_PDF_WIDTH = 0.55 // 55% default

type PanelStore = {
  pdfWidth: number // fraction 0..1
}

export const ReadingModePanel: Component<{
  sessionID: string
  /** Right-side slot: the chat UI */
  children?: import("solid-js").JSX.Element
}> = (props) => {
  const rm = useReadingMode()
  const sdk = useSDK()
  const sync = useSync()
  const prompt = usePrompt()
  const local = useLocal()
  const globalSync = useGlobalSync()
  const [annotationsReady, setAnnotationsReady] = createSignal(false)
  const [annotationBase, setAnnotationBase] = createSignal<{ pdfStorePath: string; bookmarks: unknown[] } | null>(null)
  const [containerWidth, setContainerWidth] = createSignal(0)
  const size = createSizing()

  const [panel, setPanel] = createStore<PanelStore>({
    pdfWidth: DEFAULT_PDF_WIDTH,
  })

  let containerRef: HTMLDivElement | undefined

  const pdfUrl = createMemo(() => {
    const base = sdk.url
    return `${base}/reading-mode/pdf?sessionID=${encodeURIComponent(props.sessionID)}`
  })

  const pdfPixelWidth = createMemo(() => {
    const width = containerWidth()
    if (width <= 0) return 0
    return Math.floor(panel.pdfWidth * width)
  })

  const maxPdfWidth = createMemo(() => {
    const width = containerWidth()
    if (width <= 0) return 1000
    return Math.max(300, Math.floor(width * 0.8))
  })

  createEffect(() => {
    const info = sync.session.get(props.sessionID)
    const meta = info?.readingMode
    if (meta) {
      rm.setSessionMeta(meta)
    }
  })

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  createEffect(() => {
    const page = rm.store.currentPage
    const annotations = rm.store.annotations
    const base = annotationBase()
    const sessionID = props.sessionID
    if (!annotationsReady() || !base) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await sdk.client.readingMode.annotations.update({
          sessionID,
          data: {
            version: "1.0",
            pdfStorePath: base.pdfStorePath,
            annotations,
            bookmarks: base.bookmarks,
            lastReadPage: page,
          },
        })
      } catch {
        // non-critical, ignore
      }
    }, 1000)
  })

  // Restore last read page on mount
  onMount(async () => {
    const syncWidth = () => {
      if (!containerRef) return
      setContainerWidth(containerRef.clientWidth)
    }

    syncWidth()
    const observer = new ResizeObserver(syncWidth)
    if (containerRef) observer.observe(containerRef)
    onCleanup(() => observer.disconnect())

    try {
      const result = await sdk.client.readingMode.annotations.get({
        sessionID: props.sessionID,
      })
      const data = result.data as Record<string, unknown> | null | undefined
      if (data && typeof data.lastReadPage === "number") {
        rm.setPage(data.lastReadPage)
      }
      rm.setAnnotations(Array.isArray(data?.annotations) ? (data.annotations as any) : [])
      setAnnotationBase({
        pdfStorePath: typeof data?.pdfStorePath === "string" ? data.pdfStorePath : rm.store.sessionMeta?.pdfStorePath ?? "",
        bookmarks: Array.isArray(data?.bookmarks) ? data.bookmarks : [],
      })
      setAnnotationsReady(true)
    } catch {
      // ignore
    }
  })

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
  })

  createEffect(() => {
    const action = rm.store.pendingAction
    if (!action) return

    rm.setPendingAction(null)

    if (action.kind === "compose") {
      prompt.set([{ type: "text", content: action.text, start: 0, end: action.text.length }], action.cursor)
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) return

    void sendFollowupDraft({
      client: sdk.client,
      globalSync,
      sync,
      draft: {
        sessionID: props.sessionID,
        sessionDirectory: sdk.directory,
        prompt: [{ type: "text", content: action.text, start: 0, end: action.text.length }],
        context: [],
        agent: currentAgent.name,
        model: {
          providerID: currentModel.provider.id,
          modelID: currentModel.id,
        },
        variant: local.model.variant.current(),
      },
    }).then((ok) => {
      if (!ok) return
      if (action.source !== "first-read") return
      const meta = rm.store.sessionMeta
      if (!meta || meta.firstReadCompleted) return
      const next = { ...meta, firstReadCompleted: true }
      rm.setSessionMeta(next)
      void sdk.client.readingMode.session.update({
        sessionID: props.sessionID,
        firstReadCompleted: true,
      })
    })
  })

  return (
    <div
      ref={containerRef}
      class="relative flex size-full overflow-hidden"
    >
      {/* PDF panel */}
      <div
        class="relative shrink-0 overflow-visible"
        style={{ width: containerWidth() > 0 ? `${pdfPixelWidth()}px` : `${panel.pdfWidth * 100}%` }}
      >
        <div class="flex h-full flex-col overflow-hidden border-r border-border-base">
          <PdfToolbar />
          <div class="flex-1 min-h-0">
            <ReadingPdfViewer url={pdfUrl()} />
          </div>
        </div>

        {/* Resize handle */}
        <div class="absolute inset-y-0 right-0 z-10 w-0 overflow-visible" onPointerDown={() => size.start()}>
          <div class="pointer-events-none absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-border-base/80" />
          <ResizeHandle
            direction="horizontal"
            class="after:bg-border-base/90"
            size={pdfPixelWidth()}
            min={300}
            max={maxPdfWidth()}
            onResize={(w) => {
              const width = containerWidth()
              if (width <= 0) return
              size.touch()
              setPanel("pdfWidth", Math.min(0.85, Math.max(0.2, w / width)))
            }}
          />
        </div>
      </div>

      {/* Chat panel */}
      <div class="flex-1 min-w-0 flex flex-col overflow-hidden">
        {props.children}
      </div>
    </div>
  )
}
