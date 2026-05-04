import type { FileDiff, Project, UserMessage } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogRevertConfirm } from "@/components/dialog-revert-confirm"
import { useMutation } from "@tanstack/solid-query"
import {
  batch,
  children,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  createSignal,
  on,
  onMount,
  untrack,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Select } from "@opencode-ai/ui/select"
import { Tabs } from "@opencode-ai/ui/tabs"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode, checksum } from "@opencode-ai/util/encode"
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { useComments } from "@/context/comments"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { ConversationQuoteProvider } from "@/context/conversation-quote"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { QuickReadingFirstReadGate } from "@/components/quick-reading/quick-reading-first-read-gate"
import { QuickReadingModeProvider, useQuickReadingMode } from "@/context/quick-reading-mode"
import { QuickReadingPanel } from "@/components/quick-reading/quick-reading-panel"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import {
  createOpenReviewFile,
  createSessionTabs,
  createSizing,
  shouldProtectSessionRevert,
  type RevertProtectionResult,
  type Sizing,
  focusTerminalById,
  shouldFocusTerminalOnKeyDown,
} from "@/pages/session/helpers"
import { childMapByParent } from "@/pages/layout/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useQuickReadingController } from "@/pages/session/use-quick-reading-controller"
import { useQuickReadingLayout } from "@/pages/session/use-quick-reading-layout"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { extractPromptFromParts } from "@/utils/prompt"
import { same } from "@/utils/same"
import { formatServerError } from "@/utils/server-errors"

const emptyUserMessages: UserMessage[] = []
const emptyFollowups: (FollowupDraft & { id: string })[] = []
const READING_CHAT_MIN_WIDTH = 360
const READING_REVIEW_MIN_WIDTH = 320

type ChangeMode = "git" | "branch" | "session" | "turn"
type VcsMode = "git" | "branch"

type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  messagesReady: () => boolean
  loaded: () => number
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
}

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
function createSessionHistoryWindow(input: SessionHistoryWindowInput) {
  const turnInit = 10
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
  })

  const initialTurnStart = (len: number) => (len > turnInit ? len - turnInit : 0)

  const turnStart = createMemo(() => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return initialTurnStart(len)
    if (state.turnStart <= 0) return 0
    if (state.turnStart >= len) return initialTurnStart(len)
    return state.turnStart
  })

  const setTurnStart = (start: number) => {
    const id = input.sessionID()
    const next = start > 0 ? start : 0
    if (!id) {
      setState({ turnID: undefined, turnStart: next })
      return
    }
    setState({ turnID: id, turnStart: next })
  }

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      if (start <= 0) return msgs
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  const preserveScroll = (fn: () => void) => {
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => setTurnStart(nextStart))
  }

  /** Button path: reveal all cached turns, fetch older history, reveal one batch. */
  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()

    if (start > 0) setTurnStart(0)

    if (!input.historyMore() || input.historyLoading()) return

    let afterVisible = beforeVisible
    let added = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      afterVisible = input.visibleUserMessages().length
      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded

      if (afterVisible > beforeVisible) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (added <= 0) return
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)

    const growth = afterVisible - beforeVisible
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, beforeVisible + turnBatch)
    setTurnStart(Math.max(0, afterVisible - target))
  }

  /** Scroll/prefetch path: fetch older history from server. */
  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length
    let loaded = input.loaded()
    let added = 0
    let growth = 0

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      added += raw
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (opts?.prefetch) break
      if (!input.historyMore()) break
    }

    const afterVisible = input.visibleUserMessages().length

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", added > 0 ? 0 : state.prefetchNoGrowth + 1)
    } else if (added > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (added <= 0) return
    if (growth <= 0) return

    if (opts?.prefetch) {
      const current = turnStart()
      preserveScroll(() => setTurnStart(current + growth))
      return
    }

    if (turnStart() !== start) return

    const currentRendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, currentRendered)
    const target = Math.min(afterVisible, base + turnBatch)
    preserveScroll(() => setTurnStart(Math.max(0, afterVisible - target)))
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= turnScrollThreshold) return

    const start = turnStart()
    if (start > 0) {
      if (start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0 })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [input.sessionID(), input.messagesReady()] as const,
      ([id, ready]) => {
        if (!id || !ready) return
        setTurnStart(initialTurnStart(input.visibleUserMessages().length))
      },
      { defer: true },
    ),
  )

  return {
    turnStart,
    setTurnStart,
    renderedUserMessages,
    loadAndReveal,
    onScrollerScroll,
  }
}

type SessionPageProps = {
  readingPane?: any
  readingPanePosition?: "before" | "after"
  readingPaneWidth?: number
  readingCompositeWidth?: number
  readingCompositeMinWidth?: number
  readingCompositeMaxWidth?: number
  onReadingCompositeResize?: (width: number) => void
  readingSessionResizeSize?: number
  readingSessionResizeMin?: number
  readingSessionResizeMax?: number
  onReadingSessionResize?: (width: number) => void
  readingReviewOpen?: boolean
  readingFileTreeOpen?: boolean
  readingSidePanelWidth?: number
  readingFileTreeWidth?: number
  readingFileTreeResizable?: boolean
  readingSizing?: Sizing
}

function SessionPageContent(props: SessionPageProps = {}) {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const location = useLocation()
  const navigate = useNavigate()
  const sdk = useSDK()
  const settings = useSettings()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const quickReading = useQuickReadingMode()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  createEffect(() => {
    if (!untrack(() => prompt.ready())) return
    prompt.ready()
    untrack(() => {
      if (params.id || !prompt.ready()) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    reviewSnap: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
    },
  })

  const composer = createSessionComposerState()

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))
  const propReadingPane = children(() => props.readingPane)
  const quickReadingRequested = createMemo(
    () => !!params.id && !props.readingPane && view().quickReading.active() && !!view().quickReading.pdfPath(),
  )

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = props.readingSizing ?? createSizing()
  const propReadingModeActive = createMemo(() => isDesktop() && !!props.readingPane)
  const quickReadingModeActive = createMemo(() => isDesktop() && quickReadingRequested())
  const readingModeActive = createMemo(() => propReadingModeActive() || quickReadingModeActive())
  const quickReadingReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const quickReadingFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const quickReadingLayout = useQuickReadingLayout({
    active: quickReadingModeActive,
    reviewOpen: quickReadingReviewOpen,
    fileTreeOpen: quickReadingFileTreeOpen,
    layoutSwapped: () => quickReading.store.snapshot.layoutSwapped,
  })
  const desktopReviewOpen = createMemo(
    () => isDesktop() && (propReadingModeActive() ? !!props.readingReviewOpen : view().reviewPanel.opened()),
  )
  const desktopFileTreeOpen = createMemo(
    () => isDesktop() && (propReadingModeActive() ? !!props.readingFileTreeOpen : layout.fileTree.opened()),
  )
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen())
  let rowRef: HTMLDivElement | undefined
  const [rowWidth, setRowWidth] = createSignal(0)
  const readingPaneWidth = createMemo(() => {
    if (!isDesktop()) return 0
    if (propReadingModeActive()) return Math.max(0, props.readingPaneWidth ?? 0)
    if (quickReadingModeActive()) return quickReadingLayout.pdfPixelWidth()
    return 0
  })
  const readingCompositeMinWidth = createMemo(() =>
    propReadingModeActive()
      ? Math.max(0, props.readingCompositeMinWidth ?? 0)
      : quickReadingModeActive()
        ? Math.max(0, quickReadingLayout.compositeResizeBounds().min)
        : 0,
  )
  const readingCompositeMaxWidth = createMemo(() => {
    if (!readingModeActive()) return 0
    const fallback = propReadingModeActive()
      ? rowWidth() > 0
        ? rowWidth()
        : (props.readingCompositeWidth ?? 0)
      : quickReadingLayout.compositeResizeBounds().max
    return Math.max(readingCompositeMinWidth(), props.readingCompositeMaxWidth ?? fallback)
  })
  const readingFileTreeWidth = createMemo(() =>
    propReadingModeActive()
      ? Math.max(0, props.readingFileTreeWidth ?? 0)
      : quickReadingModeActive()
        ? quickReadingLayout.fileTreePixelWidth()
        : layout.fileTree.width(),
  )
  const sidePanelMinWidth = createMemo(() => {
    let width = 0
    if (desktopReviewOpen()) width += READING_REVIEW_MIN_WIDTH
    if (desktopFileTreeOpen()) width += readingFileTreeWidth()
    return width
  })
  const compositeMinWidth = createMemo(() => {
    if (!readingModeActive()) return 0
    return readingPaneWidth() + READING_CHAT_MIN_WIDTH
  })
  const effectiveCompositeWidth = createMemo(() => {
    if (!readingModeActive()) return 0
    const total = propReadingModeActive() ? rowWidth() : quickReadingLayout.rowWidth()
    const fallback = propReadingModeActive()
      ? (props.readingCompositeWidth ?? 0)
      : quickReadingLayout.compositePixelWidth()
    if (total <= 0) return Math.min(readingCompositeMaxWidth(), Math.max(readingCompositeMinWidth(), fallback))
    if (!desktopSidePanelOpen()) return total
    const requested = propReadingModeActive()
      ? (props.readingCompositeWidth ?? Math.max(0, total - (props.readingSidePanelWidth ?? 0)))
      : quickReadingLayout.compositePixelWidth()
    return Math.min(readingCompositeMaxWidth(), Math.max(readingCompositeMinWidth(), requested))
  })
  const effectiveSessionPanelWidth = createMemo(() => {
    if (!readingModeActive()) return undefined
    return Math.max(0, effectiveCompositeWidth() - readingPaneWidth())
  })
  const effectiveSidePanelWidth = createMemo(() => {
    if (!readingModeActive()) return undefined
    if (!desktopSidePanelOpen()) return 0
    if (propReadingModeActive() && typeof props.readingSidePanelWidth === "number") {
      return Math.max(0, props.readingSidePanelWidth)
    }
    if (quickReadingModeActive()) return quickReadingLayout.sidePanelWidth()
    return Math.max(sidePanelMinWidth(), rowWidth() - effectiveCompositeWidth())
  })
  const sessionPanelWidth = createMemo(() => {
    if (readingModeActive()) {
      return `${effectiveSessionPanelWidth() ?? READING_CHAT_MIN_WIDTH}px`
    }
    const pdfWidth = readingPaneWidth()
    if (!desktopSidePanelOpen()) {
      return pdfWidth > 0 ? `calc(100% - ${pdfWidth}px)` : "100%"
    }
    if (desktopReviewOpen()) {
      return `${Math.max(360, layout.session.width() - pdfWidth)}px`
    }
    return pdfWidth > 0
      ? `calc(100% - ${layout.fileTree.width()}px - ${pdfWidth}px)`
      : `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen())
  const readingSessionResizeSize = createMemo(() => {
    if (propReadingModeActive()) return Math.max(0, props.readingSessionResizeSize ?? 0)
    if (quickReadingModeActive()) return quickReadingLayout.chatPixelWidth()
    return 0
  })
  const readingSessionResizeMin = createMemo(() => {
    if (propReadingModeActive()) return Math.max(0, props.readingSessionResizeMin ?? 0)
    if (quickReadingModeActive()) return quickReadingLayout.sessionResizeBounds().min
    return 0
  })
  const readingSessionResizeMax = createMemo(() => {
    if (propReadingModeActive()) return Math.max(readingSessionResizeMin(), props.readingSessionResizeMax ?? 0)
    if (quickReadingModeActive())
      return Math.max(readingSessionResizeMin(), quickReadingLayout.sessionResizeBounds().max)
    return 0
  })
  const readingFileTreeResizable = createMemo(() => {
    if (propReadingModeActive()) return props.readingFileTreeResizable
    if (quickReadingModeActive()) return false
    return undefined
  })
  const effectiveReadingPanePosition = createMemo<"before" | "after">(() => {
    if (propReadingModeActive()) return props.readingPanePosition === "after" ? "after" : "before"
    return quickReading.store.snapshot.layoutSwapped ? "after" : "before"
  })
  const readingPaneOrder = createMemo(() => (effectiveReadingPanePosition() === "after" ? 1 : 0))
  const sessionPanelOrder = createMemo(() => (effectiveReadingPanePosition() === "after" ? 0 : 1))

  onMount(() => {
    const syncRowWidth = () => {
      if (!rowRef) return
      setRowWidth(rowRef.clientWidth)
    }
    syncRowWidth()
    const observer = new ResizeObserver(syncRowWidth)
    if (rowRef) observer.observe(rowRef)
    onCleanup(() => observer.disconnect())
  })

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  createEffect(() => {
    const session = info()
    const id = params.id
    const dir = params.dir
    if (!session?.readingMode || !id || !dir) return
    if (location.pathname.endsWith("/reading")) return
    navigate(`/${dir}/session/${id}/reading`, { replace: true })
  })
  const diffs = createMemo(() => {
    if (!params.id) return []
    const val = sync.data.session_diff[params.id]
    return Array.isArray(val) ? val : []
  })
  const saved = createMemo(() => info()?.summary?.files ?? 0)
  const canReview = createMemo(() => !!params.id)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const activeFilePath = createMemo(() => {
    const tab = activeFileTab()
    if (!tab) return
    return file.pathFromTab(tab)
  })
  const quickReadingController = useQuickReadingController({
    activeFilePath,
  })
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (sync.data.session_diff[id] !== undefined) return true
    return saved() === 0
  })
  const sessionCount = createMemo(() => (diffsReady() ? diffs().length : saved()))
  const hasSessionReview = createMemo(() => sessionCount() > 0)

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) file.load(path)
  })

  const readingPane = createMemo(() => {
    if (props.readingPane) return propReadingPane()
    if (!quickReadingController.active()) return undefined

    return (
      <QuickReadingPanel
        url={quickReadingController.pdfUrl()}
        authHeader={quickReadingController.authHeader()}
        width={readingPaneWidth()}
        minWidth={quickReadingLayout.pdfMinWidth()}
        maxWidth={Math.max(quickReadingLayout.pdfMinWidth(), quickReadingLayout.pdfMaxWidth())}
        page={quickReadingController.page()}
        location={quickReadingController.location()}
        layoutSwapped={quickReadingController.layoutSwapped()}
        onPageChange={quickReadingController.handlePageChange}
        onLocationChange={quickReadingController.handleLocationChange}
        onDocumentInfo={quickReadingController.handleDocumentInfo}
        onTextSelectionAction={quickReadingController.handleTextSelectionAction}
        onImageSelectionAction={quickReadingController.handleImageSelectionAction}
        onExitQuickReading={quickReadingController.closeQuickReading}
        onSwapLayout={quickReadingController.toggleLayoutSwapped}
        onStartFirstRead={quickReadingController.openFirstRead}
        onOpenSettings={quickReadingController.openSettings}
        onResizeWidth={quickReadingLayout.handleResizeWidth}
        resizeHandleEnabled={
          quickReadingLayout.layoutMode() !== "review-right" && quickReadingLayout.layoutMode() !== "review-tree-right"
        }
        sizing={size}
      />
    )
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "git" as ChangeMode,
    newSessionWorktree: "main",
    deferRender: false,
  })

  const [vcs, setVcs] = createStore({
    diff: {
      git: [] as FileDiff[],
      branch: [] as FileDiff[],
    },
    ready: {
      git: false,
      branch: false,
    },
  })

  const [followup, setFollowup] = createStore({
    items: {} as Record<string, (FollowupDraft & { id: string })[] | undefined>,
    failed: {} as Record<string, string | undefined>,
    paused: {} as Record<string, boolean | undefined>,
    edit: {} as Record<
      string,
      { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] } | undefined
    >,
  })

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, sessionKey())

  let reviewFrame: number | undefined
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined
  let watcherDiff: number | undefined
  const vcsTask = new Map<VcsMode, Promise<void>>()
  const vcsRun = new Map<VcsMode, number>()

  const bumpVcs = (mode: VcsMode) => {
    const next = (vcsRun.get(mode) ?? 0) + 1
    vcsRun.set(mode, next)
    return next
  }

  const resetVcs = (mode?: VcsMode) => {
    const list = mode ? [mode] : (["git", "branch"] as const)
    list.forEach((item) => {
      bumpVcs(item)
      vcsTask.delete(item)
      setVcs("diff", item, [])
      setVcs("ready", item, false)
    })
  }

  const loadVcs = (mode: VcsMode, force = false) => {
    if (sync.project?.vcs !== "git") return Promise.resolve()
    if (!force && vcs.ready[mode]) return Promise.resolve()

    if (force) {
      if (vcsTask.has(mode)) bumpVcs(mode)
      vcsTask.delete(mode)
      setVcs("ready", mode, false)
    }

    const current = vcsTask.get(mode)
    if (current) return current

    const run = bumpVcs(mode)

    const task = sdk.client.vcs
      .diff({ mode })
      .then((result) => {
        if (vcsRun.get(mode) !== run) return
        setVcs("diff", mode, result.data ?? [])
        setVcs("ready", mode, true)
      })
      .catch((error) => {
        if (vcsRun.get(mode) !== run) return
        console.debug("[session-review] failed to load vcs diff", { mode, error })
        setVcs("diff", mode, [])
        setVcs("ready", mode, true)
      })
      .finally(() => {
        if (vcsTask.get(mode) === task) vcsTask.delete(mode)
      })

    vcsTask.set(mode, task)
    return task
  }

  const refreshVcs = () => {
    resetVcs()
    const mode = untrack(vcsMode)
    if (!mode) return
    if (!untrack(wantsReview)) return
    void loadVcs(mode, true)
  }

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  const turnDiffs = createMemo(() => {
    const raw = lastUserMessage()?.summary?.diffs
    return Array.isArray(raw) ? raw : []
  })
  const changesOptions = createMemo<ChangeMode[]>(() => {
    const list: ChangeMode[] = []
    if (sync.project?.vcs === "git") list.push("git")
    if (
      sync.project?.vcs === "git" &&
      sync.data.vcs?.branch &&
      sync.data.vcs?.default_branch &&
      sync.data.vcs.branch !== sync.data.vcs.default_branch
    ) {
      list.push("branch")
    }
    list.push("session", "turn")
    return list
  })
  const vcsMode = createMemo<VcsMode | undefined>(() => {
    if (store.changes === "git" || store.changes === "branch") return store.changes
  })
  const reviewDiffs = createMemo(() => {
    if (store.changes === "git") return vcs.diff.git
    if (store.changes === "branch") return vcs.diff.branch
    if (store.changes === "session") return diffs()
    return turnDiffs()
  })
  const reviewCount = createMemo(() => {
    if (store.changes === "git") return vcs.diff.git.length
    if (store.changes === "branch") return vcs.diff.branch.length
    if (store.changes === "session") return sessionCount()
    return turnDiffs().length
  })
  const hasReview = createMemo(() => reviewCount() > 0)
  const reviewReady = createMemo(() => {
    if (store.changes === "git") return vcs.ready.git
    if (store.changes === "branch") return vcs.ready.branch
    if (store.changes === "session") return !hasSessionReview() || diffsReady()
    return true
  })

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sdk.directory !== project.worktree) return sdk.directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const sessionEmptyKey = createMemo(() => {
    const project = sync.project
    if (project && !project.vcs) return "session.review.noVcs"
    if (sync.data.config.snapshot === false) return "session.review.noSnapshot"
    return "session.review.empty"
  })

  function upsert(next: Project) {
    sync.set("project", next.id)
    globalSync.project.upsert(next)
    void globalSync.project.refreshRecent()
  }

  const gitMutation = useMutation(() => ({
    mutationFn: () => sdk.client.project.initGit(),
    onSuccess: (x) => {
      if (!x.data) return
      upsert(x.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on([() => sdk.directory, () => params.id] as const, ([, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(sdk.directory, id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()
      const todos = untrack(() => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined)

      untrack(() => {
        void sync.session.sync(id)
      })

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (params.id !== id) return
          untrack(() => {
            if (stale) void sync.session.sync(id, { force: true })
            void sync.session.todo(id, todos ? { force: true } : undefined)
          })
        }, 0)
      })
    }),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("changes", "git")
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => sdk.directory,
      () => {
        resetVcs()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [sync.data.vcs?.branch, sync.data.vcs?.default_branch] as const,
      (next, prev) => {
        if (prev === undefined || same(next, prev)) return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk.event.listen((evt) => {
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus
    if (view().terminal.opened()) {
      const id = terminal.active()
      if (id && shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked()) return
      inputRef?.focus()
    }
  }

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes",
  )

  createEffect(
    on(
      sessionKey,
      () => {
        resetVcs()
        const mode = untrack(vcsMode)
        if (!mode) return
        if (!untrack(wantsReview)) return
        void loadVcs(mode)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const list = changesOptions()
    if (list.includes(store.changes)) return
    const next = list[0]
    if (!next) return
    setStore("changes", next)
  })

  createEffect(() => {
    const mode = vcsMode()
    if (!mode) return
    if (!wantsReview()) return
    void loadVcs(mode)
  })

  createEffect(
    on(
      () => sync.data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        const mode = vcsMode()
        if (!mode) return
        if (!wantsReview()) return
        if (next !== "idle" || prev === undefined || prev === "idle") return
        void loadVcs(mode, true)
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const refreshReview = () => {
    file.tree.refresh("")
    const id = params.id
    if (!id) return

    const mode = untrack(() => store.changes)
    if (mode === "git" || mode === "branch") {
      refreshVcs()
      return
    }

    if (mode !== "session") return

    sync.set("session_diff", (value) => {
      const next = { ...value }
      delete next[id]
      return next
    })
    void sync.session.diff(id, { force: true })
  }

  const focusInput = () => inputRef?.focus()

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    review: reviewTab,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesTitle = () => {
    if (!canReview()) {
      return null
    }

    const label = (option: ChangeMode) => {
      if (option === "git") return language.t("ui.sessionReview.title.git")
      if (option === "branch") return language.t("ui.sessionReview.title.branch")
      if (option === "session") return language.t("ui.sessionReview.title")
      return language.t("ui.sessionReview.title.lastTurn")
    }

    return (
      <Select
        options={changesOptions()}
        current={store.changes}
        label={label}
        onSelect={(option) => option && setStore("changes", option)}
        variant="ghost"
        size="small"
        valueClass="text-14-medium"
      />
    )
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    if (store.changes === "git") return language.t("session.review.noUncommittedChanges")
    if (store.changes === "branch") return language.t("session.review.noBranchChanges")
    if (store.changes === "turn") return language.t("session.review.noChanges")
    return language.t(sessionEmptyKey())
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (store.changes === "git" || store.changes === "branch") {
      if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      return empty(reviewEmptyText())
    }

    if (store.changes === "turn") {
      return empty(reviewEmptyText())
    }

    if (hasSessionReview() && !diffsReady()) {
      return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
    }

    if (sessionEmptyKey() === "session.review.noVcs") {
      return (
        <div class={input.emptyClass}>
          <div class="flex flex-col gap-3">
            <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
            <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
              {language.t("session.review.noVcs.createGit.description")}
            </div>
          </div>
          <Button size="large" disabled={gitMutation.isPending} onClick={initGit}>
            {gitMutation.isPending
              ? language.t("session.review.noVcs.createGit.actionLoading")
              : language.t("session.review.noVcs.createGit.action")}
          </Button>
        </div>
      )
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{reviewEmptyText()}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    view().review.openPath(path)
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    if (!wantsReview()) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(
    on(
      () => [sessionKey(), wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync.data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  // Refresh diffs when external file changes are detected (add/delete/modify)
  const unwatchDiff = sdk.event.listen((e) => {
    if (e.details.type !== "file.watcher.updated") return
    const props =
      typeof e.details.properties === "object" && e.details.properties
        ? (e.details.properties as Record<string, unknown>)
        : undefined
    const raw = typeof props?.file === "string" ? props.file : undefined
    if (!raw) return
    const normalized = file.normalize(raw)
    if (!normalized || normalized.startsWith(".git/")) return

    const id = params.id
    if (!id) return
    if (sync.data.session_diff[id] === undefined) return

    if (watcherDiff !== undefined) window.clearTimeout(watcherDiff)
    watcherDiff = window.setTimeout(() => {
      watcherDiff = undefined
      if (params.id !== id) return
      void sync.session.diff(id, { force: true })
    }, 500)
  })

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  // Refresh file tree when session becomes idle (AI finished writing files)
  createEffect(
    on(
      () => {
        const id = params.id
        if (!id) return undefined
        return (sync.data.session_status[id] ?? { type: "idle" as const }).type
      },
      (status, prev) => {
        if (status !== "idle") return
        if (prev === undefined) return // skip initial
        void file.tree.refresh("")
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => sdk.directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const overflow = max > 1
    const bottom = !overflow || el.scrollTop >= max - 2

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom) return
    setUi("scroll", { overflow, bottom })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const historyWindow = createSessionHistoryWindow({
    sessionID: () => params.id,
    messagesReady,
    loaded: () => messages().length,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !historyMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyWindow.turnStart(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const busy = (sessionID: string) => {
    if ((sync.data.session_status[sessionID] ?? { type: "idle" as const }).type !== "idle") return true
    if (
      (sync.data.message[sessionID] ?? []).some(
        (item) => item.role === "assistant" && typeof item.time.completed !== "number",
      )
    )
      return true
    const map = childMapByParent(sync.data.session)
    const children = map.get(sessionID)
    if (!children?.length) return false
    for (const id of children) {
      if (busy(id)) return true
    }
    return false
  }

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        client: sdk.client,
        sync,
        globalSync,
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk.directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) resumeScroll()
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID) ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const prev = prompt.current().slice()
      const last = info()?.revert
      const value = draft(input.messageID)
      batch(() => {
        roll(input.sessionID, { messageID: input.messageID })
        prompt.set(value)
      })
      await halt(input.sessionID)
        .then(() => sdk.client.session.revert(input))
        .then((result) => {
          sync.session.invalidate(input.sessionID)
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(input.sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const next = userMessages().find((item) => item.id > id)
      const prev = prompt.current().slice()
      const last = info()?.revert

      batch(() => {
        roll(sessionID, next ? { messageID: next.id } : undefined)
        if (next) {
          prompt.set(draft(next.id))
          return
        }
        prompt.reset()
      })

      const task = !next
        ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
        : halt(sessionID).then(() =>
            sdk.client.session.revert({
              sessionID,
              messageID: next.id,
            }),
          )

      await task
        .then((result) => {
          sync.session.invalidate(sessionID)
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const fork = (input: { sessionID: string; messageID: string }) => {
    const value = draft(input.messageID)
    const dir = base64Encode(sdk.directory)
    return sdk.client.session
      .fork(input)
      .then((result) => {
        const next = result.data
        if (!next) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
          })
          return
        }
        prompt.set(value, undefined, { dir, id: next.id })
        navigate(`/${dir}/session/${next.id}`)
      })
      .catch(fail)
  }

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    const session = info()
    if (!session || session.id !== input.sessionID) {
      return revertMutation.mutateAsync(input)
    }

    if (busy(input.sessionID)) {
      dialog.show(() => <DialogRevertConfirm reason="session-busy" onFork={() => fork(input)} />)
      return
    }

    return sdk.client.session
      .graph({ sessionID: input.sessionID })
      .then((result) => {
        const protection: RevertProtectionResult = shouldProtectSessionRevert({
          session,
          messages: messages(),
          selectedMessageID: input.messageID,
          graph: result.data,
        })
        dialog.show(() => (
          <DialogRevertConfirm
            reason={protection.protected ? protection.reason : undefined}
            onRevert={() => revertMutation.mutateAsync(input)}
            onFork={() => fork(input)}
          />
        ))
      })
      .catch(() => {
        dialog.show(() => <DialogRevertConfirm onRevert={() => revertMutation.mutateAsync(input)} />)
      })
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    if (busy(params.id)) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const actions = { fork, revert }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) autoScroll.forceScrollToBottom()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    turnStart: historyWindow.turnStart,
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: () => scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    unwatchDiff()
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (watcherDiff !== undefined) window.clearTimeout(watcherDiff)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <SessionHeader />
      <Show when={params.id && quickReadingController.pdfPath() && quickReadingController.pdfFileName()}>
        <QuickReadingFirstReadGate
          open={quickReadingController.firstReadOpen()}
          sessionID={params.id!}
          pdfPath={quickReadingController.pdfPath()!}
          pdfFileName={quickReadingController.pdfFileName()!}
          totalPages={quickReadingController.totalPages()}
          onOpenChange={quickReadingController.setFirstReadOpen}
        />
      </Show>
      <div
        ref={(el) => {
          rowRef = el
          quickReadingLayout.setRowRef(el)
        }}
        class="flex-1 min-h-0 flex flex-col md:flex-row"
      >
        <Show when={!isDesktop() && !!params.id}>
          <Tabs value={store.mobileTab} class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="!w-1/2 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "session")}
              >
                {language.t("session.tab.session")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="changes"
                class="!w-1/2 !max-w-none !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "changes")}
              >
                {hasReview()
                  ? language.t("session.review.filesChanged", { count: reviewCount() })
                  : language.t("session.review.change.other")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        <Show when={readingModeActive()}>
          <div
            class="relative flex min-h-0 shrink-0 overflow-hidden"
            style={{ width: `${effectiveCompositeWidth()}px` }}
          >
            <Show when={effectiveReadingPanePosition() !== "after"}>
              <div class="min-h-0 shrink-0" style={{ order: String(readingPaneOrder()) }}>
                {readingPane()}
              </div>
            </Show>
            <div
              data-chat-panel
              classList={{
                "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger flex-1 md:flex-none": true,
                "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !size.active() && !ui.reviewSnap,
              }}
              style={{
                width: sessionPanelWidth(),
                order: String(sessionPanelOrder()),
              }}
            >
              <div class="flex-1 min-h-0 overflow-hidden">
                <Switch>
                  <Match when={params.id}>
                    <Show when={messagesReady()}>
                      <MessageTimeline
                        mobileChanges={mobileChanges()}
                        mobileFallback={reviewContent({
                          diffStyle: "unified",
                          classes: {
                            root: "pb-8",
                            header: "px-4",
                            container: "px-4",
                          },
                          loadingClass: "px-4 py-4 text-text-weak",
                          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                        })}
                        actions={actions}
                        scroll={ui.scroll}
                        onResumeScroll={resumeScroll}
                        setScrollRef={setScrollRef}
                        onScheduleScrollState={scheduleScrollState}
                        onAutoScrollHandleScroll={autoScroll.handleScroll}
                        onMarkScrollGesture={markScrollGesture}
                        hasScrollGesture={hasScrollGesture}
                        onUserScroll={markUserScroll}
                        onTurnBackfillScroll={historyWindow.onScrollerScroll}
                        onAutoScrollInteraction={autoScroll.handleInteraction}
                        centered={centered()}
                        setContentRef={(el) => {
                          content = el
                          autoScroll.contentRef(el)

                          const root = scroller
                          if (root) scheduleScrollState(root)
                        }}
                        turnStart={historyWindow.turnStart()}
                        historyMore={historyMore()}
                        historyLoading={historyLoading()}
                        onLoadEarlier={() => {
                          void historyWindow.loadAndReveal()
                            }}
                            renderedUserMessages={historyWindow.renderedUserMessages()}
                            anchor={anchor}
                            onFocusInput={focusInput}
                          />
                    </Show>
                  </Match>
                  <Match when={true}>
                    <NewSessionView worktree={newSessionWorktree()} />
                  </Match>
                </Switch>
              </div>

              <SessionComposerRegion
                state={composer}
                ready={!store.deferRender && messagesReady()}
                centered={centered()}
                inputRef={(el) => {
                  inputRef = el
                }}
                newSessionWorktree={newSessionWorktree()}
                onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                onSubmit={() => {
                  comments.clear()
                  resumeScroll()
                }}
                onResponseSubmit={resumeScroll}
                followup={
                  params.id
                    ? {
                        queue: queueEnabled,
                        items: followupDock(),
                        sending: sendingFollowup(),
                        edit: editingFollowup(),
                        onQueue: queueFollowup,
                        onAbort: () => {
                          const id = params.id
                          if (!id) return
                          setFollowup("paused", id, true)
                        },
                        onSend: (id) => {
                          void sendFollowup(params.id!, id, { manual: true })
                        },
                        onEdit: editFollowup,
                        onEditLoaded: clearFollowupEdit,
                      }
                    : undefined
                }
                revert={
                  rolled().length > 0
                    ? {
                        items: rolled(),
                        restoring: restoring(),
                        disabled: reverting(),
                        onRestore: restore,
                      }
                    : undefined
                }
                setPromptDockRef={(el) => {
                  promptDock = el
                }}
              />
              <Show
                when={
                  readingModeActive() &&
                  (propReadingModeActive()
                    ? !!props.onReadingSessionResize && readingSessionResizeMax() > readingSessionResizeMin()
                    : readingSessionResizeMax() > readingSessionResizeMin())
                }
              >
                <div class="absolute inset-y-0 right-0 z-10 w-0 overflow-visible" onPointerDown={() => size.start()}>
                  <div class="pointer-events-none absolute inset-y-0 right-0 translate-x-1/2 w-px bg-border-base/80" />
                  <ResizeHandle
                    direction="horizontal"
                    class="after:bg-border-base/90"
                    size={readingSessionResizeSize()}
                    min={readingSessionResizeMin()}
                    max={readingSessionResizeMax()}
                    onResize={(width) => {
                      size.touch()
                      if (propReadingModeActive()) {
                        props.onReadingSessionResize?.(width)
                        return
                      }
                      quickReadingLayout.handleSessionResize(width)
                    }}
                  />
                </div>
              </Show>
            </div>
            <Show when={effectiveReadingPanePosition() === "after"}>
              <div class="min-h-0 shrink-0" style={{ order: String(readingPaneOrder()) }}>
                {readingPane()}
              </div>
            </Show>
            <Show when={desktopSidePanelOpen() && readingCompositeMaxWidth() > readingCompositeMinWidth()}>
              <div class="absolute inset-y-0 right-0 z-10 w-0 overflow-visible" onPointerDown={() => size.start()}>
                <div class="pointer-events-none absolute inset-y-0 right-0 translate-x-1/2 w-px bg-border-base/80" />
                <ResizeHandle
                  direction="horizontal"
                  class="after:bg-border-base/90"
                  size={effectiveCompositeWidth()}
                  min={readingCompositeMinWidth()}
                  max={readingCompositeMaxWidth()}
                  onResize={(width) => {
                    size.touch()
                    if (propReadingModeActive()) {
                      props.onReadingCompositeResize?.(width)
                      return
                    }
                    quickReadingLayout.handleCompositeResize(width)
                  }}
                />
              </div>
            </Show>
          </div>
        </Show>

        <Show when={!readingModeActive()}>
          <div
            data-chat-panel
            classList={{
              "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger flex-1 md:flex-none": true,
              "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !size.active() && !ui.reviewSnap,
            }}
            style={{
              width: sessionPanelWidth(),
              order: String(sessionPanelOrder()),
            }}
          >
            <div class="flex-1 min-h-0 overflow-hidden">
              <Switch>
                <Match when={params.id}>
                  <Show when={messagesReady()}>
                    <MessageTimeline
                      mobileChanges={mobileChanges()}
                      mobileFallback={reviewContent({
                        diffStyle: "unified",
                        classes: {
                          root: "pb-8",
                          header: "px-4",
                          container: "px-4",
                        },
                        loadingClass: "px-4 py-4 text-text-weak",
                        emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                      })}
                      actions={actions}
                      scroll={ui.scroll}
                      onResumeScroll={resumeScroll}
                      setScrollRef={setScrollRef}
                      onScheduleScrollState={scheduleScrollState}
                      onAutoScrollHandleScroll={autoScroll.handleScroll}
                      onMarkScrollGesture={markScrollGesture}
                      hasScrollGesture={hasScrollGesture}
                      onUserScroll={markUserScroll}
                      onTurnBackfillScroll={historyWindow.onScrollerScroll}
                      onAutoScrollInteraction={autoScroll.handleInteraction}
                      centered={centered()}
                      setContentRef={(el) => {
                        content = el
                        autoScroll.contentRef(el)

                        const root = scroller
                        if (root) scheduleScrollState(root)
                      }}
                      turnStart={historyWindow.turnStart()}
                      historyMore={historyMore()}
                      historyLoading={historyLoading()}
                      onLoadEarlier={() => {
                        void historyWindow.loadAndReveal()
                        }}
                        renderedUserMessages={historyWindow.renderedUserMessages()}
                        anchor={anchor}
                        onFocusInput={focusInput}
                      />
                  </Show>
                </Match>
                <Match when={true}>
                  <NewSessionView worktree={newSessionWorktree()} />
                </Match>
              </Switch>
            </div>

            <SessionComposerRegion
              state={composer}
              ready={!store.deferRender && messagesReady()}
              centered={centered()}
              inputRef={(el) => {
                inputRef = el
              }}
              newSessionWorktree={newSessionWorktree()}
              onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
              onSubmit={() => {
                comments.clear()
                resumeScroll()
              }}
              onResponseSubmit={resumeScroll}
              followup={
                params.id
                  ? {
                      queue: queueEnabled,
                      items: followupDock(),
                      sending: sendingFollowup(),
                      edit: editingFollowup(),
                      onQueue: queueFollowup,
                      onAbort: () => {
                        const id = params.id
                        if (!id) return
                        setFollowup("paused", id, true)
                      },
                      onSend: (id) => {
                        void sendFollowup(params.id!, id, { manual: true })
                      },
                      onEdit: editFollowup,
                      onEditLoaded: clearFollowupEdit,
                    }
                  : undefined
              }
              revert={
                rolled().length > 0
                  ? {
                      items: rolled(),
                      restoring: restoring(),
                      disabled: reverting(),
                      onRestore: restore,
                    }
                  : undefined
              }
              setPromptDockRef={(el) => {
                promptDock = el
              }}
            />

            <Show when={desktopReviewOpen()}>
              <div onPointerDown={() => size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  size={layout.session.width()}
                  min={450}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                  onResize={(width) => {
                    size.touch()
                    layout.session.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>
        </Show>

        <SessionSidePanel
          style={{ order: "2" }}
          widthOverride={effectiveSidePanelWidth()}
          reviewOpenOverride={readingModeActive() ? desktopReviewOpen() : undefined}
          fileOpenOverride={readingModeActive() ? desktopFileTreeOpen() : undefined}
          treeWidthOverride={readingModeActive() ? readingFileTreeWidth() : undefined}
          fileTreeResizable={readingModeActive() ? readingFileTreeResizable() : undefined}
          canReview={canReview}
          diffs={reviewDiffs}
          diffsReady={reviewReady}
          empty={reviewEmptyText}
          onRefresh={refreshReview}
          onVcsRefresh={refreshVcs}
          hasReview={hasReview}
          reviewCount={reviewCount}
          reviewPanel={reviewPanel}
          activeDiff={tree.activeDiff}
          focusReviewDiff={focusReviewDiff}
          reviewSnap={ui.reviewSnap}
          size={size}
        />
      </div>

      <TerminalPanel />
    </div>
  )
}

export default function Page(props: SessionPageProps = {}) {
  return (
    <ConversationQuoteProvider>
      <QuickReadingModeProvider>
        <SessionPageContent {...props} />
      </QuickReadingModeProvider>
    </ConversationQuoteProvider>
  )
}
