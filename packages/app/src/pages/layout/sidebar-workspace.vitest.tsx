import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal, type Accessor } from "solid-js"
import { WorkspaceHeader, WorkspaceSessionList, type WorkspaceSidebarContext } from "./sidebar-workspace"
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
    expect(collapse!.dataset.icon).toBe("chevron-double-up")

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

  test("shows only collapse-all icon when all sessions are loaded but list is expanded", async () => {
    const collapseAll = vi.fn(() => Promise.resolve())
    const loadMore = vi.fn(() => Promise.resolve())
    const { host, off } = mount({ hasMore: false, canCollapse: true, loadMore, collapseAll })

    expect(host.querySelector('[aria-label="common.loadMore"]')).toBeNull()
    const collapse = host.querySelector<HTMLButtonElement>('[aria-label="common.collapseAll"]')
    expect(collapse).not.toBeNull()
    expect(collapse!.dataset.icon).toBe("chevron-double-up")

    collapse!.click()
    await Promise.resolve()
    expect(collapseAll).toHaveBeenCalledTimes(1)
    expect(loadMore).not.toHaveBeenCalled()

    off()
  })

  test("renders no icons when fully loaded and not expanded", () => {
    const { host, off } = mount({
      hasMore: false,
      canCollapse: false,
      loadMore: () => Promise.resolve(),
      collapseAll: () => Promise.resolve(),
    })

    expect(host.querySelector('[aria-label="common.loadMore"]')).toBeNull()
    expect(host.querySelector('[aria-label="common.collapseAll"]')).toBeNull()

    off()
  })
})

const nullEditor = (() => null) as unknown as WorkspaceSidebarContext["InlineEditor"]

function mountHeader(active: Accessor<boolean>, busy = false) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <WorkspaceHeader
        busy={() => busy}
        sessionBusy={() => false}
        notify={() => false}
        hasPermissions={() => false}
        hasError={() => false}
        open={() => true}
        active={active}
        directory="E:/repo/sandbox-1"
        language={language}
        branch={() => "dev"}
        workspaceValue={() => "sandbox-1"}
        workspaceEditActive={() => false}
        branchEditActive={() => false}
        InlineEditor={nullEditor}
        renameWorkspace={() => undefined}
        renameBranch={() => Promise.resolve()}
        setEditor={() => undefined}
      />
    ),
    host,
  )
  return { host, off }
}

describe("WorkspaceHeader active ring", () => {
  test("frames the workspace icon while its session is open", () => {
    const { host, off } = mountHeader(() => true)

    const icon = host.querySelector<HTMLElement>("[data-active]")
    expect(icon).not.toBeNull()
    expect(icon!.dataset.active).toBe("true")
    expect(icon!.className).toContain("ring-1")

    off()
  })

  test("keeps no frame when the workspace is not the current one", () => {
    const { host, off } = mountHeader(() => false)

    expect(host.querySelector("[data-active]")).toBeNull()
    expect(host.querySelector(".ring-1")).toBeNull()

    off()
  })

  test("follows switching the open session between workspaces", () => {
    const [active, setActive] = createSignal(false)
    const { host, off } = mountHeader(active)

    const icon = host.querySelector<HTMLElement>("div.relative")!
    expect(icon.hasAttribute("data-active")).toBe(false)

    setActive(true)
    expect(icon.dataset.active).toBe("true")
    expect(icon.className).toContain("ring-1")

    setActive(false)
    expect(icon.hasAttribute("data-active")).toBe(false)
    expect(icon.className).not.toContain("ring-1")

    off()
  })

  test("frames the icon even while the workspace shows a spinner", () => {
    const { host, off } = mountHeader(() => true, true)

    expect(host.querySelector("[data-component='spinner']")).not.toBeNull()
    const icon = host.querySelector<HTMLElement>("[data-active]")
    expect(icon).not.toBeNull()
    expect(icon!.className).toContain("ring-1")

    off()
  })
})
