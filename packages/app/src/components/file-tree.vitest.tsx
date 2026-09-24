import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { FileNode } from "@opencode-ai/sdk/v2"

const state = vi.hoisted(() => ({
  dirs: new Map<string, { expanded?: boolean; loaded?: boolean; loading?: boolean }>(),
  kids: new Map<string, FileNode[]>(),
  platform: { platform: "web" } as {
    platform: "web" | "desktop"
    showInFolder?: (path: string) => Promise<void>
  },
  inExplorer: undefined as ((input: { path: string }) => Promise<unknown>) | undefined,
  toasts: [] as { variant: string; title: string; description?: string }[],
  clipboard: [] as string[],
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => () => undefined,
  useParams: () => ({}),
}))

vi.mock("@/context/file", () => ({
  useFile: () => ({
    normalize: (path: string) => path.replaceAll("\\", "/"),
    tree: {
      state: (path: string) => state.dirs.get(path),
      list: () => Promise.resolve(),
      children: (path: string) => state.kids.get(path) ?? [],
      expand: (path: string) => state.dirs.set(path, { ...(state.dirs.get(path) ?? {}), expanded: true }),
      collapse: (path: string) => state.dirs.set(path, { ...(state.dirs.get(path) ?? {}), expanded: false }),
      collapseAll: () => undefined,
    },
  }),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => state.platform,
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    client: {
      file: {
        open: async () => undefined,
        openInExplorer: async (input: { path: string }) => state.inExplorer?.(input),
        addToGitignore: async () => ({ data: {} }),
      },
    },
  }),
}))

vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({ params: {} }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: (toast: { variant: string; title: string; description?: string }) => {
    state.toasts.push(toast)
  },
}))

vi.mock("@opencode-ai/ui/collapsible", () => ({
  Collapsible: Object.assign((props: { children?: unknown }) => props.children, {
    Trigger: (props: { children?: unknown }) => props.children,
    Content: (props: { children?: unknown }) => props.children,
  }),
}))

vi.mock("@opencode-ai/ui/context-menu", () => ({
  ContextMenu: Object.assign((props: { children?: unknown }) => props.children, {
    Trigger: (props: { children?: unknown }) => props.children,
    Portal: (props: { children?: unknown }) => props.children,
    Content: (props: { children?: unknown }) => props.children,
    Item: (props: { children?: unknown; onSelect?: () => unknown }) => (
      <button type="button" onClick={() => props.onSelect?.()}>
        {props.children}
      </button>
    ),
    ItemLabel: (props: { children?: unknown }) => props.children,
    Separator: () => null,
  }),
}))

vi.mock("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => null }))
vi.mock("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
vi.mock("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
vi.mock("@/components/truncate-middle", () => ({ TruncateMiddle: (props: { text: string }) => props.text }))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

import FileTree from "./file-tree"

function node(path: string, type: "file" | "directory"): FileNode {
  const name = path.split("/").at(-1) ?? path
  return {
    name,
    path,
    absolute: path,
    type,
    ignored: false,
  }
}

function mount(props: Parameters<typeof FileTree>[0]) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <FileTree {...props} />, host)
  return { host, off }
}

beforeEach(() => {
  document.body.innerHTML = ""
  state.dirs.clear()
  state.kids.clear()
  state.platform = { platform: "web" }
  state.inExplorer = undefined
  state.toasts.length = 0
  state.clipboard.length = 0
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: (text: string) => state.clipboard.push(text) },
    configurable: true,
  })
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("file tree filtered review rendering", () => {
  test("allowed filter keeps parent directories and synthesizes missing deleted files", async () => {
    state.dirs.set("", { expanded: true, loaded: true })
    state.dirs.set("src", { expanded: true, loaded: true })
    state.kids.set("", [node("keep.ts", "file")])
    state.kids.set("src", [])

    const { host, off } = mount({
      path: "",
      draggable: false,
      allowed: ["src/gone.ts"],
    })

    await Promise.resolve()

    expect(host.textContent).toContain("src")
    expect(host.textContent).toContain("gone.ts")
    expect(host.textContent).not.toContain("keep.ts")

    off()
  })

  test("shows add, delete, and mix markers for filtered review files", async () => {
    state.dirs.set("", { expanded: true, loaded: true })
    state.kids.set("", [node("stay.ts", "file")])

    const { host, off } = mount({
      path: "",
      draggable: false,
      allowed: ["gone.ts", "new.ts", "stay.ts"],
      kinds: new Map([
        ["gone.ts", "del"],
        ["new.ts", "add"],
        ["stay.ts", "mix"],
      ]),
    })

    await Promise.resolve()

    const text = [...host.querySelectorAll("button")]
      .map((item) => item.textContent?.replace(/\s+/g, ""))
      .filter(Boolean)

    expect(text).toContain("gone.tsD")
    expect(text).toContain("new.tsA")
    expect(text).toContain("stay.tsM")

    off()
  })
})

function menuItem(host: HTMLElement, label: string, index = 0) {
  const hits = [...host.querySelectorAll("button")].filter((item) => item.textContent?.trim() === label)
  const hit = hits.at(index)
  if (!hit) throw new Error(`menu item not found: ${label}`)
  return hit
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("file tree show in folder", () => {
  test("desktop reveals files and directories through the native API", async () => {
    state.platform = { platform: "desktop", showInFolder: vi.fn(async () => undefined) }
    state.dirs.set("", { expanded: true, loaded: true })
    state.kids.set("", [node("a.ts", "file"), node("src", "directory")])

    const { host, off } = mount({ path: "", draggable: false })

    menuItem(host, "fileTree.showInFolder", 0).click()
    await settle()
    menuItem(host, "fileTree.showInFolder", 1).click()
    await settle()

    expect(state.platform.showInFolder).toHaveBeenCalledWith("a.ts")
    expect(state.platform.showInFolder).toHaveBeenCalledWith("src")
    expect(state.clipboard).toEqual([])
    expect(state.toasts).toEqual([
      { variant: "success", title: "fileTree.openedInFolder" },
      { variant: "success", title: "fileTree.openedInFolder" },
    ])

    off()
  })

  test("desktop failure falls back to copying the absolute path", async () => {
    state.platform = {
      platform: "desktop",
      showInFolder: vi.fn(async () => {
        throw new Error("boom")
      }),
    }
    state.dirs.set("", { expanded: true, loaded: true })
    state.kids.set("", [node("a.ts", "file")])

    const { host, off } = mount({ path: "", draggable: false })

    menuItem(host, "fileTree.showInFolder").click()
    await settle()

    expect(state.clipboard).toEqual(["a.ts"])
    expect(state.toasts).toEqual([
      {
        variant: "error",
        title: "fileTree.openFailed",
        description: "fileTree.pathCopiedManualOpen",
      },
    ])

    off()
  })

  test("web keeps using the server-side openInExplorer route", async () => {
    state.platform = { platform: "web" }
    state.inExplorer = vi.fn(async () => undefined)
    state.dirs.set("", { expanded: true, loaded: true })
    state.kids.set("", [node("a.ts", "file")])

    const { host, off } = mount({ path: "", draggable: false })

    menuItem(host, "fileTree.showInFolder").click()
    await settle()

    expect(state.inExplorer).toHaveBeenCalledWith({ path: "a.ts" })
    expect(state.toasts).toEqual([{ variant: "success", title: "fileTree.openedInFolder" }])

    off()
  })

  test("item is hidden when the desktop shell lacks the showInFolder capability", async () => {
    state.platform = { platform: "desktop" }
    state.dirs.set("", { expanded: true, loaded: true })
    state.kids.set("", [node("a.ts", "file")])

    const { host, off } = mount({ path: "", draggable: false })

    const labels = [...host.querySelectorAll("button")].map((item) => item.textContent?.trim())

    expect(labels).not.toContain("fileTree.showInFolder")

    off()
  })
})
