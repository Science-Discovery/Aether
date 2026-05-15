import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({
  configUpdates: [] as Array<{ memory?: Record<string, unknown> }>,
  statusCalls: 0,
  searchCalls: [] as Array<{ query: string; limit?: number }>,
  reflectCalls: [] as Array<{ mode: string; reason?: string }>,
  syncCalls: 0,
  initializeCalls: 0,
  toasts: [] as Array<{ title?: string; description?: string }>,
  status: {
    needs_initialization: true,
    has_history_sessions: true,
    memory_count: 2,
    shortcut_count: 1,
  } as Record<string, unknown>,
  searchResults: [
    {
      id: "PREF-answer-language",
      type: "preference",
      scope: "global",
      memory: "用户偏好默认用中文回答。",
      confidence: 0.95,
      weight: 0.9,
      score: 1,
      ranking_note: "结果按相关度、scope、权重和新近程度综合排序。",
    },
  ],
}))

vi.mock("@/context/global-sync", async () => {
  const { createStore } = await import("solid-js/store")
  const [data, setData] = createStore({
    config: {
      memory: {
        enabled: true,
        dailyReflect: {
          enabled: true,
          time: "03:00",
        },
      },
    },
  })
  return {
    useGlobalSync: () => ({
      data,
      set: (...input: unknown[]) => (setData as (...args: unknown[]) => unknown)(...input),
      updateConfig: async (config: { memory?: Record<string, unknown> }) => {
        state.configUpdates.push(config)
        if (config.memory) {
          setData("config", "memory", (prev) => ({ ...prev, ...config.memory }))
        }
        return data.config
      },
    }),
  }
})

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      memory: {
        status: async () => {
          state.statusCalls += 1
          return { data: state.status }
        },
        search: async (input: { query: string; limit?: number }) => {
          state.searchCalls.push(input)
          return { data: { results: state.searchResults } }
        },
        reflect: async (input: { mode: string; reason?: string }) => {
          state.reflectCalls.push(input)
          return { data: { summary: `reflected ${input.mode}` } }
        },
        dailyReflect: {
          sync: async () => {
            state.syncCalls += 1
            return { data: { ok: true } }
          },
        },
        initialize: {
          start: async () => {
            state.initializeCalls += 1
            return { data: { status: "succeeded", scanned: 1, imported: 1 } }
          },
          cancel: async () => ({ data: { ok: true } }),
        },
      },
    },
  }),
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown; disabled?: boolean; onClick?: () => void; "data-testid"?: string }) => (
    <button type="button" data-testid={props["data-testid"]} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/switch", () => ({
  Switch: (props: { checked?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked ? "true" : "false"}
      disabled={props.disabled}
      onClick={() => props.onChange?.(!props.checked)}
    />
  ),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: (input: { title?: string; description?: string }) => {
    state.toasts.push(input)
  },
}))

import { SettingsMemory } from "./settings-memory"

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <SettingsMemory />, host)
  return { host, off }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ""
  state.configUpdates = []
  state.statusCalls = 0
  state.searchCalls = []
  state.reflectCalls = []
  state.syncCalls = 0
  state.initializeCalls = 0
  state.toasts = []
  state.status = {
    needs_initialization: true,
    has_history_sessions: true,
    memory_count: 2,
    shortcut_count: 1,
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("settings memory", () => {
  test("renders status and allows one-time initialization", async () => {
    const { host, off } = mount()
    await flush()

    expect(host.textContent).toContain("Import previous conversations")
    expect(host.textContent).toContain("Historical sessions detected")
    expect(host.textContent).toContain("Long-term memories")
    expect(host.textContent).toContain("2")

    const initialize = [...host.querySelectorAll("button")].find((button) => button.textContent === "Import memories")
    initialize?.click()
    await flush()

    expect(state.initializeCalls).toBe(1)
    expect(state.toasts.some((toast) => toast.title === "Memory initialization started")).toBe(true)

    off()
  })

  test("shows initialization progress from status", async () => {
    state.status = {
      needs_initialization: true,
      has_history_sessions: true,
      memory_count: 0,
      shortcut_count: 0,
      initialization: {
        status: "running",
        scanned: 7,
        imported: 2,
        current_session_id: "session-progress",
      },
    }
    const { host, off } = mount()
    await flush()

    expect(host.textContent).toContain("Status: running")
    expect(host.textContent).toContain("Scanned: 7")
    expect(host.textContent).toContain("Imported: 2")
    expect(host.textContent).toContain("session-progress")

    off()
  })

  test("keeps import action visible even when status does not request initialization", async () => {
    state.status = {
      needs_initialization: false,
      has_history_sessions: false,
      markdown_exists: true,
      memory_count: 1,
      shortcut_count: 0,
    }
    const { host, off } = mount()
    await flush()

    expect(host.textContent).toContain("Import previous conversations")
    expect(host.textContent).toContain("Import memories")
    expect(host.textContent).toContain("Current memory file exists")

    off()
  })

  test("updates global memory and daily reflection settings", async () => {
    const { host, off } = mount()
    await flush()

    const switches = [...host.querySelectorAll('[role="switch"]')] as HTMLButtonElement[]
    switches[0]?.click()
    switches[1]?.click()
    await flush()

    expect(state.configUpdates).toContainEqual({ memory: { enabled: false } })
    expect(state.configUpdates.some((item) => item.memory?.dailyReflect)).toBe(true)
    expect(state.syncCalls).toBe(1)

    off()
  })

  test("searches memory and runs manual reflection through SDK methods", async () => {
    const { host, off } = mount()
    await flush()

    const input = host.querySelector("input[placeholder='Search memory...']") as HTMLInputElement
    input.value = "中文回答"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const search = [...host.querySelectorAll("button")].find((button) => button.textContent === "Search")
    search?.click()
    await flush()

    expect(state.searchCalls).toEqual([{ query: "中文回答", limit: 5 }])
    expect(host.textContent).toContain("PREF-answer-language")

    const quick = [...host.querySelectorAll("button")].find((button) => button.textContent === "Quick reflect")
    quick?.click()
    await flush()

    expect(state.reflectCalls).toContainEqual({ mode: "quick", reason: "settings-memory" })
    expect(state.toasts.some((toast) => toast.title === "Memory reflection finished")).toBe(true)

    off()
  })
})
