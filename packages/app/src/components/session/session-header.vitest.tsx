import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"

const state = vi.hoisted(() => ({
  dir: "/tmp/proj-a",
  platform: "web" as "web" | "desktop",
  isLocal: true,
  openPath: vi.fn(),
  fileOpen: vi.fn(),
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: {
    onClick?: (event: MouseEvent) => void
    "aria-label"?: string
    "aria-expanded"?: boolean
    "aria-controls"?: string
    children?: unknown
  }) => (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props["aria-label"]}
      aria-expanded={props["aria-expanded"]}
      aria-controls={props["aria-controls"]}
    >
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { onClick?: (event: MouseEvent) => void; "aria-label"?: string; children?: unknown }) => (
    <button type="button" onClick={props.onClick} aria-label={props["aria-label"]}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/icon", () => ({ Icon: () => null }))

vi.mock("@opencode-ai/ui/keybind", () => ({ Keybind: (props: { children?: unknown }) => <kbd>{props.children}</kbd> }))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
  TooltipKeybind: (props: { children?: unknown }) => props.children,
}))

vi.mock("@opencode-ai/ui/scroll-view", () => ({
  ScrollView: (props: { children?: unknown }) => <div>{props.children}</div>,
}))

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))

vi.mock("@opencode-ai/ui/popover", () => ({
  Popover: (props: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    triggerAs?: (trigger: Record<string, unknown>) => JSX.Element
    triggerProps?: Record<string, unknown>
    children?: unknown
  }) => {
    const Trigger = props.triggerAs
    return (
      <>
        {Trigger ? <Trigger {...props.triggerProps} onClick={() => props.onOpenChange?.(!props.open)} /> : null}
        {props.open ? props.children : null}
      </>
    )
  },
}))

vi.mock("@/components/file-tree", () => ({ default: () => <div data-component="file-tree" /> }))

vi.mock("@/components/pdf-convert-progress", () => ({ PdfConvertProgressBar: () => null }))

vi.mock("../status-popover", () => ({ StatusPopover: () => null }))

vi.mock("@/context/command", () => ({
  useCommand: () => ({ register: () => undefined, keybind: () => undefined, trigger: () => undefined }),
}))

vi.mock("@/context/file", () => ({
  useFile: () => ({ tab: (path: string) => path, pathFromTab: (tab: string) => tab, load: () => undefined }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/context/layout", () => ({
  useLayout: () => ({
    fileTree: { opened: () => false, toggle: () => undefined },
    projects: { list: () => [] },
  }),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({ platform: state.platform, os: "windows", openPath: state.openPath }),
}))

vi.mock("@/context/global-sync/bootstrap", () => ({ resolveProject: () => undefined }))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ client: { file: { open: state.fileOpen } } }),
}))

vi.mock("@/context/server", () => ({
  useServer: () => ({ isLocal: () => state.isLocal }),
}))

vi.mock("@/context/sync", () => ({
  useSync: () => ({ data: { message: {}, agent: {} }, session: { diff: () => undefined } }),
}))

vi.mock("@/context/terminal", () => ({
  useTerminal: () => ({ active: () => undefined }),
}))

vi.mock("@/pages/session/helpers", () => ({
  createOpenSessionFileTab: () => () => undefined,
  focusTerminalById: () => undefined,
}))

vi.mock("@/pages/session/file-actions", () => ({
  createFileActions: () => ({ remove: () => undefined, rename: () => undefined }),
}))

vi.mock("@/pages/session/session-layout", async () => {
  const { base64Encode } = await import("@opencode-ai/util/encode")
  return {
    useSessionLayout: () => ({
      params: { dir: base64Encode(state.dir), id: "ses_1" },
      view: () => ({
        terminal: { opened: () => false, toggle: () => undefined },
        reviewPanel: { opened: () => false, toggle: () => undefined, open: () => undefined },
      }),
      tabs: () => ({ open: () => undefined, setActive: () => undefined }),
    }),
  }
})

import { SessionHeader } from "./session-header"

function mount() {
  const left = document.createElement("div")
  left.id = "opencode-titlebar-left"
  const right = document.createElement("div")
  right.id = "opencode-titlebar-right"
  const host = document.createElement("div")
  document.body.append(left, right, host)
  const off = render(() => <SessionHeader />, host)
  return { left, right, off }
}

const chevron = (left: HTMLElement) =>
  left.querySelector('[aria-label="session.header.open.menu"]') as HTMLButtonElement

const rootRow = (left: HTMLElement) =>
  left.querySelector('[aria-label="session.header.open.fileExplorer"]') as HTMLButtonElement

beforeEach(() => {
  state.platform = "web"
  state.isLocal = true
  state.openPath.mockReset()
  state.openPath.mockResolvedValue(undefined)
  state.fileOpen.mockReset()
  state.fileOpen.mockResolvedValue(undefined)
  document.body.innerHTML = ""
})

describe("session header folder open merge", () => {
  test("file tree toggle hosts the folder menu chevron; the open folder button is gone", () => {
    const { left, right, off } = mount()

    expect(left.querySelector('[aria-controls="file-tree-panel"]')).not.toBeNull()
    expect(chevron(left)).not.toBeNull()

    expect(right.querySelector('[aria-label="session.header.open.menu"]')).toBeNull()
    expect(document.querySelector('[aria-label="session.header.open.ariaLabel"]')).toBeNull()
    expect(document.querySelector('[aria-label="session.header.open.folder"]')).toBeNull()

    off()
  })

  test("menu root name row opens the project directory through the platform on web", () => {
    const { left, off } = mount()

    chevron(left).click()
    const row = rootRow(left)
    expect(row).not.toBeNull()
    expect(row.textContent).toBe("proj-a")

    row.click()

    expect(state.fileOpen).toHaveBeenCalledWith({ path: "/tmp/proj-a" })
    expect(state.openPath).not.toHaveBeenCalled()

    off()
  })

  test("menu root name row opens the project directory through the desktop shell", () => {
    state.platform = "desktop"
    const { left, off } = mount()

    chevron(left).click()
    rootRow(left).click()

    expect(state.openPath).toHaveBeenCalledWith("/tmp/proj-a")
    expect(state.fileOpen).not.toHaveBeenCalled()

    off()
  })

  test("menu root name row is disabled when the directory cannot be opened", () => {
    state.isLocal = false
    const { left, off } = mount()

    chevron(left).click()
    expect(rootRow(left).disabled).toBe(true)

    rootRow(left).click()
    expect(state.fileOpen).not.toHaveBeenCalled()

    off()
  })
})
