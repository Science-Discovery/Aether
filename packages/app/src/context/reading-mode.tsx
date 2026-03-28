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
  settings: ReadingModeSettings
  firstReadCompleted: boolean
}

type Store = {
  currentPage: number
  totalPages: number
  zoom: number
  fitWidth: boolean
  nightMode: boolean
  continuousMode: boolean // true = scroll through all pages, false = single page
  sessionMeta: ReadingModeSessionMeta | null
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
  }

  return <ReadingModeContext.Provider value={ctx}>{props.children}</ReadingModeContext.Provider>
}

export function useReadingMode(): Ctx {
  const ctx = useContext(ReadingModeContext)
  if (!ctx) throw new Error("useReadingMode must be used within ReadingModeProvider")
  return ctx
}
