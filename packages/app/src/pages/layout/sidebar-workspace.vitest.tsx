import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { WorkspaceSessionList, type WorkspaceSidebarContext } from "./sidebar-workspace"
import type { useLanguage } from "@/context/language"

vi.mock("./sidebar-items", () => ({
  NewSessionItem: () => null,
  SessionItem: () => null,
  SessionSkeleton: () => null,
  StatusDot: () => null,
}))

vi.mock("@/context/settings", () => ({
  useSettings: () => ({ general: { branchesTab: () => false } }),
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { icon?: string; onClick?: (event: MouseEvent) => void; "aria-label"?: string }) => (
    <button type="button" data-icon={props.icon} aria-label={props["aria-label"]} onClick={props.onClick} />
  ),
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
}))

type Language = ReturnType<typeof useLanguage>

const language = { t: (key: string) => key } as Language

const ctx = {
  currentDir: () => "",
  navList: () => [],
  sidebarHovering: () => false,
  setHoverSession: () => undefined,
  clearHoverProjectSoon: () => undefined,
  prefetchSession: () => undefined,
  archiveSession: () => Promise.resolve(),
  createSession: () => Promise.resolve(),
  deleteSession: () => Promise.resolve(),
  renameSession: () => Promise.resolve(),
  workspaceName: () => undefined,
  renameWorkspace: () => undefined,
  renameBranch: () => Promise.resolve(),
  editorOpen: () => false,
  openEditor: () => undefined,
  closeEditor: () => undefined,
  setEditor: () => undefined,
  InlineEditor: () => null,
  isBusy: () => false,
  workspaceExpanded: () => true,
  setWorkspaceExpanded: () => undefined,
  sessionExpanded: () => false,
  setSessionExpanded: () => undefined,
  conversationTreeOpen: () => false,
  setConversationTreeOpen: () => undefined,
  conversationTreeLastFocus: () => undefined,
  setConversationTreeLastFocus: () => undefined,
  showResetWorkspaceDialog: () => undefined,
  showDeleteWorkspaceDialog: () => undefined,
  setScrollContainerRef: () => undefined,
} as unknown as WorkspaceSidebarContext

function mount(props: {
  hasMore: boolean
  canCollapse: boolean
  loadMore: () => Promise<void>
  collapseAll: () => Promise<void>
}) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <WorkspaceSessionList
        slug={() => "slug"}
        currentSessionID={() => undefined}
        ctx={ctx}
        loading={() => false}
        rootSessions={() => []}
        allSessions={() => []}
        children={() => new Map()}
        language={language}
        selectMode={() => false}
        selectedIds={() => new Set()}
        total={() => 0}
        onToggleSelect={() => undefined}
        onSelectAll={() => undefined}
        onDeselectAll={() => undefined}
        onBatchArchive={() => Promise.resolve()}
        onBatchDelete={() => undefined}
        onCancelSelect={() => undefined}
        hasMore={() => props.hasMore}
        canCollapse={() => props.canCollapse}
        loadMore={props.loadMore}
        collapseAll={props.collapseAll}
      />
    ),
    host,
  )
  return { host, off }
}

beforeEach(() => {
  document.body.innerHTML = ""
})

afterEach(() => {
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

describe("WorkspaceSessionList load-more row", () => {
  test("shows load-more and collapse-all icons side by side when expanded", async () => {
    const loadMore = vi.fn(() => Promise.resolve())
    const collapseAll = vi.fn(() => Promise.resolve())
    const { host, off } = mount({ hasMore: true, canCollapse: true, loadMore, collapseAll })

    const load = host.querySelector<HTMLButtonElement>('[aria-label="common.loadMore"]')
    const collapse = host.querySelector<HTMLButtonElement>('[aria-label="common.collapseAll"]')
    expect(load).not.toBeNull()
    expect(collapse).not.toBeNull()
    expect(load!.dataset.icon).toBe("chevron-double-down")
    expect(collapse!.dataset.icon).toBe("chevron-double-down")

    load!.click()
    await Promise.resolve()
    expect(loadMore).toHaveBeenCalledTimes(1)
    expect(collapseAll).not.toHaveBeenCalled()

    collapse!.click()
    await Promise.resolve()
    expect(collapseAll).toHaveBeenCalledTimes(1)

    off()
  })

  test("hides collapse-all icon when list is at initial state", () => {
    const loadMore = vi.fn(() => Promise.resolve())
    const collapseAll = vi.fn(() => Promise.resolve())
    const { host, off } = mount({ hasMore: true, canCollapse: false, loadMore, collapseAll })

    expect(host.querySelector('[aria-label="common.loadMore"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="common.collapseAll"]')).toBeNull()

    off()
  })

  test("renders no icons when there are no more sessions", () => {
    const { host, off } = mount({
      hasMore: false,
      canCollapse: true,
      loadMore: () => Promise.resolve(),
      collapseAll: () => Promise.resolve(),
    })

    expect(host.querySelector('[aria-label="common.loadMore"]')).toBeNull()
    expect(host.querySelector('[aria-label="common.collapseAll"]')).toBeNull()

    off()
  })
})
