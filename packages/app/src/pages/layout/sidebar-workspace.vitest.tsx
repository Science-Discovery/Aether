import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createSignal, type Accessor } from "solid-js"
import {
  RunScriptButton,
  WorkspaceHeader,
  WorkspaceSessionList,
  type WorkspaceSidebarContext,
} from "./sidebar-workspace"
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

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: {
    disabled?: boolean
    onClick?: (event: MouseEvent) => void
    class?: string
    classList?: Record<string, boolean>
    children?: unknown
  }) => (
    <button
      type="button"
      disabled={props.disabled}
      class={props.class}
      classList={props.classList}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { value?: unknown; children?: unknown }) => (
    <div>
      <span data-tooltip-value>{props.value}</span>
      {props.children}
    </div>
  ),
}))

vi.mock("@opencode-ai/ui/context-menu", () => {
  const Menu = (props: { children?: unknown }) => <>{props.children}</>
  type MockProps = { children?: unknown; class?: string; value?: string; onChange?: (value: string) => void }
  Menu.Trigger = (props: MockProps & { "data-action"?: string; "data-workspace"?: string }) => (
    <div class={props.class} data-action={props["data-action"]} data-workspace={props["data-workspace"]}>
      {props.children}
    </div>
  )
  Menu.Portal = (props: MockProps) => <>{props.children}</>
  Menu.Content = (props: MockProps) => <div>{props.children}</div>
  Menu.RadioGroup = (props: MockProps) => <div>{props.children}</div>
  Menu.Group = (props: MockProps) => <div>{props.children}</div>
  Menu.GroupLabel = (props: MockProps) => <div>{props.children}</div>
  Menu.RadioItem = (props: MockProps) => (
    <div role="menuitemradio" aria-label={props.value} onClick={() => props.onChange?.(props.value!)}>
      {props.children}
    </div>
  )
  Menu.ItemIndicator = (props: MockProps) => <span>{props.children}</span>
  Menu.ItemLabel = (props: MockProps) => <span>{props.children}</span>
  Menu.Separator = () => <hr />
  return { ContextMenu: Menu }
})

const runMocks = vi.hoisted(() => ({
  fileList: vi.fn(),
  globalScripts: vi.fn(),
  enqueueRun: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    createClient: () => ({ file: { list: runMocks.fileList } }),
    client: { global: { scripts: runMocks.globalScripts } },
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => runMocks.navigate,
  useParams: () => ({ dir: "c2x1Zw==", id: "s1" }),
}))

vi.mock("@/context/terminal", () => ({
  enqueueRun: runMocks.enqueueRun,
  runKey: (slug: string) => slug,
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
  vi.clearAllMocks()
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
    const icon = host.querySelector("[data-active]")
    expect(icon).not.toBeNull()
    expect(icon!.className).toContain("ring-1")

    off()
  })
})

const SLUG = "c2x1Zw=="

function mountRunButton() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <RunScriptButton
        directory="E:/repo/sandbox-1"
        slug={() => SLUG}
        sessions={() => []}
        createSession={() => Promise.resolve()}
      />
    ),
    host,
  )
  return { host, off }
}

const runTrigger = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-action="workspace-run-script"]')!
const runButton = (host: HTMLElement) => runTrigger(host).querySelector("button")!
const runHint = (host: HTMLElement) => host.querySelector("[data-tooltip-value]")!.textContent

const FALLBACK_HINT = `workspace.runHint:${JSON.stringify({ path: "<datahome>/aether/.bin" })}`

describe("RunScriptButton feedback", () => {
  test("hints how to add scripts on empty projects while keeping the button hoverable", async () => {
    runMocks.fileList.mockResolvedValue({ data: [] })
    runMocks.globalScripts.mockResolvedValue({ data: { path: "C:/g/.bin", names: [] } })
    const { host, off } = mountRunButton()

    await vi.waitFor(() => expect(runHint(host)).toContain("workspace.runEmpty"))
    expect(runHint(host)).toBe(`workspace.runEmpty:${JSON.stringify({ path: "C:/g/.bin" })}`)
    expect(runButton(host).disabled).toBe(true)
    expect(runButton(host).className).toContain("disabled:pointer-events-none")

    off()
  })

  test("keeps the generic hint while the script list is still loading", () => {
    runMocks.fileList.mockReturnValue(new Promise(() => {}))
    runMocks.globalScripts.mockReturnValue(new Promise(() => {}))
    const { host, off } = mountRunButton()

    expect(runHint(host)).toBe(FALLBACK_HINT)

    off()
  })

  test("pulses on click, enqueues the selected script and reports success", async () => {
    runMocks.fileList.mockResolvedValue({ data: [{ type: "file", name: "run.sh" }] })
    runMocks.globalScripts.mockResolvedValue({ data: { path: "", names: [] } })
    const { host, off } = mountRunButton()

    await vi.waitFor(() => expect(runButton(host).disabled).toBe(false))
    expect(runHint(host)).toBe(FALLBACK_HINT)

    vi.useFakeTimers()
    try {
      runButton(host).click()
      expect(runButton(host).className).toContain("run-script-pulse")
      expect(runMocks.enqueueRun).toHaveBeenCalledTimes(1)
      expect(runMocks.enqueueRun.mock.calls[0].slice(0, 4)).toEqual([
        SLUG,
        "bash",
        ["-c", '".aether/.bin/run.sh"; exec bash --noediting'],
        ".aether/.bin/run.sh",
      ])

      vi.advanceTimersByTime(600)
      expect(runButton(host).className).not.toContain("run-script-pulse")

      const done = runMocks.enqueueRun.mock.calls[0][4] as (err?: string) => void
      done(undefined)
      expect(runHint(host)).toBe(`workspace.ranScript:${JSON.stringify({ name: "run.sh" })}`)

      vi.advanceTimersByTime(6000)
      expect(runHint(host)).toBe(FALLBACK_HINT)
    } finally {
      vi.useRealTimers()
    }

    off()
  })

  test("reports launch errors in the hint", async () => {
    runMocks.fileList.mockResolvedValue({ data: [{ type: "file", name: "run.sh" }] })
    runMocks.globalScripts.mockResolvedValue({ data: { path: "", names: [] } })
    const { host, off } = mountRunButton()

    await vi.waitFor(() => expect(runButton(host).disabled).toBe(false))

    runButton(host).click()
    expect(runMocks.enqueueRun).toHaveBeenCalledTimes(1)
    const done = runMocks.enqueueRun.mock.calls[0][4] as (err?: string) => void
    done("pty crashed")
    expect(runHint(host)).toBe(`workspace.runFailed:${JSON.stringify({ name: "run.sh", error: "pty crashed" })}`)

    off()
  })

  test("truncates long error details", async () => {
    runMocks.fileList.mockResolvedValue({ data: [{ type: "file", name: "run.sh" }] })
    runMocks.globalScripts.mockResolvedValue({ data: { path: "", names: [] } })
    const { host, off } = mountRunButton()

    await vi.waitFor(() => expect(runButton(host).disabled).toBe(false))

    runButton(host).click()
    const done = runMocks.enqueueRun.mock.calls[0][4] as (err?: string) => void
    done("x".repeat(300))
    const shown = runHint(host)!
    expect(shown).toContain("workspace.runFailed")
    expect(shown.length).toBeLessThan("workspace.runFailed".length + 280)

    off()
  })
})
