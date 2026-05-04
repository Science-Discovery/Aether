import type { AssistantMessage, Message, Session, SessionGraphNode, SessionGraphResult } from "@opencode-ai/sdk/v2"
import { batch, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { same } from "@/utils/same"

const emptyTabs: string[] = []

type Tabs = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}

type TabsInput = {
  tabs: Accessor<Tabs>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  review?: Accessor<boolean>
  hasReview?: Accessor<boolean>
}

export const getSessionKey = (dir: string | undefined, id: string | undefined) => `${dir ?? ""}${id ? `/${id}` : ""}`

export const createSessionTabs = (input: TabsInput) => {
  const review = input.review ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const contextOpen = createMemo(() => input.tabs().active() === "context" || input.tabs().all().includes("context"))
  const gitGraphOpen = createMemo(
    () => input.tabs().active() === "git-graph" || input.tabs().all().includes("git-graph"),
  )
  const openedTabs = createMemo(
    () => {
      const seen = new Set<string>()
      return input
        .tabs()
        .all()
        .flatMap((tab) => {
          if (tab === "context" || tab === "review" || tab === "git-graph") return []
          const value = input.pathFromTab(tab) ? input.normalizeTab(tab) : tab
          if (seen.has(value)) return []
          seen.add(value)
          return [value]
        })
    },
    emptyTabs,
    { equals: same },
  )
  const activeTab = createMemo(() => {
    const active = input.tabs().active()
    if (active === "context") return active
    if (active === "git-graph") return active
    if (active === "review" && review()) return active
    if (active && input.pathFromTab(active)) return input.normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (gitGraphOpen()) return "git-graph"
    if (review() && hasReview()) return "review"
    return "empty"
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })
  const closableTab = createMemo(() => {
    const active = activeTab()
    if (active === "context") return active
    if (active === "git-graph") return active
    if (!openedTabs().includes(active)) return
    return active
  })

  return {
    contextOpen,
    gitGraphOpen,
    openedTabs,
    activeTab,
    activeFileTab,
    closableTab,
  }
}

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

const skip = new Set(["Alt", "Control", "Meta", "Shift"])

export const shouldFocusTerminalOnKeyDown = (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) => {
  if (skip.has(event.key)) return false
  return !(event.ctrlKey || event.metaKey || event.altKey)
}

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => any | Promise<void>
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const maybePromise = input.loadFile(path)
      const open = () => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      }
      if (maybePromise instanceof Promise) maybePromise.then(open)
      else open()
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  openReviewPanel: () => void
  setActive: (tab: string) => void
}) => {
  return (value: string) => {
    const next = input.normalizeTab(value)
    input.openTab(next)

    const path = input.pathFromTab(next)
    if (!path) return

    input.loadFile(path)
    input.openReviewPanel()
    input.setActive(next)
  }
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  let t: number | undefined

  const stop = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", false)
  }

  const start = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", true)
  }

  onMount(() => {
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
    onCleanup(() => {
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
    })
  })

  onCleanup(() => {
    if (t !== undefined) clearTimeout(t)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      t = window.setTimeout(stop, 120)
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>

const isCompletedAssistantMessage = (message: Message): message is AssistantMessage =>
  message.role === "assistant" && typeof message.time.completed === "number" && !message.error

export const collectCompletedTurnUserMessageIDs = (messages: Message[]) => {
  const completedParentIDs = new Set(messages.filter(isCompletedAssistantMessage).map((message) => message.parentID))
  return messages
    .filter((message): message is Extract<Message, { role: "user" }> => message.role === "user")
    .filter((message) => completedParentIDs.has(message.id))
    .map((message) => message.id)
}

export const getSelectedTurnBoundaryIndex = (messages: Message[], selectedMessageID: string) => {
  const completedUserMessageIDs = new Set(collectCompletedTurnUserMessageIDs(messages))
  let completedCount = 0

  for (const message of messages) {
    if (message.role !== "user") continue
    if (completedUserMessageIDs.has(message.id)) completedCount += 1
    if (message.id === selectedMessageID) return completedCount
  }
}

const getCurrentPathTurnNodes = (graph: Extract<SessionGraphResult, { kind: "graph" }>) => {
  const nodesByID = new Map(graph.nodes.map((node) => [node.id, node] as const))
  return graph.current.pathNodeIDs
    .map((nodeID) => nodesByID.get(nodeID))
    .filter((node): node is SessionGraphNode => !!node && node.kind === "turn")
}

export const getInheritedTurnCount = (input: {
  sessionID: string
  graph: Extract<SessionGraphResult, { kind: "graph" }>
}) => {
  let count = 0
  for (const node of getCurrentPathTurnNodes(input.graph)) {
    if (node.sessionID === input.sessionID) break
    count += 1
  }
  return count
}

export const hasProtectedDescendantBranch = (input: {
  sessionID: string
  graph: Extract<SessionGraphResult, { kind: "graph" }>
  fromTurnIndex: number
}) => {
  if (input.fromTurnIndex <= 0) return false

  const pathTurnNodes = getCurrentPathTurnNodes(input.graph)
  if (pathTurnNodes.length === 0) return false

  const nodesByID = new Map(input.graph.nodes.map((node) => [node.id, node] as const))
  const outgoingByNodeID = new Map<string, typeof input.graph.edges>()

  for (const edge of input.graph.edges) {
    const edges = outgoingByNodeID.get(edge.from)
    if (edges) edges.push(edge)
    else outgoingByNodeID.set(edge.from, [edge])
  }

  for (const node of pathTurnNodes.slice(input.fromTurnIndex - 1)) {
    for (const edge of outgoingByNodeID.get(node.id) ?? []) {
      if (edge.kind === "continuation") continue
      const target = nodesByID.get(edge.to)
      if (!target) continue
      if (target.sessionID !== input.sessionID) return true
    }
  }

  return false
}

export type RevertProtectionReason = "inherited-prefix" | "descendant-branch" | "incomplete-turn-inherited-prefix"

export type RevertProtectionResult = { protected: false } | { protected: true; reason: RevertProtectionReason }

export const shouldProtectSessionRevert = (input: {
  session: Pick<Session, "id" | "forkParentSessionID">
  messages: Message[]
  selectedMessageID: string
  graph?: SessionGraphResult
}): RevertProtectionResult => {
  const targetTurnIndex = getSelectedTurnBoundaryIndex(input.messages, input.selectedMessageID)
  if (!targetTurnIndex || !input.graph || input.graph.kind !== "graph") return { protected: false }

  const isIncomplete = isIncompleteTurn(input.messages, input.selectedMessageID)

  if (input.session.forkParentSessionID) {
    const inheritedTurnCount = getInheritedTurnCount({
      sessionID: input.session.id,
      graph: input.graph,
    })
    if (targetTurnIndex <= inheritedTurnCount) {
      const reason: RevertProtectionReason = isIncomplete ? "incomplete-turn-inherited-prefix" : "inherited-prefix"
      return { protected: true, reason }
    }
  }

  if (
    hasProtectedDescendantBranch({
      sessionID: input.session.id,
      graph: input.graph,
      fromTurnIndex: targetTurnIndex,
    })
  ) {
    return { protected: true, reason: "descendant-branch" }
  }

  return { protected: false }
}

const isIncompleteTurn = (messages: Message[], selectedMessageID: string) => {
  const completed = new Set(collectCompletedTurnUserMessageIDs(messages))
  for (const message of messages) {
    if (message.role !== "user") continue
    if (message.id === selectedMessageID) return !completed.has(message.id)
  }
  return false
}
