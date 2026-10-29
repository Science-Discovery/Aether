import { describe, expect, test, vi } from "vitest"
import { For, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { nativeSlash, NativeChoice } from "./native-slash"

const mocks = vi.hoisted(() => ({ model: vi.fn(), permission: vi.fn(), mode: vi.fn(), close: vi.fn() }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/local", () => ({
  useLocal: () => ({
    native: {
      status: () => ({
        models: [{ id: "model", name: "Codex Model" }],
        capabilities: { plan: true },
        permissions: { auto: false },
      }),
      enabled: () => true,
      saving: () => false,
      loading: () => false,
      permissionError: () => undefined,
      setModel: mocks.model,
      setPermission: mocks.permission,
      setMode: mocks.mode,
    },
  }),
}))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: mocks.close }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div> }))
vi.mock("@opencode-ai/ui/list", () => ({
  List: (props: {
    items: () => Array<{ id: string; title: string }>
    onSelect: (item: { id: string; title: string }) => void
  }) => <For each={props.items()}>{(item) => <button onClick={() => props.onSelect(item)}>{item.id}</button>}</For>,
}))

describe("Codex slash menu", () => {
  test("lists native controls and exact skill identities without Aether commands", () => {
    const skills = ["/a/SKILL.md", "/b/SKILL.md"].map((path) => ({ name: "research", path, description: "Study" }))
    const list = nativeSlash({ session: "session", enabled: true, plan: true, skills, t: (key) => key })
    expect(list.filter((item) => item.type === "native").map((item) => item.trigger)).toEqual([
      "new",
      "model",
      "permissions",
      "plan",
      "status",
      "skills",
      "mcp",
    ])
    expect(list.some((item) => item.trigger === "agent" || item.trigger === "compact")).toBe(false)
    const entries = list.filter((item) => item.type === "skill")
    expect(entries[0].id).not.toBe(entries[1].id)
    expect(entries[0].description).toContain("/a/SKILL.md")
  })
  test("omits controls that require an enabled backend, supported plan mode or existing session", () => {
    const list = nativeSlash({ enabled: false, plan: false, skills: [], t: (key) => key })
    expect(list.map((item) => item.trigger)).toEqual(["new", "skills", "mcp"])
  })
  test.each(["model", "permissions", "plan"] as const)("%s uses the corresponding native setter", async (kind) => {
    vi.clearAllMocks()
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = render(() => <NativeChoice kind={kind} valid={() => true} />, host)
    try {
      const buttons = [...host.querySelectorAll("button")]
      if (kind === "permissions") expect(buttons.map((item) => item.textContent)).toEqual(["user", "full"])
      buttons[0].click()
      await Promise.resolve()
      expect(mocks[kind === "permissions" ? "permission" : kind === "plan" ? "mode" : "model"]).toHaveBeenCalledOnce()
      expect(mocks.close).toHaveBeenCalledOnce()
    } finally {
      dispose()
      host.remove()
    }
  })
  test("an open dialog cannot change a different conversation after navigation", async () => {
    vi.clearAllMocks()
    const host = document.createElement("div")
    document.body.append(host)
    let valid = true
    const dispose = render(
      () => (
        <For each={["model", "permissions", "plan"] as const}>
          {(kind) => <NativeChoice kind={kind} valid={() => valid} />}
        </For>
      ),
      host,
    )
    try {
      valid = false
      host.querySelectorAll("button").forEach((button) => button.click())
      await Promise.resolve()
      expect(mocks.model).not.toHaveBeenCalled()
      expect(mocks.permission).not.toHaveBeenCalled()
      expect(mocks.mode).not.toHaveBeenCalled()
      expect(mocks.close).not.toHaveBeenCalled()
    } finally {
      dispose()
      host.remove()
    }
  })
})
