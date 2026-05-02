import type { Message, SessionGraphResult } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  collectCompletedTurnUserMessageIDs,
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionTabs,
  focusTerminalById,
  getTabReorderIndex,
  getInheritedTurnCount,
  getSelectedTurnBoundaryIndex,
  hasProtectedDescendantBranch,
  shouldFocusTerminalOnKeyDown,
  shouldProtectSessionRevert,
} from "./helpers"

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("shouldFocusTerminalOnKeyDown", () => {
  test("skips pure modifier keys", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Alt", altKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }))).toBe(false)
  })

  test("skips shortcut key combos", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }))).toBe(false)
  })

  test("keeps plain typing focused on terminal", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "a" }))).toBe(true)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "A", shiftKey: true }))).toBe(true)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("prefers context and review fallbacks when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("context")
      expect(result.closableTab()).toBe("context")
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })
})

const user = (id: string, created: number, sessionID = "session-root"): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created },
  agent: "test",
  model: { providerID: "provider", modelID: "model" },
})

const assistant = (id: string, parentID: string, created: number, completed: number, sessionID = "session-root"): Message => ({
  id,
  sessionID,
  role: "assistant",
  time: { created, completed },
  parentID,
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "test",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
})

const graph = (input: {
  currentSessionID: string
  nodes: Extract<SessionGraphResult, { kind: "graph" }>["nodes"]
  edges: Extract<SessionGraphResult, { kind: "graph" }>["edges"]
  pathNodeIDs: string[]
}): Extract<SessionGraphResult, { kind: "graph" }> => ({
  kind: "graph",
  treeID: "tree-1",
  current: {
    sessionID: input.currentSessionID,
    pathNodeIDs: input.pathNodeIDs,
    latestNodeID: input.pathNodeIDs[input.pathNodeIDs.length - 1],
  },
  nodes: input.nodes,
  edges: input.edges,
})

describe("chat-tree revert protection helpers", () => {
  test("collects completed user turns and selected boundary index", () => {
    const messages = [
      user("u1", 1),
      assistant("a1", "u1", 2, 3),
      user("u2", 4),
      assistant("a2", "u2", 5, 6),
      user("u3", 7),
    ]

    expect(collectCompletedTurnUserMessageIDs(messages)).toEqual(["u1", "u2"])
    expect(getSelectedTurnBoundaryIndex(messages, "u1")).toBe(1)
    expect(getSelectedTurnBoundaryIndex(messages, "u2")).toBe(2)
    expect(getSelectedTurnBoundaryIndex(messages, "u3")).toBe(2)
  })

  test("counts inherited turns on a branch path", () => {
    const payload = graph({
      currentSessionID: "session-child",
      pathNodeIDs: ["n1", "n2", "n3"],
      nodes: [
        { id: "n1", kind: "turn", sessionID: "session-root", lane: 0, row: 0, time: 1, label: "1", userMessageID: "u1", origin: "tree" },
        { id: "n2", kind: "turn", sessionID: "session-root", lane: 0, row: 1, time: 2, label: "2", userMessageID: "u2", origin: "tree" },
        { id: "n3", kind: "turn", sessionID: "session-child", lane: 1, row: 2, time: 3, label: "3", userMessageID: "u3", origin: "tree" },
      ],
      edges: [
        { id: "n1->n2", from: "n1", to: "n2", kind: "continuation", style: "solid" },
        { id: "n2->n3", from: "n2", to: "n3", kind: "branch", style: "solid" },
      ],
    })

    expect(getInheritedTurnCount({ sessionID: "session-child", graph: payload })).toBe(2)
  })

  test("detects descendant branches from the selected turn onward", () => {
    const payload = graph({
      currentSessionID: "session-root",
      pathNodeIDs: ["n1", "n2", "n3"],
      nodes: [
        { id: "n1", kind: "turn", sessionID: "session-root", lane: 0, row: 0, time: 1, label: "1", userMessageID: "u1", origin: "tree" },
        { id: "n2", kind: "turn", sessionID: "session-root", lane: 0, row: 1, time: 2, label: "2", userMessageID: "u2", origin: "tree" },
        { id: "n3", kind: "turn", sessionID: "session-root", lane: 0, row: 2, time: 3, label: "3", userMessageID: "u3", origin: "tree" },
        { id: "n4", kind: "turn", sessionID: "session-child", lane: 1, row: 3, time: 4, label: "branch", userMessageID: "u4", origin: "tree" },
      ],
      edges: [
        { id: "n1->n2", from: "n1", to: "n2", kind: "continuation", style: "solid" },
        { id: "n2->n3", from: "n2", to: "n3", kind: "continuation", style: "solid" },
        { id: "n2->n4", from: "n2", to: "n4", kind: "branch", style: "solid" },
      ],
    })

    expect(hasProtectedDescendantBranch({ sessionID: "session-root", graph: payload, fromTurnIndex: 1 })).toBe(true)
    expect(hasProtectedDescendantBranch({ sessionID: "session-root", graph: payload, fromTurnIndex: 2 })).toBe(true)
    expect(hasProtectedDescendantBranch({ sessionID: "session-root", graph: payload, fromTurnIndex: 3 })).toBe(false)
  })

  test("protects inherited-prefix revert on branch sessions", () => {
    const messages = [
      user("u1", 1, "session-child"),
      assistant("a1", "u1", 2, 3, "session-child"),
      user("u2", 4, "session-child"),
      assistant("a2", "u2", 5, 6, "session-child"),
      user("u3", 7, "session-child"),
      assistant("a3", "u3", 8, 9, "session-child"),
    ]
    const payload = graph({
      currentSessionID: "session-child",
      pathNodeIDs: ["n1", "n2", "n3"],
      nodes: [
        { id: "n1", kind: "turn", sessionID: "session-root", lane: 0, row: 0, time: 1, label: "1", userMessageID: "root-1", origin: "tree" },
        { id: "n2", kind: "turn", sessionID: "session-root", lane: 0, row: 1, time: 2, label: "2", userMessageID: "root-2", origin: "tree" },
        { id: "n3", kind: "turn", sessionID: "session-child", lane: 1, row: 2, time: 3, label: "3", userMessageID: "child-3", origin: "tree" },
      ],
      edges: [
        { id: "n1->n2", from: "n1", to: "n2", kind: "continuation", style: "solid" },
        { id: "n2->n3", from: "n2", to: "n3", kind: "branch", style: "solid" },
      ],
    })

    expect(
      shouldProtectSessionRevert({
        session: { id: "session-child", forkParentSessionID: "session-root" },
        messages,
        selectedMessageID: "u1",
        graph: payload,
      }),
    ).toEqual({ protected: true, reason: "inherited-prefix" })
    expect(
      shouldProtectSessionRevert({
        session: { id: "session-child", forkParentSessionID: "session-root" },
        messages,
        selectedMessageID: "u3",
        graph: payload,
      }),
    ).toEqual({ protected: false })
  })

  test("protects root revert when a later branch already depends on it", () => {
    const messages = [
      user("u1", 1),
      assistant("a1", "u1", 2, 3),
      user("u2", 4),
      assistant("a2", "u2", 5, 6),
      user("u3", 7),
      assistant("a3", "u3", 8, 9),
    ]
    const payload = graph({
      currentSessionID: "session-root",
      pathNodeIDs: ["n1", "n2", "n3"],
      nodes: [
        { id: "n1", kind: "turn", sessionID: "session-root", lane: 0, row: 0, time: 1, label: "1", userMessageID: "u1", origin: "tree" },
        { id: "n2", kind: "turn", sessionID: "session-root", lane: 0, row: 1, time: 2, label: "2", userMessageID: "u2", origin: "tree" },
        { id: "n3", kind: "turn", sessionID: "session-root", lane: 0, row: 2, time: 3, label: "3", userMessageID: "u3", origin: "tree" },
        { id: "n4", kind: "bud", sessionID: "session-child", lane: 1, row: 3, time: 4, label: "...", origin: "external" },
      ],
      edges: [
        { id: "n1->n2", from: "n1", to: "n2", kind: "continuation", style: "solid" },
        { id: "n2->n3", from: "n2", to: "n3", kind: "continuation", style: "solid" },
        { id: "n2->n4", from: "n2", to: "n4", kind: "bud", style: "dashed" },
      ],
    })

    expect(
      shouldProtectSessionRevert({
        session: { id: "session-root", forkParentSessionID: undefined },
        messages,
        selectedMessageID: "u2",
        graph: payload,
      }),
    ).toEqual({ protected: true, reason: "descendant-branch" })
    expect(
      shouldProtectSessionRevert({
        session: { id: "session-root", forkParentSessionID: undefined },
        messages,
        selectedMessageID: "u3",
        graph: payload,
      }),
    ).toEqual({ protected: false })
  })

  test("detects incomplete-turn-inherited-prefix protection", () => {
    const inherited = [
      user("u1", 1, "session-child"),
      assistant("a1", "u1", 2, 3, "session-child"),
      user("u2", 4, "session-child"),
      assistant("a2", "u2", 5, 6, "session-child"),
    ]
    const ownIncomplete = [user("u3", 7, "session-child")]
    const messages = [...inherited, ...ownIncomplete]
    const payload = graph({
      currentSessionID: "session-child",
      pathNodeIDs: ["n1", "n2"],
      nodes: [
        { id: "n1", kind: "turn", sessionID: "session-root", lane: 0, row: 0, time: 1, label: "1", userMessageID: "root-1", origin: "tree" },
        { id: "n2", kind: "turn", sessionID: "session-root", lane: 0, row: 1, time: 2, label: "2", userMessageID: "root-2", origin: "tree" },
      ],
      edges: [{ id: "n1->n2", from: "n1", to: "n2", kind: "continuation", style: "solid" }],
    })

    expect(
      shouldProtectSessionRevert({
        session: { id: "session-child", forkParentSessionID: "session-root" },
        messages,
        selectedMessageID: "u3",
        graph: payload,
      }),
    ).toEqual({ protected: true, reason: "incomplete-turn-inherited-prefix" })
  })
})
