import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { SidebarContent } from "./sidebar-shell"

vi.mock("@thisbeyond/solid-dnd", () => ({
  DragDropProvider: (props: { children?: unknown }) => props.children,
  DragDropSensors: () => null,
  DragOverlay: (props: { children?: unknown }) => props.children,
  SortableProvider: (props: { children?: unknown }) => props.children,
  closestCenter: () => null,
}))

vi.mock("@/utils/solid-dnd", () => ({
  ConstrainDragXAxis: () => null,
}))

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: () => null,
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { icon?: string; onClick?: () => void; "aria-label"?: string }) => (
    <button type="button" data-icon={props.icon} aria-label={props["aria-label"]} onClick={props.onClick} />
  ),
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
  TooltipKeybind: (props: { children?: unknown }) => props.children,
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => ({
  DropdownMenu: Object.assign((props: { children?: unknown }) => props.children, {
    Trigger: (props: { as?: (input: Record<string, unknown>) => unknown; children?: unknown }) =>
      props.as ? props.as(props) : props.children,
    Portal: (props: { children?: unknown }) => props.children,
    Content: (props: { children?: unknown }) => props.children,
    Item: (props: { children?: unknown }) => props.children,
    ItemLabel: (props: { children?: unknown }) => props.children,
    Separator: () => null,
  }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: () => undefined,
  }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: () => undefined,
}))

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    isAuthenticated: false,
    account: undefined,
    logout: async () => undefined,
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/context/mobile", () => ({
  status: () => "disconnected",
}))

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <SidebarContent
        opened={() => false}
        aimMove={() => undefined}
        projects={() => []}
        renderProject={() => null}
        handleDragStart={() => undefined}
        handleDragEnd={() => undefined}
        handleDragOver={() => undefined}
        openProjectLabel="Open project"
        openProjectKeybind={() => "mod+o"}
        onOpenProject={() => undefined}
        renderProjectOverlay={() => null}
        settingsLabel={() => "Settings"}
        settingsKeybind={() => undefined}
        onOpenSettings={() => undefined}
        helpLabel={() => "Help"}
        onOpenHelp={() => undefined}
        renderPanel={() => null}
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

describe("SidebarContent project actions", () => {
  test("keeps open project action without rendering new project action", () => {
    const { host, off } = mount()

    expect(host.querySelector('[aria-label="New project"]')).toBeNull()
    expect(host.querySelector('[aria-label="command.project.new"]')).toBeNull()
    expect(host.querySelector('[aria-label="Open project"]')).not.toBeNull()

    off()
  })
})
