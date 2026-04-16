import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({
  updateCalls: [] as unknown[],
  setMemory: undefined as ((value: Record<string, unknown>) => void) | undefined,
  updateMode: "immediate" as "immediate" | "deferred",
  pendingUpdates: [] as Array<{
    patch: Record<string, unknown>
    resolve: () => void
    reject: (error?: unknown) => void
  }>,
  bootstrapCalls: 0,
  serverMemory: {
    cross_session_search_enabled: true,
    cross_session_search_scope: "current_project",
    memory_reflection_enabled: true,
    user_profile_enabled: true,
    user_profile_include_inferred: true,
  } as Record<string, unknown>,
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    createClient: () => ({
      memory: {
        get: async () => ({
          data: {
            settings: {},
            user: {
              store: "user",
              file: "/tmp/USER.md",
              limit: 12000,
              used: 0,
              usage: 0,
              entries: [],
            },
            memory: {
              store: "memory",
              file: "/tmp/MEMORY.md",
              limit: 12000,
              used: 0,
              usage: 0,
              entries: [],
            },
          },
        }),
      },
    }),
  }),
}))

vi.mock("@/context/global-sync", async () => {
  const { createStore } = await import("solid-js/store")

  const initialMemory = {
    cross_session_search_enabled: true,
    cross_session_search_scope: "current_project",
    memory_reflection_enabled: true,
    user_profile_enabled: true,
    user_profile_include_inferred: true,
  }
  state.serverMemory = { ...initialMemory }

  const [data, setData] = createStore({
    config: {
      memory: initialMemory,
    },
    path: {
      directory: "/tmp/project",
    },
  })

  state.setMemory = (value) => {
    setData("config", "memory", value)
  }

  return {
    useGlobalSync: () => ({
      data,
      set: (...args: unknown[]) => (setData as (...input: unknown[]) => unknown)(...args),
      bootstrap: async () => {
        state.bootstrapCalls += 1
        setData("config", "memory", { ...(state.serverMemory as Record<string, unknown>) })
      },
      updateConfig: async (patch: Record<string, unknown>) => {
        state.updateCalls.push(patch)
        const next = (patch.memory ?? {}) as Record<string, unknown>
        const apply = () => {
          state.serverMemory = {
            ...(state.serverMemory as Record<string, unknown>),
            ...next,
          }
          setData("config", "memory", { ...(state.serverMemory as Record<string, unknown>) })
        }

        if (state.updateMode === "immediate") {
          apply()
          return
        }

        return await new Promise<void>((resolve, reject) => {
          state.pendingUpdates.push({
            patch,
            resolve: () => {
              apply()
              resolve()
            },
            reject: (error?: unknown) => reject(error ?? new Error("mock update failure")),
          })
        })
      },
    }),
  }
})

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: {
    options: unknown[]
    current?: unknown
    value: (item: unknown) => string
    label: (item: unknown) => string
    onSelect?: (item: unknown) => void
    disabled?: boolean
    ["data-action"]?: string
  }) => {
    const currentValue = () => (props.current ? props.value(props.current) : "")
    return (
      <button
        type="button"
        data-action={props["data-action"]}
        disabled={props.disabled}
        onClick={() => {
          if (props.disabled) return
          const next = props.options.find((item) => props.value(item) !== currentValue()) ?? props.options[0]
          props.onSelect?.(next)
        }}
      >
        {props.current ? props.label(props.current) : "none"}
      </button>
    )
  },
}))

vi.mock("@opencode-ai/ui/switch", () => ({
  Switch: (props: { checked?: boolean; disabled?: boolean; onChange?: (value: boolean) => void }) => (
    <button
      type="button"
      data-switch="true"
      disabled={props.disabled}
      onClick={() => {
        if (props.disabled) return
        props.onChange?.(!props.checked)
      }}
    >
      {String(!!props.checked)}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/text-field", () => ({
  TextField: (props: {
    value?: string
    onInput?: (event: InputEvent & { currentTarget: HTMLInputElement }) => void
    onBlur?: () => void
  }) => (
    <input
      value={props.value}
      onInput={(event) => props.onInput?.(event as InputEvent & { currentTarget: HTMLInputElement })}
      onBlur={props.onBlur}
    />
  ),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: () => undefined,
}))

vi.mock("./settings-list", () => ({
  SettingsList: (props: { children?: unknown }) => <div>{props.children}</div>,
}))

import { SettingsMemory } from "./settings-memory"

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <SettingsMemory />, host)
  return { host, off }
}

beforeEach(() => {
  document.body.innerHTML = ""
  state.updateCalls = []
  state.updateMode = "immediate"
  state.pendingUpdates = []
  state.bootstrapCalls = 0
  state.serverMemory = {
    cross_session_search_enabled: true,
    cross_session_search_scope: "current_project",
    memory_reflection_enabled: true,
    user_profile_enabled: true,
    user_profile_include_inferred: true,
  }
  state.setMemory?.({
    cross_session_search_enabled: true,
    cross_session_search_scope: "current_project",
    memory_reflection_enabled: true,
    user_profile_enabled: true,
    user_profile_include_inferred: true,
  })
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("settings memory", () => {
  test("changing scope does not break later memory updates", async () => {
    const { host, off } = mount()

    await Promise.resolve()

    const scopeButton = host.querySelector('[data-action="settings-memory-scope"]') as HTMLButtonElement
    expect(scopeButton).toBeTruthy()
    scopeButton.click()

    const switches = [...host.querySelectorAll('[data-switch="true"]')] as HTMLButtonElement[]
    expect(switches.length).toBeGreaterThanOrEqual(3)
    switches[1].click()

    expect(state.updateCalls).toHaveLength(2)
    expect(state.updateCalls[0]).toEqual({
      memory: expect.objectContaining({
        cross_session_search_scope: "global",
      }),
    })
    expect(state.updateCalls[1]).toEqual({
      memory: expect.objectContaining({
        memory_reflection_enabled: false,
      }),
    })

    off()
  })

  test("latest failed overlapping update restores authoritative config via bootstrap", async () => {
    state.updateMode = "deferred"
    const { host, off } = mount()
    await Promise.resolve()

    const scopeButton = host.querySelector('[data-action="settings-memory-scope"]') as HTMLButtonElement
    expect(scopeButton).toBeTruthy()
    scopeButton.click()

    const switches = [...host.querySelectorAll('[data-switch="true"]')] as HTMLButtonElement[]
    expect(switches.length).toBeGreaterThanOrEqual(3)
    switches[1].click()
    expect(state.updateCalls).toHaveLength(2)
    expect(state.pendingUpdates.length).toBe(2)

    state.pendingUpdates[0]?.reject(new Error("request-1 failed"))
    await Promise.resolve()
    await Promise.resolve()
    expect(state.bootstrapCalls).toBe(0)

    state.pendingUpdates[1]?.reject(new Error("request-2 failed"))
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.bootstrapCalls).toBe(1)
    expect(scopeButton.textContent).toBe("settings.memory.scope.currentProject")
    const switchesAfter = [...host.querySelectorAll('[data-switch="true"]')] as HTMLButtonElement[]
    expect(switchesAfter[1]?.textContent).toBe("true")

    off()
  })
})
