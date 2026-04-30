import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({
  treeTab: "changes" as "changes" | "all",
  diffPath: "src/note.ts",
  opened: [] as string[],
  active: [] as string[],
  loaded: [] as string[],
  focused: [] as string[],
  reviewOpened: 0,
  selected: new Set<string>(),
}))

vi.mock("@solid-primitives/media", () => ({
  createMediaQuery: () => () => true,
}))

vi.mock("@opencode-ai/ui/tabs", () => {
  const Tabs = (props: { children?: unknown }) => props.children
  Tabs.List = (props: { children?: unknown }) => <div>{props.children}</div>
  Tabs.Trigger = (props: { children?: unknown; value: string; onClick?: () => void }) => (
    <button
      type="button"
      data-trigger={props.value}
      onClick={() => {
        state.treeTab = props.value === "all" ? "all" : props.value === "changes" ? "changes" : state.treeTab
        props.onClick?.()
      }}
    >
      {props.children}
    </button>
  )
  Tabs.Content = (props: { children?: unknown; value: string }) =>
    props.value === state.treeTab || props.value === "review" || props.value === "empty" ? props.children : null
  return { Tabs }
})

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { children?: unknown; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
vi.mock("@opencode-ai/ui/tooltip", () => ({
  TooltipKeybind: (props: { children?: unknown }) => props.children,
  Tooltip: (props: { children?: unknown }) => props.children,
}))
vi.mock("@opencode-ai/ui/resize-handle", () => ({ ResizeHandle: () => null }))
vi.mock("@opencode-ai/ui/logo", () => ({ Mark: () => null }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children?: unknown }) => props.children }))
vi.mock("@opencode-ai/ui/dropdown-menu", () => ({
  DropdownMenu: Object.assign((props: { children?: unknown }) => props.children, {
    Trigger: (props: { children?: unknown }) => props.children,
    Portal: (props: { children?: unknown }) => props.children,
    Content: (props: { children?: unknown }) => props.children,
    Item: (props: { children?: unknown }) => props.children,
    ItemLabel: (props: { children?: unknown }) => props.children,
  }),
}))

vi.mock("@thisbeyond/solid-dnd", () => ({
  DragDropProvider: (props: { children?: unknown }) => props.children,
  DragDropSensors: () => null,
  DragOverlay: (props: { children?: unknown }) => props.children,
  SortableProvider: (props: { children?: unknown }) => props.children,
  closestCenter: () => undefined,
}))

vi.mock("@/utils/solid-dnd", () => ({
  ConstrainDragYAxis: () => null,
  getDraggableId: () => undefined,
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined, close: () => undefined }),
}))

vi.mock("@/components/file-tree", () => ({
  default: (props: {
    allowed?: string[]
    modified?: string[]
    onFileClick?: (node: { path: string }, event?: MouseEvent) => void
  }) => (
    <button
      type="button"
      data-filetree={props.allowed ? "changes" : "all"}
      data-allowed={(props.allowed ?? []).join(",")}
      data-modified={(props.modified ?? []).join(",")}
      onClick={(event) => props.onFileClick?.({ path: state.diffPath }, event)}
    >
      {props.allowed ? "changes-tree" : "all-tree"}
    </button>
  ),
}))

vi.mock("@/components/session-context-usage", () => ({ SessionContextUsage: () => null }))
vi.mock("@/components/dialog-select-file", () => ({ DialogSelectFile: () => null }))
vi.mock("@/components/dialog-pdf-to-markdown", () => ({ DialogPdfToMarkdown: () => null }))
vi.mock("@/components/dialog-batch-pdf-convert", () => ({ DialogBatchPdfConvert: () => null }))
vi.mock("@/components/session", () => ({
  SessionContextTab: () => null,
  SortableTab: () => null,
  FileVisual: () => null,
}))

vi.mock("@/context/command", () => ({
  useCommand: () => ({ keybind: () => "" }),
}))

vi.mock("@/context/file", () => ({
  useFile: () => ({
    ready: () => true,
    selectedPaths: () => state.selected,
    setSelectedPaths: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      state.selected = typeof next === "function" ? next(state.selected) : next
    },
    selectedLines: () => null,
    tree: {
      state: () => ({ loaded: true }),
      children: () => [
        { name: "note.ts", path: state.diffPath, absolute: state.diffPath, type: "file", ignored: false },
      ],
      refresh: () => Promise.resolve(),
      expand: () => undefined,
    },
    tab: (path: string) => `file://${path.startsWith("file://") ? path.slice("file://".length) : path}`,
    pathFromTab: (tab: string) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
    load: (path: string) => {
      state.loaded.push(path)
      return Promise.resolve()
    },
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/context/layout", () => ({
  useLayout: () => ({
    fileTree: {
      opened: () => true,
      width: () => 320,
      tab: () => state.treeTab,
      setTab: (value: "changes" | "all") => {
        state.treeTab = value
      },
      resize: () => undefined,
    },
    session: {
      width: () => 600,
    },
  }),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web" }),
}))

vi.mock("@/context/sync", () => ({
  useSync: () => ({
    status: "ready",
    data: {},
    session: {
      diff: () => Promise.resolve(),
    },
  }),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "http://local",
    directory: "/tmp/project",
    client: {
      file: {
        summarize: async () => ({ data: { count: 0 } }),
      },
    },
  }),
}))

vi.mock("@/context/server", () => ({
  useServer: () => ({ current: undefined }),
}))

vi.mock("@/components/pdf-convert-progress", () => ({
  registerOpenFileCallback: () => undefined,
  registerRefreshDirCallback: () => undefined,
  restoreActiveTasks: () => Promise.resolve(),
}))

vi.mock("@/pages/session/file-tab-scroll", () => ({
  createFileTabListSync: () => () => undefined,
}))

vi.mock("@/pages/session/file-tabs", () => ({
  FileTabContent: () => null,
}))

vi.mock("@/pages/session/handoff", () => ({
  setSessionHandoff: () => undefined,
}))

vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { dir: "dir", id: "session" },
    sessionKey: () => "dir/session",
    tabs: () => ({
      active: () => undefined,
      all: () => [],
      open: (tab: string) => state.opened.push(tab),
      setActive: (tab: string) => state.active.push(tab),
      close: () => undefined,
      move: () => undefined,
    }),
    view: () => ({
      reviewPanel: {
        opened: () => false,
        open: () => {
          state.reviewOpened += 1
        },
      },
    }),
  }),
}))

vi.mock("./download", () => ({
  save: () => undefined,
}))

vi.mock("./upload", () => ({
  fromDir: () => [],
  fromDrop: () => [],
  fromList: () => [],
  isExternal: () => false,
  send: () => Promise.resolve(),
}))

import { SessionSidePanel } from "./session-side-panel"

function mount(tab: "changes" | "all", focus: ReturnType<typeof vi.fn>) {
  state.treeTab = tab
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <SessionSidePanel
        canReview={() => true}
        diffs={() => [
          { file: state.diffPath, status: "modified", before: "", after: "x\n", additions: 1, deletions: 0 },
        ]}
        diffsReady={() => true}
        empty={() => "empty"}
        onRefresh={() => undefined}
        onVcsRefresh={() => undefined}
        hasReview={() => true}
        reviewCount={() => 1}
        reviewPanel={() => <div>review</div>}
        focusReviewDiff={focus}
        reviewSnap={false}
        size={{ active: () => false, start: () => undefined, touch: () => undefined }}
        reviewOpenOverride={false}
        fileOpenOverride={true}
      />
    ),
    host,
  )
  return { host, off }
}

beforeEach(() => {
  document.body.innerHTML = ""
  state.opened = []
  state.active = []
  state.loaded = []
  state.focused = []
  state.reviewOpened = 0
  state.selected = new Set()
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("session side panel changes tree wiring", () => {
  test("changes tab passes diff files as allowed and focuses review diffs on click", async () => {
    const focus = vi.fn((path: string) => state.focused.push(path))
    const { host, off } = mount("changes", focus)

    await Promise.resolve()

    const btn = host.querySelector('[data-filetree="changes"]') as HTMLButtonElement | null
    expect(btn?.dataset.allowed).toBe(state.diffPath)
    expect(btn?.dataset.modified).toBe("")

    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    expect(focus).toHaveBeenCalledWith(state.diffPath)
    expect(state.opened).toEqual([])
    expect(state.loaded).toEqual([])

    off()
  })

  test("all tab passes diff files as modified and opens the file on click", async () => {
    const focus = vi.fn()
    const { host, off } = mount("all", focus)

    await Promise.resolve()

    const btn = host.querySelector('[data-filetree="all"]') as HTMLButtonElement | null
    expect(btn?.dataset.allowed).toBe("")
    expect(btn?.dataset.modified).toBe(state.diffPath)

    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    expect(focus).not.toHaveBeenCalled()
    expect(state.loaded).toEqual([state.diffPath])
    expect(state.opened).toEqual([`file://${state.diffPath}`])
    expect(state.active).toEqual([`file://${state.diffPath}`])
    expect(state.reviewOpened).toBe(1)

    off()
  })
})
