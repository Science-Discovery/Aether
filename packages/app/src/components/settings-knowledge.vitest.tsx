import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"

const state = vi.hoisted(() => ({
  set: (_enabled?: boolean) => {},
  read: (): boolean => false,
  updates: [] as boolean[],
  errors: [] as unknown[],
  rejected: false,
  ready: true,
  selected: 0,
  failure: undefined as string | undefined,
  retried: 0,
}))

vi.mock("@/context/global-sync", async () => {
  const { createStore } = await import("solid-js/store")
  const [data, setData] = createStore({ config: { knowledge: { enabled: undefined as boolean | undefined } } })
  state.set = (enabled) => setData("config", "knowledge", "enabled", enabled)
  state.read = () => data.config.knowledge.enabled === true
  return {
    useGlobalSync: () => ({
      data,
      ready: true,
      updateConfig: async (config: { knowledge: { enabled: boolean } }) => {
        if (state.rejected) throw new Error("save failed")
        state.updates.push(config.knowledge.enabled)
        state.set(config.knowledge.enabled)
      },
    }),
  }
})

vi.mock("@/context/knowledge", () => ({
  useKnowledge: () => ({
    available: () => state.read(),
    ready: () => state.ready,
    error: () => state.failure,
    retry: async () => {
      state.retried++
    },
    knowledgeBases: () => [{ id: "kb", name: "Saved library", path: "/library", documentCount: 2 }],
    activeIds: () => ["kb"],
    isActive: () => true,
    models: () => [],
    syncProgress: () => null,
    getLastConfig: () => undefined,
    refreshAllStats: async () => {},
    toggleActive: () => state.selected++,
    loadKnowledgeBase: async () => {},
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/global-sdk", () => ({ useGlobalSDK: () => ({ url: "http://unused" }) }))
vi.mock("@/context/server", () => ({ useServer: () => ({ current: undefined }) }))
vi.mock("@/hooks/use-providers", () => ({ useProviders: () => ({ connected: () => [] }) }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {} }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children: JSX.Element }) => <section>{props.children}</section>,
}))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: (error: unknown) => state.errors.push(error) }))
vi.mock("./dialog-select-directory", () => ({ DialogSelectDirectory: () => <div /> }))
vi.mock("@opencode-ai/ui/switch", () => ({
  Switch: (props: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) => (
    <button
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  ),
}))

import { SettingsKnowledge } from "./settings-knowledge"
import { KnowledgeDialog } from "./knowledge-dialog"

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <SettingsKnowledge />, host)
  return { host, off }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  document.body.innerHTML = ""
  state.set(undefined)
  state.updates = []
  state.errors = []
  state.rejected = false
  state.ready = true
  state.selected = 0
  state.failure = undefined
  state.retried = 0
})

describe("knowledge settings master", () => {
  test("defaults off while keeping saved libraries visible", () => {
    const { host, off } = mount()
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false")
    expect(host.textContent).toContain("Saved library")
    expect(
      [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Knowledge Base"))
        ?.disabled,
    ).toBe(true)
    off()
  })

  test("successful opt-in updates server config and allows selection", async () => {
    const { host, off } = mount()
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    await flush()
    expect(state.updates).toEqual([true])
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true")
    const name = [...host.querySelectorAll("div")].find((element) => element.textContent === "Saved library")!
    name.click()
    expect(state.selected).toBe(1)
    off()
  })

  test("failed save reports the error and retains the off state", async () => {
    state.rejected = true
    const { host, off } = mount()
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    await flush()
    expect(state.updates).toEqual([])
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false")
    expect(state.errors).toEqual([{ title: "common.requestFailed", description: "save failed" }])
    off()
  })

  test("library modifications wait until saved metadata is ready", () => {
    state.set(true)
    state.ready = false
    const { host, off } = mount()
    const name = [...host.querySelectorAll("div")].find((element) => element.textContent === "Saved library")!
    name.click()
    expect(state.selected).toBe(0)
    expect(
      [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Knowledge Base"))
        ?.disabled,
    ).toBe(true)
    off()
  })

  test("metadata failure offers a retry even while the feature is off", async () => {
    state.ready = false
    state.failure = "offline"
    const { host, off } = mount()
    expect(host.textContent).toContain("knowledge.loadFailed")
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "common.retry")!
    button.click()
    await flush()
    expect(state.retried).toBe(1)
    off()
  })

  test("composer dialog cannot alter selections before metadata recovery", () => {
    state.set(true)
    state.ready = false
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(() => <KnowledgeDialog sessionID="session" />, host)
    expect(host.querySelector("fieldset")?.disabled).toBe(true)
    const name = [...host.querySelectorAll("div")].find((item) => item.textContent === "Saved library")!
    name.click()
    expect(state.selected).toBe(0)
    off()
  })
})
