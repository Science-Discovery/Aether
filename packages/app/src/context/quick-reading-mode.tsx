import { createContext, createEffect, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Persist, persisted } from "@/utils/persist"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"

export type QuickReadingSettings = {
  translatePrompt: string
  questionPrompt: string
  firstReadPrompt: string
  autoFirstRead: boolean
}

export type QuickReadingPendingQuestion =
  | {
      kind: "text-question"
      sessionID: string
      pdfPath: string
      pdfFileName: string
      page: number
      text: string
      createdAt: number
    }
  | {
      kind: "image-question"
      sessionID: string
      pdfPath: string
      pdfFileName: string
      page: number
      text: string
      imageDataUrl: string
      createdAt: number
    }
  | null

export type QuickReadingPersistedPdfState = {
  currentPage: number
  totalPages: number
  layoutSwapped: boolean
  settings: QuickReadingSettings
  firstReadCompleted: boolean
  firstReadDismissed: boolean
}

type QuickReadingPersistedState = {
  byPdfPath: Record<string, QuickReadingPersistedPdfState | undefined>
}

type QuickReadingBinding =
  | {
      sessionID: string
      pdfPath: string
      pdfFileName: string
    }
  | null

type QuickReadingSnapshot = QuickReadingPersistedPdfState

type Store = {
  binding: QuickReadingBinding
  snapshot: QuickReadingSnapshot
  pendingQuestion: QuickReadingPendingQuestion
  hydratedBindingKey?: string
}

type Ctx = {
  store: Store
  bind: (sessionID: string, pdfPath: string, pdfFileName: string) => void
  unbind: () => void
  setPage: (page: number) => void
  setTotalPages: (totalPages: number) => void
  setLayoutSwapped: (swapped: boolean) => void
  setPendingQuestion: (question: QuickReadingPendingQuestion) => void
  setSettings: (settings: QuickReadingSettings) => void
  setFirstReadCompleted: (value: boolean) => void
  setFirstReadDismissed: (value: boolean) => void
  clearTransientState: () => void
}

const QUICK_READING_DEFAULT_SETTINGS: QuickReadingSettings = {
  translatePrompt:
    "Please translate the selected content into Chinese. Keep technical terms in English when appropriate, preserve math expressions, and keep the original structure when possible.",
  questionPrompt:
    "The user is reading a PDF and selected content related to the current question. The selected content may be text or a captured image region.\n\n[Selected content]\n{selected_content}\n\n[User question]\n{user_question}\n\nAnswer clearly and accurately based on the selected content and the user question.",
  firstReadPrompt:
    "Please read this PDF first and summarize its main content, overall structure, and key ideas. The user may ask follow-up questions about specific parts later.",
  autoFirstRead: true,
}

function cloneQuickReadingSettings(input?: Partial<QuickReadingSettings> | null): QuickReadingSettings {
  return {
    translatePrompt: input?.translatePrompt ?? QUICK_READING_DEFAULT_SETTINGS.translatePrompt,
    questionPrompt: input?.questionPrompt ?? QUICK_READING_DEFAULT_SETTINGS.questionPrompt,
    firstReadPrompt: input?.firstReadPrompt ?? QUICK_READING_DEFAULT_SETTINGS.firstReadPrompt,
    autoFirstRead: input?.autoFirstRead ?? QUICK_READING_DEFAULT_SETTINGS.autoFirstRead,
  }
}

function createDefaultPersistedPdfState(): QuickReadingPersistedPdfState {
  return {
    currentPage: 1,
    totalPages: 0,
    layoutSwapped: true,
    settings: cloneQuickReadingSettings(),
    firstReadCompleted: false,
    firstReadDismissed: false,
  }
}

function createDefaultSnapshot(): QuickReadingSnapshot {
  return createDefaultPersistedPdfState()
}

function normalizePersistedPdfState(input?: Partial<QuickReadingPersistedPdfState> | null): QuickReadingPersistedPdfState {
  const fallback = createDefaultPersistedPdfState()
  const currentPage =
    typeof input?.currentPage === "number" && Number.isFinite(input.currentPage) && input.currentPage > 0
      ? Math.round(input.currentPage)
      : fallback.currentPage
  const totalPages =
    typeof input?.totalPages === "number" && Number.isFinite(input.totalPages) && input.totalPages >= 0
      ? Math.round(input.totalPages)
      : fallback.totalPages
  return {
    currentPage,
    totalPages,
    layoutSwapped: typeof input?.layoutSwapped === "boolean" ? input.layoutSwapped : fallback.layoutSwapped,
    settings: cloneQuickReadingSettings(input?.settings),
    firstReadCompleted:
      typeof input?.firstReadCompleted === "boolean" ? input.firstReadCompleted : fallback.firstReadCompleted,
    firstReadDismissed:
      typeof input?.firstReadDismissed === "boolean" ? input.firstReadDismissed : fallback.firstReadDismissed,
  }
}

function toSnapshot(input?: Partial<QuickReadingPersistedPdfState> | null): QuickReadingSnapshot {
  return normalizePersistedPdfState(input)
}

function toPersistedPdfState(snapshot: QuickReadingSnapshot): QuickReadingPersistedPdfState {
  return {
    currentPage: snapshot.currentPage,
    totalPages: snapshot.totalPages,
    layoutSwapped: snapshot.layoutSwapped,
    settings: cloneQuickReadingSettings(snapshot.settings),
    firstReadCompleted: snapshot.firstReadCompleted,
    firstReadDismissed: snapshot.firstReadDismissed,
  }
}

const QuickReadingModeContext = createContext<Ctx>()

export function QuickReadingModeProvider(props: ParentProps) {
  const params = useParams<{ id?: string }>()
  const sdk = useSDK()
  const { view } = useSessionLayout()
  const [persistedStore, setPersistedStore, , ready] = persisted(
    Persist.scoped(sdk.directory, params.id, "quick-reading-mode.v1"),
    createStore<QuickReadingPersistedState>({
      byPdfPath: {},
    }),
  )
  const [store, setStore] = createStore<Store>({
    binding: null,
    snapshot: createDefaultSnapshot(),
    pendingQuestion: null,
    hydratedBindingKey: undefined,
  })

  const bindingKey = () => {
    const binding = store.binding
    if (!binding) return
    return `${binding.sessionID}:${binding.pdfPath}`
  }

  const resolveLegacySeed = (pdfPath: string): QuickReadingPersistedPdfState => {
    const legacyPage = view().quickReading.page(pdfPath)
    const legacyLayoutSwapped = view().quickReading.layoutSwapped(pdfPath)
    return normalizePersistedPdfState({
      currentPage: legacyPage,
      layoutSwapped: legacyLayoutSwapped,
    })
  }

  const persistSnapshot = (pdfPath: string, snapshot: QuickReadingSnapshot) => {
    setPersistedStore("byPdfPath", pdfPath, toPersistedPdfState(snapshot))
  }

  const updateSnapshot = (updater: (current: QuickReadingSnapshot) => QuickReadingSnapshot, persist = true) => {
    const next = updater(store.snapshot)
    setStore("snapshot", next)
    const binding = store.binding
    if (persist && binding) {
      persistSnapshot(binding.pdfPath, next)
    }
  }

  const bind = (sessionID: string, pdfPath: string, pdfFileName: string) => {
    const nextKey = `${sessionID}:${pdfPath}`
    const persistedPdf = ready() ? persistedStore.byPdfPath[pdfPath] : undefined
    const nextSnapshot = persistedPdf ? toSnapshot(persistedPdf) : toSnapshot(resolveLegacySeed(pdfPath))

    setStore({
      binding: {
        sessionID,
        pdfPath,
        pdfFileName,
      },
      snapshot: nextSnapshot,
      hydratedBindingKey: ready() ? nextKey : undefined,
    })

    if (ready() && !persistedPdf) {
      persistSnapshot(pdfPath, nextSnapshot)
    }
  }

  const unbind = () => {
    setStore({
      binding: null,
      snapshot: createDefaultSnapshot(),
      hydratedBindingKey: undefined,
    })
  }

  createEffect(() => {
    const binding = store.binding
    const key = bindingKey()
    if (!binding || !key || !ready()) return
    if (store.hydratedBindingKey === key) return

    const persistedPdf = persistedStore.byPdfPath[binding.pdfPath]
    const nextSnapshot = persistedPdf ? toSnapshot(persistedPdf) : toSnapshot(resolveLegacySeed(binding.pdfPath))

    setStore("snapshot", nextSnapshot)
    setStore("hydratedBindingKey", key)

    if (!persistedPdf) {
      persistSnapshot(binding.pdfPath, nextSnapshot)
    }
  })

  const ctx: Ctx = {
    store,
    bind,
    unbind,
    setPage: (page) => {
      if (!Number.isFinite(page) || page < 1) return
      const nextPage = Math.round(page)
      if (store.snapshot.currentPage === nextPage) return
      updateSnapshot((current) => ({ ...current, currentPage: nextPage }))
    },
    setTotalPages: (totalPages) => {
      if (!Number.isFinite(totalPages) || totalPages < 0) return
      const nextTotalPages = Math.round(totalPages)
      if (store.snapshot.totalPages === nextTotalPages) return
      updateSnapshot((current) => ({ ...current, totalPages: nextTotalPages }))
    },
    setLayoutSwapped: (swapped) => {
      if (store.snapshot.layoutSwapped === swapped) return
      updateSnapshot((current) => ({ ...current, layoutSwapped: swapped }))
    },
    setPendingQuestion: (question) => {
      setStore("pendingQuestion", question)
    },
    setSettings: (settings) => {
      const nextSettings = cloneQuickReadingSettings(settings)
      updateSnapshot((current) => ({
        ...current,
        settings: nextSettings,
      }))
    },
    setFirstReadCompleted: (value) => {
      if (store.snapshot.firstReadCompleted === value) return
      updateSnapshot((current) => ({
        ...current,
        firstReadCompleted: value,
      }))
    },
    setFirstReadDismissed: (value) => {
      if (store.snapshot.firstReadDismissed === value) return
      updateSnapshot((current) => ({
        ...current,
        firstReadDismissed: value,
      }))
    },
    clearTransientState: () => {
      setStore("pendingQuestion", null)
    },
  }

  return <QuickReadingModeContext.Provider value={ctx}>{props.children}</QuickReadingModeContext.Provider>
}

export function useQuickReadingMode(): Ctx {
  const ctx = useContext(QuickReadingModeContext)
  if (!ctx) throw new Error("useQuickReadingMode must be used within QuickReadingModeProvider")
  return ctx
}

export function useMaybeQuickReadingMode(): Ctx | undefined {
  return useContext(QuickReadingModeContext)
}
