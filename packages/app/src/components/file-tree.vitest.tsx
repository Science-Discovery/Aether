import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { FileNode } from "@opencode-ai/sdk/v2"

const state = vi.hoisted(() => ({
  dirs: new Map<string, { expanded?: boolean; loaded?: boolean; loading?: boolean }>(),
  kids: new Map<string, FileNode[]>(),
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
    },
  }),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web" }),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    client: {
      file: {
        open: async () => undefined,
        openInExplorer: async () => undefined,
        addToGitignore: async () => ({ data: {} }),
      },
    },
  }),
}))

vi.mock("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({ params: {} }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: () => undefined,
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
    Item: (props: { children?: unknown }) => props.children,
    ItemLabel: (props: { children?: unknown }) => props.children,
    Separator: () => null,
  }),
}))

vi.mock("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => null }))
vi.mock("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
vi.mock("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
vi.mock("@/components/truncate-middle", () => ({ TruncateMiddle: (props: { text: string }) => props.text }))

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
