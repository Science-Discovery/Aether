import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type ReadingModeSettings = {
  translatePrompt: string
  questionPrompt: string
  firstReadPrompt: string
  contextPageRange: 0 | 1 | 2
  autoFirstRead: boolean
}

export type ReadingModeSessionMeta = {
  pdfFileName: string
  pdfStorePath: string
  lastReadPage: number
  annotationsPath: string
  source: {
    kind: "workspace-file" | "upload"
    path?: string
  }
  settings: ReadingModeSettings
  firstReadCompleted: boolean
  firstReadDismissed: boolean
}

export type ReadingHighlightColor = "yellow" | "red" | "green" | "blue"

export type ReadingHighlight = {
  id: string
  type: "highlight"
  page: number
  color: ReadingHighlightColor
  rects: Array<{ x1: number; y1: number; x2: number; y2: number }>
  selectedText: string
  note: string
  createdAt: number
}

export type ReadingPendingQuestion = {
  kind: "text-question"
  startPage: number
  endPage: number
  text: string
  createdAt: number
} | {
  kind: "image-question"
  page: number
  text: string
  imageDataUrl: string
  createdAt: number
} | null

type Store = {
  currentPage: number
  totalPages: number
  zoom: number
  fitWidth: boolean
  nightMode: boolean
  continuousMode: boolean // true = scroll through all pages, false = single page
  sessionMeta: ReadingModeSessionMeta | null
  annotations: ReadingHighlight[]
  pendingQuestion: ReadingPendingQuestion
}

type Ctx = {
  store: Store
  setPage: (page: number) => void
  setTotalPages: (n: number) => void
  setZoom: (z: number) => void
  setFitWidth: (v: boolean) => void
  setNightMode: (v: boolean) => void
  setContinuousMode: (v: boolean) => void
  setSessionMeta: (meta: ReadingModeSessionMeta | null) => void
  setAnnotations: (items: ReadingHighlight[]) => void
  setPendingQuestion: (question: ReadingPendingQuestion) => void
}

const ReadingModeContext = createContext<Ctx>()

export function ReadingModeProvider(props: ParentProps) {
  const [store, setStore] = createStore<Store>({
    currentPage: 1,
    totalPages: 0,
    zoom: 1.0,
    fitWidth: false, // default: 100% zoom, not fit-width
    nightMode: false,
    continuousMode: true,
    sessionMeta: null,
    annotations: [],
    pendingQuestion: null,
  })

  const ctx: Ctx = {
    store,
    setPage: (page) => setStore("currentPage", page),
    setTotalPages: (n) => setStore("totalPages", n),
    setZoom: (z) => setStore("zoom", z),
    setFitWidth: (v) => setStore("fitWidth", v),
    setNightMode: (v) => setStore("nightMode", v),
    setContinuousMode: (v) => setStore("continuousMode", v),
    setSessionMeta: (meta) => setStore("sessionMeta", meta),
    setAnnotations: (items) => setStore("annotations", items),
    setPendingQuestion: (question) => setStore("pendingQuestion", question),
  }

  return <ReadingModeContext.Provider value={ctx}>{props.children}</ReadingModeContext.Provider>
}

export function useReadingMode(): Ctx {
  const ctx = useContext(ReadingModeContext)
  if (!ctx) throw new Error("useReadingMode must be used within ReadingModeProvider")
  return ctx
}

export function useMaybeReadingMode(): Ctx | undefined {
  return useContext(ReadingModeContext)
}
