import { createContext, createEffect, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useSDK } from "@/context/sdk"

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
      startPage: number
      endPage: number
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
  totalPages: number
  layoutSwapped: boolean
}

type PersistedState = {
  settings?: QuickReadingSettings
  byPdfPath: Record<string, QuickReadingPersistedPdfState | undefined>
}

type Binding =
  | {
      sessionID: string
      pdfPath: string
      pdfFileName: string
    }
  | null

type Snapshot = QuickReadingPersistedPdfState & {
  settings: QuickReadingSettings
}

type View = {
  pdfPath?: string
  page: number
  location?: string
}

type Store = {
  binding: Binding
  snapshot: Snapshot
  view: View
  pendingQuestion: QuickReadingPendingQuestion
  hydratedKey?: string
}

type Ctx = {
  store: Store
  bind: (sessionID: string, pdfPath: string, pdfFileName: string) => void
  unbind: () => void
  setPage: (page: number) => void
  setLocation: (location?: string) => void
  setTotalPages: (totalPages: number) => void
  setLayoutSwapped: (swapped: boolean) => void
  setPendingQuestion: (question: QuickReadingPendingQuestion) => void
  setSettings: (settings: QuickReadingSettings) => void
  clearTransientState: () => void
}

const DEFAULT_SETTINGS: QuickReadingSettings = {
  translatePrompt:
    "Please translate the selected content into Chinese. Keep technical terms in English when appropriate, preserve math expressions, and keep the original structure when possible.",
  questionPrompt:
    "The user is reading a PDF and selected content related to the current question. The selected content may be text or a captured image region.\n\n[Selected content]\n{selected_content}\n\n[User question]\n{user_question}\n\nAnswer clearly and accurately based on the selected content and the user question.",
  firstReadPrompt:
    "Please read this PDF first and summarize its main content, overall structure, and key ideas. The user may ask follow-up questions about specific parts later.",
  autoFirstRead: true,
}

function createView(): View {
  return {
    pdfPath: undefined,
    page: 1,
    location: undefined,
  }
}

function cloneSettings(input?: Partial<QuickReadingSettings> | null): QuickReadingSettings {
  return {
    translatePrompt: input?.translatePrompt ?? DEFAULT_SETTINGS.translatePrompt,
    questionPrompt: input?.questionPrompt ?? DEFAULT_SETTINGS.questionPrompt,
    firstReadPrompt: input?.firstReadPrompt ?? DEFAULT_SETTINGS.firstReadPrompt,
    autoFirstRead: input?.autoFirstRead ?? DEFAULT_SETTINGS.autoFirstRead,
  }
}

function createPdfState(): QuickReadingPersistedPdfState {
  return {
    totalPages: 0,
    layoutSwapped: true,
  }
}

function normalizePdfState(input?: Partial<QuickReadingPersistedPdfState> | null): QuickReadingPersistedPdfState {
  const fallback = createPdfState()
  return {
    totalPages:
      typeof input?.totalPages === "number" && Number.isFinite(input.totalPages) && input.totalPages >= 0
        ? Math.round(input.totalPages)
        : fallback.totalPages,
    layoutSwapped: typeof input?.layoutSwapped === "boolean" ? input.layoutSwapped : fallback.layoutSwapped,
  }
}

function legacySettings(store: PersistedState) {
  for (const item of Object.values(store.byPdfPath)) {
    if (!item || typeof item !== "object") continue
    const settings = (item as QuickReadingPersistedPdfState & { settings?: QuickReadingSettings }).settings
    if (settings) return cloneSettings(settings)
  }
}

const QuickReadingModeContext = createContext<Ctx>()

export function QuickReadingModeProvider(props: ParentProps) {
  const sdk = useSDK()
  const [persistedStore, setPersistedStore, , ready] = persisted(
    Persist.scoped(sdk.directory, undefined, "quick-reading-mode.v2"),
    createStore<PersistedState>({
      settings: cloneSettings(),
      byPdfPath: {},
    }),
  )
  const [store, setStore] = createStore<Store>({
    binding: null,
    snapshot: { ...createPdfState(), settings: cloneSettings() },
    view: createView(),
    pendingQuestion: null,
    hydratedKey: undefined,
  })

  const bindingKey = () => {
    const binding = store.binding
    if (!binding) return
    return `${binding.sessionID}:${binding.pdfPath}`
  }

  const shared = () => (ready() ? cloneSettings(persistedStore.settings ?? legacySettings(persistedStore)) : cloneSettings())

  const persistSnapshot = (pdfPath: string, snapshot: Snapshot) => {
    setPersistedStore("byPdfPath", pdfPath, normalizePdfState(snapshot))
  }

  const updateSnapshot = (updater: (current: Snapshot) => Snapshot, persist = true) => {
    const next = updater(store.snapshot)
    setStore("snapshot", next)
    const binding = store.binding
    if (persist && binding) persistSnapshot(binding.pdfPath, next)
  }

  const bind = (sessionID: string, pdfPath: string, pdfFileName: string) => {
    const nextKey = `${sessionID}:${pdfPath}`
    const nextSnapshot = {
      ...(ready() ? normalizePdfState(persistedStore.byPdfPath[pdfPath]) : createPdfState()),
      settings: shared(),
    }
    setStore({
      binding: { sessionID, pdfPath, pdfFileName },
      snapshot: nextSnapshot,
        view:
          store.view.pdfPath === pdfPath
            ? store.view
            : {
                pdfPath,
                page: 1,
                location: undefined,
              },
        hydratedKey: ready() ? nextKey : undefined,
    })
    if (ready() && !persistedStore.byPdfPath[pdfPath]) persistSnapshot(pdfPath, nextSnapshot)
  }

  const unbind = () => {
    setStore({
      binding: null,
      snapshot: { ...createPdfState(), settings: shared() },
      hydratedKey: undefined,
    })
  }

  createEffect(() => {
    const binding = store.binding
    const key = bindingKey()
    if (!binding || !key || !ready()) return
    if (store.hydratedKey === key) return
    const nextSnapshot = {
      ...normalizePdfState(persistedStore.byPdfPath[binding.pdfPath]),
      settings: shared(),
    }
    setStore("snapshot", nextSnapshot)
    setStore("hydratedKey", key)
    if (!persistedStore.byPdfPath[binding.pdfPath]) persistSnapshot(binding.pdfPath, nextSnapshot)
  })

  createEffect(() => {
    if (!ready()) return
    const settings = shared()
    setStore("snapshot", "settings", settings)
    if (!persistedStore.settings) setPersistedStore("settings", settings)
  })

  const ctx: Ctx = {
    store,
    bind,
    unbind,
    setPage: (page) => {
      if (!Number.isFinite(page) || page < 1) return
      const next = Math.round(page)
      if (store.view.page === next) return
      setStore("view", "page", next)
    },
    setLocation: (location) => {
      if (store.view.location === location) return
      setStore("view", "location", location)
    },
    setTotalPages: (totalPages) => {
      if (!Number.isFinite(totalPages) || totalPages < 0) return
      const next = Math.round(totalPages)
      if (store.snapshot.totalPages === next) return
      updateSnapshot((current) => ({ ...current, totalPages: next }))
    },
    setLayoutSwapped: (swapped) => {
      if (store.snapshot.layoutSwapped === swapped) return
      updateSnapshot((current) => ({ ...current, layoutSwapped: swapped }))
    },
    setPendingQuestion: (question) => setStore("pendingQuestion", question),
    setSettings: (settings) => {
      const next = cloneSettings(settings)
      setPersistedStore("settings", next)
      updateSnapshot((current) => ({ ...current, settings: next }), false)
    },
    clearTransientState: () => setStore("pendingQuestion", null),
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
