import { For, batch, createEffect, createMemo, on, onCleanup, Show, Index, type JSX, createSignal } from "solid-js"
import { createWorkingState, type ChildrenSource } from "@/utils/working-state"
import { childMapByParent } from "@/pages/layout/helpers"
import { createStore, produce, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Spinner } from "@opencode-ai/ui/spinner"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { TextField } from "@opencode-ai/ui/text-field"
import type { AssistantMessage, Message as MessageType, Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/util/binary"
import { getFilename } from "@opencode-ai/util/path"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { resolveSelectionAnchorRect } from "@/pages/session/selection-anchor"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useI18n } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useConversationQuote } from "@/context/conversation-quote"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { messageAgentColor } from "@/utils/agent"
import {
  formatReadingPageRange,
  readConversationQuoteMetadata,
  parseCommentNote,
  readCommentMetadata,
  readReadingQuoteMetadata,
  summarizeReadingQuoteText,
  type ConversationQuote,
  type ReadingQuote,
} from "@/utils/comment-note"
import { makeTimer } from "@solid-primitives/timer"
import { createChatFind, ChatFindBar } from "@/pages/session/chat-find"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

type MessageReadingQuote = ReadingQuote
type MessageConversationQuote = ConversationQuote

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }

type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
}

const messageComments = (parts: Part[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

const messageReadingQuotes = (parts: Part[]): MessageReadingQuote[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readReadingQuoteMetadata(part.metadata)
    return next && next.contentType === "text" ? [next] : []
  })

const messageConversationQuotes = (parts: Part[]): MessageConversationQuote[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readConversationQuoteMetadata(part.metadata)
    return next ? [next] : []
  })

function DialogReadingQuoteTextContent(props: { quote: MessageReadingQuote }) {
  return (
    <Dialog title="PDF Quote" class="w-[min(720px,calc(100vw-32px))] max-w-[calc(100vw-32px)]">
      <div class="flex max-h-[70vh] min-w-0 w-full max-w-full flex-col gap-3 overflow-hidden p-4">
        <div class="min-w-0 break-words text-14-medium text-text-strong">
          {`${props.quote.pdfFileName} - p.${formatReadingPageRange(props.quote)} - ${props.quote.action === "ask" ? "Ask" : "Translate"}`}
        </div>
        <div class="text-12-regular text-text-weak">
          {props.quote.action === "ask" ? "Quoted content used for Ask" : "Quoted content used for Translate"}
        </div>
        <div class="min-w-0 w-full max-w-full overflow-auto rounded-md border border-border-weak-base bg-background-stronger px-3 py-3">
          <div class="min-w-0 w-full max-w-full whitespace-pre-wrap break-words text-13-regular text-text-strong [overflow-wrap:anywhere]">
            {props.quote.fullText || props.quote.summary}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function DialogConversationQuoteTextContent(props: { quote: MessageConversationQuote }) {
  return (
    <Dialog title="AI Reply Quote" class="w-[min(720px,calc(100vw-32px))] max-w-[calc(100vw-32px)]">
      <div class="max-h-[70vh] min-w-0 w-full max-w-full overflow-auto px-4 pb-4">
        <div class="min-w-0 w-full max-w-full whitespace-pre-wrap break-words text-13-regular text-text-strong [overflow-wrap:anywhere]">
          {props.quote.fullText}
        </div>
      </div>
    </Dialog>
  )
}

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

type StageConfig = {
  init: number
  batch: number
}

type TimelineStageInput = {
  sessionKey: () => string
  turnStart: () => number
  messages: () => UserMessage[]
  config: StageConfig
}

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 */
function createTimelineStaging(input: TimelineStageInput) {
  const [state, setState] = createStore({
    activeSession: "",
    completedSession: "",
    count: 0,
  })

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (state.completedSession === input.sessionKey()) return total
    const init = Math.min(total, input.config.init)
    if (state.count <= init) return init
    if (state.count >= total) return total
    return state.count
  })

  const stagedUserMessages = createMemo(() => {
    const list = input.messages()
    const count = stagedCount()
    if (count >= list.length) return list
    return list.slice(Math.max(0, list.length - count))
  })

  let frame: number | undefined
  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.turnStart() > 0, input.messages().length] as const,
      ([sessionKey, isWindowed, total]) => {
        cancel()
        const shouldStage =
          isWindowed &&
          total > input.config.init &&
          state.completedSession !== sessionKey &&
          state.activeSession !== sessionKey
        if (!shouldStage) {
          setState({ activeSession: "", count: total })
          return
        }

        let count = Math.min(total, input.config.init)
        setState({ activeSession: sessionKey, count })

        const step = () => {
          if (input.sessionKey() !== sessionKey) {
            frame = undefined
            return
          }
          const currentTotal = input.messages().length
          count = Math.min(currentTotal, count + input.config.batch)
          setState("count", count)
          if (count >= currentTotal) {
            setState({ completedSession: sessionKey, activeSession: "" })
            frame = undefined
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      },
    ),
  )

  const isStaging = createMemo(() => {
    const key = input.sessionKey()
    return state.activeSession === key && state.completedSession !== key
  })

  onCleanup(cancel)
  return { messages: stagedUserMessages, isStaging }
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onTurnBackfillScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void
  renderedUserMessages: UserMessage[]
  anchor: (id: string) => string
  onFocusInput?: () => void
}) {
  let touchGesture: number | undefined
  let root: HTMLDivElement | undefined
  let log: HTMLDivElement | undefined
  let ask: HTMLButtonElement | undefined

  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const dialog = useDialog()
  const layout = useLayout()
  const language = useLanguage()
  const uiI18n = useI18n()
  const conversationQuote = useConversationQuote()
  const { params, sessionKey } = useSessionKey()
  const platform = usePlatform()
  const [assistantCollapse, setAssistantCollapse] = createStore({
    bySession: {} as Record<string, Record<string, true>>,
  })
  const [entry, setEntry] = createStore({
    session: "",
    done: false,
    mode: {} as Record<string, "default" | "open" | "closed">,
    prev: {} as Record<string, string[]>,
  })
  const [selection, setSelection] = createStore({
    open: false,
    sourceMessageID: "",
    text: "",
    summary: "",
    anchorTop: 0,
    anchorLeft: 0,
    top: 0,
    left: 0,
  })

  const rendered = createMemo(() => props.renderedUserMessages.map((message) => message.id))
  const sessionID = createMemo(() => params.id)
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const loaded = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return Object.prototype.hasOwnProperty.call(sync.data.message, id)
  })
  const pending = createMemo(() =>
    sessionMessages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const children = createMemo<ChildrenSource>(() => ({
    childMap: () => childMapByParent(sync.data.session),
    status: (id: string) => sync.data.session_status[id],
  }))
  const { visual: working } = createWorkingState({
    status: () => sessionStatus(),
    pending: () => pending(),
    sessionID: () => sessionID(),
    children: () => children(),
  })
  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))

  const [timeoutDone, setTimeoutDone] = createSignal(true)

  const workingStatus = createMemo<"hidden" | "showing" | "hiding">((prev) => {
    if (working()) return "showing"
    if (prev === "showing" || !timeoutDone()) return "hiding"
    return "hidden"
  })

  createEffect(() => {
    if (workingStatus() !== "hiding") return

    setTimeoutDone(false)
    makeTimer(() => setTimeoutDone(true), 260, setTimeout)
  })

  const activeMessageID = createMemo(() => {
    const parentID = pending()?.parentID
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus()
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const shareUrl = createMemo(() => info()?.share?.url)
  const shareEnabled = createMemo(() => sync.data.config.share !== "disabled")
  const parentID = createMemo(() => info()?.parentID)
  const showHeader = createMemo(() => !!(titleValue() || parentID()))
  const collapsibleTurnIDs = createMemo(() => {
    const visible = new Set(rendered())
    const pending = new Set(
      sessionMessages()
        .filter(
          (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
        )
        .map((item) => item.parentID)
        .filter((item): item is string => !!item),
    )
    const seen = new Set<string>()
    return sessionMessages().flatMap((item) => {
      if (item.role !== "assistant") return []
      const pid = item.parentID
      if (!pid || pending.has(pid) || !visible.has(pid) || seen.has(pid)) return []
      seen.add(pid)
      return [pid]
    })
  })
  createEffect(
    on(sessionID, (id) => {
      setEntry({ session: id ?? "", done: false })
      if (!id) return
      setEntry("mode", id, "default")
      setEntry("prev", id, [])
      setAssistantCollapse("bySession", id, reconcile({}))
    }),
  )
  createEffect(() => {
    const id = sessionID()
    if (!id || !loaded() || entry.session !== id || entry.done) return
    const ids = collapsibleTurnIDs()
    const tail = ids[ids.length - 1]
    setAssistantCollapse(
      "bySession",
      id,
      reconcile(Object.fromEntries(ids.filter((item) => item !== tail).map((item) => [item, true] as const))),
    )
    setEntry("prev", id, rendered().slice())
    setEntry("done", true)
  })
  createEffect(() => {
    const id = sessionID()
    if (!id || !loaded() || entry.session !== id || !entry.done) return
    const prev = entry.prev[id] ?? []
    const next = rendered()
    if (prev.length === next.length && prev.every((item, idx) => item === next[idx])) return
    setEntry("prev", id, next.slice())
    if (next.length <= prev.length) return
    const off = next.length - prev.length
    if (!prev.every((item, idx) => item === next[idx + off])) return
    const mode = entry.mode[id] ?? "default"
    if (mode === "open") return
    const seen = new Set(collapsibleTurnIDs())
    const add = next.slice(0, off).filter((item) => seen.has(item))
    if (add.length === 0) return
    const curr = assistantCollapse.bySession[id] ?? {}
    setAssistantCollapse(
      "bySession",
      id,
      reconcile({ ...curr, ...Object.fromEntries(add.map((item) => [item, true] as const)) }),
    )
  })
  const collapsedTurnMap = createMemo(() => {
    const id = sessionID()
    if (!id) return {}
    return assistantCollapse.bySession[id] ?? {}
  })
  const isAssistantCollapsed = (messageID: string) => !!collapsedTurnMap()[messageID]
  const setAssistantCollapsed = (messageID: string, value: boolean) => {
    const id = sessionID()
    if (!id) return
    const current = assistantCollapse.bySession[id] ?? {}
    if (value) {
      setAssistantCollapse("bySession", id, reconcile({ ...current, [messageID]: true }))
      return
    }
    if (!current[messageID]) return
    const next = { ...current }
    delete next[messageID]
    setAssistantCollapse("bySession", id, reconcile(next))
  }
  const allAssistantCollapsed = createMemo(() => {
    const ids = collapsibleTurnIDs()
    return ids.length > 0 && ids.every((messageID) => isAssistantCollapsed(messageID))
  })
  createEffect(() => {
    const id = sessionID()
    if (!id) return
    const messageID = layout.pendingToggle.consume(sessionKey())
    if (!messageID || !rendered().includes(messageID) || !collapsibleTurnIDs().includes(messageID)) return
    setAssistantCollapsed(messageID, !isAssistantCollapsed(messageID))
  })
  const collapseAllAssistant = () => {
    const id = sessionID()
    if (!id) return
    setEntry("mode", id, "closed")
    setAssistantCollapse(
      "bySession",
      id,
      reconcile(Object.fromEntries(collapsibleTurnIDs().map((messageID) => [messageID, true] as const))),
    )
  }
  const expandAllAssistant = () => {
    const id = sessionID()
    if (!id) return
    setEntry("mode", id, "open")
    setAssistantCollapse("bySession", id, reconcile({}))
  }
  const stageCfg = { init: 1, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })
  const find = createChatFind({
    root: () => log,
    active: () => !props.mobileChanges,
  })
  const findText = createMemo(() => ({
    placeholder: language.t("ui.fileSearch.placeholder"),
    prev: language.t("ui.fileSearch.previousMatch"),
    next: language.t("ui.fileSearch.nextMatch"),
    close: language.t("ui.fileSearch.close"),
  }))

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
    pendingShare: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [share, setShare] = createStore({
    open: false,
    dismiss: null as "escape" | "outside" | null,
  })

  let more: HTMLButtonElement | undefined

  const viewShare = () => {
    const url = shareUrl()
    if (!url) return
    platform.openLink(url)
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const clearSelectionAsk = () =>
    setSelection({
      open: false,
      sourceMessageID: "",
      text: "",
      summary: "",
      anchorTop: 0,
      anchorLeft: 0,
      top: 0,
      left: 0,
    })

  const placeSelectionAsk = (input?: { top: number; left: number }) => {
    const top = input?.top ?? selection.anchorTop
    const left = input?.left ?? selection.anchorLeft
    const buttonRect = ask?.getBoundingClientRect()
    const rootRect = root?.getBoundingClientRect()
    const buttonWidth = buttonRect?.width ?? 52
    const buttonHeight = buttonRect?.height ?? 34
    const rootWidth = rootRect?.width ?? window.innerWidth
    const rootTop = rootRect?.top ?? 0
    const rootLeft = rootRect?.left ?? 0
    setSelection({
      top: Math.max(12, top - rootTop - buttonHeight - 10),
      left: Math.min(rootWidth - buttonWidth - 12, Math.max(12, left - rootLeft - buttonWidth / 2)),
    })
  }

  const selectionParent = (node: Node | null) => (node instanceof Element ? node : node?.parentElement ?? undefined)

  const selectionRects = (input: { range: Range; container: HTMLElement }) => {
    const rects: Array<{
      top: number
      left: number
      right: number
      bottom: number
      width: number
      height: number
    }> = []
    const walker = document.createTreeWalker(input.container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node instanceof Text) || !node.data.trim()) return NodeFilter.FILTER_REJECT
        if (!input.range.intersectsNode(node)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let node = walker.nextNode()
    while (node) {
      const text = node as Text
      const area = document.createRange()
      area.selectNodeContents(text)
      const overlap = document.createRange()
      if (input.range.compareBoundaryPoints(Range.START_TO_START, area) > 0) overlap.setStart(input.range.startContainer, input.range.startOffset)
      else overlap.setStart(text, 0)
      if (input.range.compareBoundaryPoints(Range.END_TO_END, area) < 0) overlap.setEnd(input.range.endContainer, input.range.endOffset)
      else overlap.setEnd(text, text.data.length)
      rects.push(
        ...Array.from(overlap.getClientRects()).map((rect) => ({
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        })),
      )
      node = walker.nextNode()
    }
    return rects
  }

  const resolveAssistantSelection = () => {
    const selection = window.getSelection()
    if (!log || !selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const text = selection.toString().trim()
    if (!text) return

    const anchor = selectionParent(selection.anchorNode)
    const focus = selectionParent(selection.focusNode)
    const anchorContainer = anchor?.closest('[data-slot="session-turn-assistant-content"]')
    const focusContainer = focus?.closest('[data-slot="session-turn-assistant-content"]')
    if (!(anchorContainer instanceof HTMLElement) || anchorContainer !== focusContainer) return
    if (!log.contains(anchorContainer)) return

    const sourceMessageID = anchorContainer.closest("[data-message-id]")?.getAttribute("data-message-id")
    if (!sourceMessageID) return

    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const target =
      resolveSelectionAnchorRect({
        rects: selectionRects({ range, container: anchorContainer }),
        containerWidth: anchorContainer.getBoundingClientRect().width,
        fallbackRect: {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
      }) ?? rect
    if (!Number.isFinite(target.top) || !Number.isFinite(target.left)) return

    const anchorLeft = (target.left + target.right) / 2
    const anchorTop = target.top
    setSelection({
      open: true,
      sourceMessageID,
      text,
      summary: summarizeReadingQuoteText(text),
      anchorTop,
      anchorLeft,
      top: anchorTop,
      left: anchorLeft,
    })
    requestAnimationFrame(() => placeSelectionAsk({ top: anchorTop, left: anchorLeft }))
  }

  const submitAssistantSelection = () => {
    if (!selection.open || !params.id) return
    const sessionID = params.id
    batch(() => {
      conversationQuote.setPendingQuestion({
        kind: "assistant-text-question",
        sessionID,
        sourceMessageID: selection.sourceMessageID,
        text: selection.text,
        summary: selection.summary,
        createdAt: Date.now(),
      })
    })
    window.getSelection()?.removeAllRanges()
    clearSelectionAsk()
    props.onFocusInput?.()
  }

  createEffect(() => {
    if (props.mobileChanges) {
      clearSelectionAsk()
      return
    }
    const handleSelectionChange = () => {
      const active = window.getSelection()
      if (!active || active.rangeCount === 0 || active.isCollapsed || !active.toString().trim()) clearSelectionAsk()
    }
    const handlePointerUp = () => {
      queueMicrotask(() => resolveAssistantSelection())
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : undefined
      if (target?.closest('[data-component="conversation-quote-ask-button"]')) return
      clearSelectionAsk()
    }
    const handleViewportChange = () => clearSelectionAsk()
    document.addEventListener("selectionchange", handleSelectionChange)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("resize", handleViewportChange)
    window.addEventListener("scroll", handleViewportChange, true)
    onCleanup(() => {
      document.removeEventListener("selectionchange", handleSelectionChange)
      document.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("resize", handleViewportChange)
      window.removeEventListener("scroll", handleViewportChange, true)
    })
  })

  createEffect(() => {
    if (!selection.open) return
    placeSelectionAsk()
  })

  const shareMutation = useMutation(() => ({
    mutationFn: (id: string) => globalSDK.client.session.share({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to share session", err)
    },
  }))

  const unshareMutation = useMutation(() => ({
    mutationFn: (id: string) => globalSDK.client.session.unshare({ sessionID: id, directory: sdk.directory }),
    onError: (err) => {
      console.error("Failed to unshare session", err)
    },
  }))

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk.client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync.set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const shareSession = () => {
    const id = sessionID()
    if (!id || shareMutation.isPending) return
    if (!shareEnabled()) return
    shareMutation.mutate(id)
  }

  const unshareSession = () => {
    const id = sessionID()
    if (!id || unshareMutation.isPending) return
    if (!shareEnabled()) return
    unshareMutation.mutate(id)
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
          pendingShare: false,
        }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID()) return
    setTitle({ editing: true, draft: titleValue() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleValue() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return

    const sessions = sync.data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sync.session
      .archive(sessionID)
      .then(() => {
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(() => sync.session.get(props.sessionID)?.title ?? language.t("command.session.new"))
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div ref={root} class="relative w-full h-full min-w-0">
        <Show when={find.open()}>
          <ChatFindBar find={find} text={findText()} />
        </Show>
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100":
              props.scroll.overflow && !props.scroll.bottom && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !props.scroll.overflow || props.scroll.bottom || staging.isStaging(),
          }}
        >
          <button
            class="pointer-events-auto size-8 flex items-center justify-center rounded-full bg-background-base border border-border-base shadow-sm text-text-base hover:bg-background-stronger transition-colors"
            onClick={props.onResumeScroll}
          >
            <Icon name="arrow-down-to-line" />
          </button>
        </div>
        <ScrollView
          viewportRef={props.setScrollRef}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return

            const root = e.currentTarget
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
            if (!props.hasScrollGesture()) return
            props.onUserScroll()
            props.onAutoScrollHandleScroll()
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full"
          style={{
            "--session-title-height": showHeader() ? "40px" : "0px",
            "--sticky-accordion-top": showHeader() ? "48px" : "0px",
          }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <Show when={showHeader()}>
              <div
                data-session-title
                classList={{
                  "sticky top-0 z-30 bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
                  "w-full": true,
                  "pb-4": true,
                  "pl-2 pr-3 md:pl-4 md:pr-3": true,
                  "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                }}
              >
                <div class="h-12 w-full flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
                    <Show when={parentID()}>
                      <IconButton
                        tabIndex={-1}
                        icon="arrow-left"
                        variant="ghost"
                        onClick={navigateParent}
                        aria-label={language.t("common.goBack")}
                      />
                    </Show>
                    <div class="flex items-center min-w-0 grow-1">
                      <div
                        class="shrink-0 flex items-center justify-center overflow-hidden transition-[width,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                        style={{
                          width: working() ? "16px" : "0px",
                          "margin-right": working() ? "8px" : "0px",
                        }}
                        aria-hidden="true"
                      >
                        <Show when={workingStatus() !== "hidden"}>
                          <div
                            class="transition-opacity duration-200 ease-out"
                            classList={{ "opacity-0": workingStatus() === "hiding" }}
                          >
                            <Spinner class="size-4" style={{ color: tint() ?? "var(--icon-interactive-base)" }} />
                          </div>
                        </Show>
                      </div>
                      <Show when={titleValue() || title.editing}>
                        <Show
                          when={title.editing}
                          fallback={
                            <h1
                              class="text-14-medium text-text-strong truncate grow-1 min-w-0"
                              onDblClick={openTitleEditor}
                            >
                              {titleValue()}
                            </h1>
                          }
                        >
                          <InlineInput
                            ref={(el) => {
                              titleRef = el
                            }}
                            value={title.draft}
                            disabled={titleMutation.isPending}
                            class="text-14-medium text-text-strong grow-1 min-w-0 rounded-[6px]"
                            style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                            onInput={(event) => setTitle("draft", event.currentTarget.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                              if (event.key === "Enter") {
                                event.preventDefault()
                                void saveTitleEditor()
                                return
                              }
                              if (event.key === "Escape") {
                                event.preventDefault()
                                closeTitleEditor()
                              }
                            }}
                            onBlur={closeTitleEditor}
                          />
                        </Show>
                      </Show>
                    </div>
                  </div>
                  <Show when={sessionID()}>
                    {(id) => (
                      <div class="shrink-0 flex items-center gap-3">
                        <SessionContextUsage placement="bottom" />
                        <DropdownMenu
                          gutter={4}
                          placement="bottom-end"
                          open={title.menuOpen}
                          onOpenChange={(open) => {
                            setTitle("menuOpen", open)
                            if (open) return
                          }}
                        >
                          <DropdownMenu.Trigger
                            as={IconButton}
                            icon="dot-grid"
                            variant="ghost"
                            class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                            classList={{
                              "bg-surface-base-active": share.open || title.pendingShare,
                            }}
                            aria-label={language.t("common.moreOptions")}
                            aria-expanded={title.menuOpen || share.open || title.pendingShare}
                            ref={(el: HTMLButtonElement) => {
                              more = el
                            }}
                          />
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              style={{ "min-width": "104px" }}
                              onCloseAutoFocus={(event) => {
                                if (title.pendingRename) {
                                  event.preventDefault()
                                  setTitle("pendingRename", false)
                                  openTitleEditor()
                                  return
                                }
                                if (title.pendingShare) {
                                  event.preventDefault()
                                  requestAnimationFrame(() => {
                                    setShare({ open: true, dismiss: null })
                                    setTitle("pendingShare", false)
                                  })
                                }
                              }}
                            >
                              <DropdownMenu.Item
                                onSelect={() => {
                                  setTitle("pendingRename", true)
                                  setTitle("menuOpen", false)
                                }}
                              >
                                <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <Show when={shareEnabled()}>
                                <DropdownMenu.Item
                                  onSelect={() => {
                                    setTitle({ pendingShare: true, menuOpen: false })
                                  }}
                                >
                                  <DropdownMenu.ItemLabel>
                                    {language.t("session.share.action.share")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </Show>
                              <Show when={collapsibleTurnIDs().length > 0}>
                                <DropdownMenu.Item
                                  onSelect={() => {
                                    setTitle("menuOpen", false)
                                    if (allAssistantCollapsed()) {
                                      expandAllAssistant()
                                      return
                                    }
                                    collapseAllAssistant()
                                  }}
                                >
                                  <DropdownMenu.ItemLabel>
                                    {allAssistantCollapsed()
                                      ? uiI18n.t("ui.sessionReview.expandAll")
                                      : uiI18n.t("ui.sessionReview.collapseAll")}
                                  </DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </Show>
                              <DropdownMenu.Item onSelect={() => void archiveSession(id())}>
                                <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item
                                onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id()} />)}
                              >
                                <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu>

                        <KobaltePopover
                          open={share.open}
                          anchorRef={() => more}
                          placement="bottom-end"
                          gutter={4}
                          modal={false}
                          onOpenChange={(open) => {
                            if (open) setShare("dismiss", null)
                            setShare("open", open)
                          }}
                        >
                          <KobaltePopover.Portal>
                            <KobaltePopover.Content
                              data-component="popover-content"
                              style={{ "min-width": "320px" }}
                              onEscapeKeyDown={(event) => {
                                setShare({ dismiss: "escape", open: false })
                                event.preventDefault()
                                event.stopPropagation()
                              }}
                              onPointerDownOutside={() => {
                                setShare({ dismiss: "outside", open: false })
                              }}
                              onFocusOutside={() => {
                                setShare({ dismiss: "outside", open: false })
                              }}
                              onCloseAutoFocus={(event) => {
                                if (share.dismiss === "outside") event.preventDefault()
                                setShare("dismiss", null)
                              }}
                            >
                              <div class="flex flex-col p-3">
                                <div class="flex flex-col gap-1">
                                  <div class="text-13-medium text-text-strong">
                                    {language.t("session.share.popover.title")}
                                  </div>
                                  <div class="text-12-regular text-text-weak">
                                    {shareUrl()
                                      ? language.t("session.share.popover.description.shared")
                                      : language.t("session.share.popover.description.unshared")}
                                  </div>
                                </div>
                                <div class="mt-3 flex flex-col gap-2">
                                  <Show
                                    when={shareUrl()}
                                    fallback={
                                      <Button
                                        size="large"
                                        variant="primary"
                                        class="w-full"
                                        onClick={shareSession}
                                        disabled={shareMutation.isPending}
                                      >
                                        {shareMutation.isPending
                                          ? language.t("session.share.action.publishing")
                                          : language.t("session.share.action.publish")}
                                      </Button>
                                    }
                                  >
                                    <div class="flex flex-col gap-2">
                                      <TextField
                                        value={shareUrl() ?? ""}
                                        readOnly
                                        copyable
                                        copyKind="link"
                                        tabIndex={-1}
                                        class="w-full"
                                      />
                                      <div class="grid grid-cols-2 gap-2">
                                        <Button
                                          size="large"
                                          variant="secondary"
                                          class="w-full shadow-none border border-border-weak-base"
                                          onClick={unshareSession}
                                          disabled={unshareMutation.isPending}
                                        >
                                          {unshareMutation.isPending
                                            ? language.t("session.share.action.unpublishing")
                                            : language.t("session.share.action.unpublish")}
                                        </Button>
                                        <Button
                                          size="large"
                                          variant="primary"
                                          class="w-full"
                                          onClick={viewShare}
                                          disabled={unshareMutation.isPending}
                                        >
                                          {language.t("session.share.action.view")}
                                        </Button>
                                      </div>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            </KobaltePopover.Content>
                          </KobaltePopover.Portal>
                        </KobaltePopover>
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </Show>
            <div
              ref={log}
              role="log"
              data-slot="session-turn-list"
              class="flex flex-col items-start justify-start pb-16 transition-[margin]"
              classList={{
                "w-full": true,
                "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0 || props.historyMore}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-12-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={props.onLoadEarlier}
                  >
                    {props.historyLoading
                      ? language.t("session.messages.loadingEarlier")
                      : language.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              <For each={rendered()}>
                {(messageID) => {
                  const active = createMemo(() => activeMessageID() === messageID)
                  const comments = createMemo(() => messageComments(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) =>
                      a.length === b.length &&
                      a.every(
                        (c, i) =>
                          c.path === b[i].path &&
                          c.comment === b[i].comment &&
                          c.selection?.startLine === b[i].selection?.startLine &&
                          c.selection?.endLine === b[i].selection?.endLine,
                      ),
                  })
                  const readingQuotes = createMemo(() => messageReadingQuotes(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) =>
                      a.length === b.length &&
                      a.every(
                        (quote, i) =>
                          quote.mode === b[i].mode &&
                          quote.action === b[i].action &&
                          quote.contentType === b[i].contentType &&
                          quote.pdfFileName === b[i].pdfFileName &&
                          quote.startPage === b[i].startPage &&
                          quote.endPage === b[i].endPage &&
                          quote.summary === b[i].summary &&
                          quote.fullText === b[i].fullText &&
                          quote.imageDataUrl === b[i].imageDataUrl,
                      ),
                  })
                  const conversationQuotes = createMemo(() => messageConversationQuotes(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) =>
                      a.length === b.length &&
                      a.every(
                        (quote, i) =>
                          quote.kind === b[i].kind &&
                          quote.source === b[i].source &&
                          quote.action === b[i].action &&
                          quote.sourceMessageID === b[i].sourceMessageID &&
                          quote.summary === b[i].summary &&
                          quote.fullText === b[i].fullText,
                      ),
                  })
                  const commentCount = createMemo(() => comments().length)
                  const readingQuoteCount = createMemo(() => readingQuotes().length)
                  const conversationQuoteCount = createMemo(() => conversationQuotes().length)
                  return (
                    <div
                      id={props.anchor(messageID)}
                      data-message-id={messageID}
                      data-assistant-collapsed={isAssistantCollapsed(messageID) ? "true" : undefined}
                      classList={{
                        "min-w-0 w-full max-w-full": true,
                        "md:max-w-200 2xl:max-w-[1000px]": props.centered,
                      }}
                      style={{
                        "content-visibility": "auto",
                        "contain-intrinsic-size": isAssistantCollapsed(messageID) ? "auto 20px" : "auto 500px",
                      }}
                    >
                      <Show when={commentCount() > 0 || readingQuoteCount() > 0 || conversationQuoteCount() > 0}>
                        <div class="w-full px-4 md:px-5 pb-2">
                          <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                            <div class="flex w-max min-w-full justify-end gap-2">
                              <Index each={comments()}>
                                {(commentAccessor: () => MessageComment) => {
                                  const comment = createMemo(() => commentAccessor())
                                  return (
                                    <Show when={comment()}>
                                      {(c) => (
                                        <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                                          <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                                            <FileIcon
                                              node={{ path: c().path, type: "file" }}
                                              class="size-3.5 shrink-0"
                                            />
                                            <span class="truncate">{getFilename(c().path)}</span>
                                            <Show when={c().selection}>
                                              {(selection) => (
                                                <span class="shrink-0 text-text-weak">
                                                  {selection().startLine === selection().endLine
                                                    ? `:${selection().startLine}`
                                                    : `:${selection().startLine}-${selection().endLine}`}
                                                </span>
                                              )}
                                            </Show>
                                          </div>
                                          <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                                            {c().comment}
                                          </div>
                                        </div>
                                      )}
                                    </Show>
                                  )
                                }}
                              </Index>
                              <Index each={readingQuotes()}>
                                {(quoteAccessor: () => MessageReadingQuote) => {
                                  const quote = createMemo(() => quoteAccessor())
                                  return (
                                    <Show when={quote()}>
                                      {(q) => (
                                        <button
                                          type="button"
                                          class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2 text-left transition hover:bg-background-base"
                                          onClick={() => {
                                            dialog.show(() => <DialogReadingQuoteTextContent quote={q()} />)
                                          }}
                                        >
                                          <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                                            <FileIcon
                                              node={{ path: q().pdfFileName, type: "file" }}
                                              class="size-3.5 shrink-0"
                                            />
                                            <span class="truncate">{q().pdfFileName}</span>
                                          </div>
                                          <div class="pt-1 text-11-medium text-text-weak">
                                            {`p.${formatReadingPageRange(q())} · ${q().action === "ask" ? "Ask" : "Translate"}`}
                                          </div>
                                          <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words line-clamp-3">
                                            {q().summary}
                                          </div>
                                        </button>
                                      )}
                                    </Show>
                                  )
                                }}
                              </Index>
                              <Index each={conversationQuotes()}>
                                {(quoteAccessor: () => MessageConversationQuote) => {
                                  const quote = createMemo(() => quoteAccessor())
                                  return (
                                    <Show when={quote()}>
                                      {(q) => (
                                        <button
                                          type="button"
                                          class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2 text-left transition hover:bg-background-base"
                                          onClick={() => {
                                            dialog.show(() => <DialogConversationQuoteTextContent quote={q()} />)
                                          }}
                                        >
                                          <div class="pt-1 text-11-medium text-text-weak">Ask</div>
                                          <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words line-clamp-3">
                                            {q().summary}
                                          </div>
                                        </button>
                                      )}
                                    </Show>
                                  )
                                }}
                              </Index>
                            </div>
                          </div>
                        </div>
                      </Show>
                      <SessionTurn
                        sessionID={sessionID() ?? ""}
                        messageID={messageID}
                        messages={sessionMessages()}
                        actions={props.actions}
                        assistantCollapsed={isAssistantCollapsed(messageID)}
                        onAssistantCollapsedChange={(collapsed) => setAssistantCollapsed(messageID, collapsed)}
                        active={active()}
                        status={active() ? sessionStatus() : undefined}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        classes={{
                          root: "min-w-0 w-full relative",
                          content: "flex flex-col justify-between !overflow-visible",
                          container: "w-full px-4 md:px-5",
                        }}
                      />
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </ScrollView>
        <Show when={selection.open}>
          <button
            ref={ask}
            type="button"
            data-component="conversation-quote-ask-button"
            class="absolute z-50 rounded-full border border-border-weak-base bg-background-stronger px-3 py-1.5 text-12-medium text-text-strong shadow-lg transition hover:bg-background-base"
            style={{
              top: `${selection.top}px`,
              left: `${selection.left}px`,
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={() => submitAssistantSelection()}
          >
            Ask
          </button>
        </Show>
      </div>
    </Show>
  )
}
