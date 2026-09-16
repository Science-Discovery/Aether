import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({
  opened: false,
  toggle: vi.fn(() => {
    state.opened = !state.opened
  }),
}))

vi.mock("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/abc/session", search: "", hash: "" }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ dir: "abc" }),
}))

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: () => null,
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: {
    onClick?: (event: MouseEvent) => void
    "aria-label"?: string
    "aria-expanded"?: boolean
    children?: unknown
  }) => (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props["aria-label"]}
      aria-expanded={props["aria-expanded"]}
    >
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
  TooltipKeybind: (props: { class?: string; children?: unknown }) => (
    <div data-component="tooltip-keybind" class={props.class}>
      {props.children}
    </div>
  ),
}))

vi.mock("@opencode-ai/ui/theme/context", () => ({
  useTheme: () => ({ colorScheme: () => "system" }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: () => undefined,
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({}),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", os: "windows" }),
}))

vi.mock("@/context/layout", () => ({
  useLayout: () => ({
    sidebar: { opened: () => state.opened, toggle: state.toggle },
    projects: { list: () => [] },
  }),
}))

vi.mock("@/context/command", () => ({
  useCommand: () => ({
    register: () => undefined,
    keybind: (id: string) => (id === "sidebar.toggle" ? "mod+b" : undefined),
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

import { Titlebar } from "./titlebar"

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <Titlebar />, host)
  return { host, off }
}

beforeEach(() => {
  state.opened = false
  state.toggle.mockClear()
  document.body.innerHTML = ""
})

describe("titlebar sidebar toggle", () => {
  test("renders on web without breakpoint gating", () => {
    const { host, off } = mount()

    const button = host.querySelector('[aria-label="command.sidebar.toggle"]')
    expect(button).not.toBeNull()
    expect(button?.getAttribute("aria-expanded")).toBe("false")

    const wrapper = button?.closest('[data-component="tooltip-keybind"]')
    expect(wrapper?.classList.contains("flex")).toBe(true)
    expect(wrapper?.classList.contains("hidden")).toBe(false)
    expect(wrapper?.className).not.toContain("xl:")

    off()
  })

  test("toggles the sidebar on click", () => {
    const { host, off } = mount()

    const button = host.querySelector('[aria-label="command.sidebar.toggle"]') as HTMLButtonElement
    button.click()

    expect(state.toggle).toHaveBeenCalledTimes(1)

    off()
  })
})
