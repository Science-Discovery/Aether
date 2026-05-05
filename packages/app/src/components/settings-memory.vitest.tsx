import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({
  updateCalls: [] as unknown[],
  setMemory: undefined as ((value: Record<string, unknown>) => void) | undefined,
  setPath: undefined as ((value: Record<string, unknown>) => void) | undefined,
  createClientCalls: [] as Array<Record<string, unknown>>,
  memoryGetCalls: [] as Array<Record<string, unknown> | undefined>,
  memoryRunCalls: [] as Array<Record<string, unknown> | undefined>,
  dialogShows: [] as unknown[],
  dialogTexts: [] as string[],
  runMode: "immediate" as "immediate" | "deferred",
  pendingRuns: [] as Array<{
    resolve: () => void
    reject: (error?: unknown) => void
  }>,
  params: { id: "session-active-01" as string | undefined },
  sessionsByDirectory: new Map<string, Array<{ id: string; workspaceID?: string }>>(),
  updateMode: "immediate" as "immediate" | "deferred",
  pendingUpdates: [] as Array<{
    patch: Record<string, unknown>
    resolve: () => void
    reject: (error?: unknown) => void
  }>,
  bootstrapCalls: 0,
  serverMemory: {
    enabled: true,
  } as Record<string, unknown>,
  memoryRunResult: {
    status: {
      memory_version: "memory-v1-tree-backfill",
      state: "completed",
      refresh_required: false,
      noop: false,
      run_status: "success",
    },
    run: {
      run_id: "run-01",
      memory_version: "memory-v1-tree-backfill",
      scope: "global",
      dry_run: false,
      status: "success",
      started_at: 1,
      finished_at: 2,
      candidate_count: 3,
      promoted_daily_count: 2,
      promoted_user_count: 1,
    },
  } as Record<string, unknown>,
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      return [key, ...Object.values(params).map(String)].join(" ")
    },
  }),
}))

vi.mock("@solidjs/router", () => ({
  useParams: () => state.params,
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    createClient: (opts: Record<string, unknown>) => {
      state.createClientCalls.push(opts)
      return {
        memory: {
          get: async (input?: Record<string, unknown>) => {
            state.memoryGetCalls.push(input)
            return {
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
                inbox: {
                  store: "memory",
                  file: "/tmp/memory/inbox/MEMORY.md",
                  limit: 60000,
                  used: 18,
                  usage: 0.0003,
                  entries: ["preference[explicit]: pending-test-note"],
                },
                memory: {
                  store: "memory",
                  file: "/tmp/memory/daily",
                  limit: 12000,
                  used: 0,
                  usage: 0,
                  entries: [],
                },
                daily: {
                  root: "/tmp/memory/daily",
                  days: [],
                },
                active: {
                  session_id: "session-active-01",
                  prompt: "<memory_context>\n- active-note\n</memory_context>",
                  entries: [{ source: "session", index: 1, text: "active-note" }],
                },
              },
            }
          },
          refresh: {
            run: async (input?: Record<string, unknown>) => {
              state.memoryRunCalls.push(input)
              if (state.runMode === "deferred") {
                return await new Promise<{ data: Record<string, unknown> }>((resolve, reject) => {
                  state.pendingRuns.push({
                    resolve: () => resolve({ data: state.memoryRunResult }),
                    reject: (error?: unknown) => reject(error ?? new Error("mock backfill failure")),
                  })
                })
              }
              return { data: state.memoryRunResult }
            },
          },
        },
      }
    },
  }),
}))

vi.mock("@/context/global-sync", async () => {
  const { createStore } = await import("solid-js/store")

  const initialMemory = {
    enabled: true,
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
  state.setPath = (value) => {
    setData("path", value as typeof data.path)
  }

  return {
    useGlobalSync: () => ({
      data,
      set: (...args: unknown[]) => (setData as (...input: unknown[]) => unknown)(...args),
      peek: (directory: string) => {
        const sessions = state.sessionsByDirectory.get(directory) ?? []
        return [{ session: sessions }, vi.fn()] as const
      },
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
  Button: (props: { children?: unknown; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { title?: unknown; children?: unknown }) => (
    <section role="dialog">
      <h1>{props.title}</h1>
      <div>{props.children}</div>
    </section>
  ),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (fn: () => unknown) => {
      createRoot((done) => {
        const node = fn()
        state.dialogShows.push(node)
        state.dialogTexts.push(node instanceof HTMLElement ? (node.textContent ?? "") : String(node))
        done()
      })
    },
    close: () => undefined,
  }),
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
  state.createClientCalls = []
  state.memoryGetCalls = []
  state.memoryRunCalls = []
  state.dialogShows = []
  state.dialogTexts = []
  state.runMode = "immediate"
  state.pendingRuns = []
  state.updateMode = "immediate"
  state.pendingUpdates = []
  state.bootstrapCalls = 0
  state.serverMemory = {
    enabled: true,
  }
  state.memoryRunResult = {
    status: {
      memory_version: "memory-v1-tree-backfill",
      state: "completed",
      refresh_required: false,
      noop: false,
      run_status: "success",
    },
    run: {
      run_id: "run-01",
      memory_version: "memory-v1-tree-backfill",
      scope: "global",
      dry_run: false,
      status: "success",
      started_at: 1,
      finished_at: 2,
      candidate_count: 3,
      promoted_daily_count: 2,
      promoted_user_count: 1,
    },
  }
  state.setMemory?.({
    enabled: true,
  })
  state.setPath?.({
    directory: "/tmp/project",
  })
  state.params.id = "session-active-01"
  state.sessionsByDirectory = new Map([
    ["/tmp/project", [{ id: "session-active-01", workspaceID: "workspace-active-01" }]],
  ])
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("settings memory", () => {
  test("memory fetch uses active session workspace and requests L1 active memory", async () => {
    const { off } = mount()
    await Promise.resolve()
    expect(state.createClientCalls.length).toBeGreaterThan(0)
    const first = state.createClientCalls[0] ?? {}
    expect(first).toMatchObject({
      directory: "/tmp/project",
      experimental_workspaceID: "workspace-active-01",
      throwOnError: true,
    })
    expect(state.memoryGetCalls[0]).toEqual({ sessionID: "session-active-01" })
    off()
  })

  test("changing memory enabled updates config", async () => {
    const { host, off } = mount()

    await Promise.resolve()

    const switches = [...host.querySelectorAll('[data-switch="true"]')] as HTMLButtonElement[]
    expect(switches.length).toBeGreaterThanOrEqual(1)
    switches[0].click()

    expect(state.updateCalls).toHaveLength(1)
    expect(state.updateCalls[0]).toEqual({
      memory: expect.objectContaining({
        enabled: false,
      }),
    })

    off()
  })

  test("renders pending inbox memory returned by server", async () => {
    const { host, off } = mount()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.textContent).toContain("settings.memory.store.inbox")
    expect(host.textContent).toContain("pending-test-note")

    off()
  })

  test("backfill button runs global incremental refresh and opens summary dialog", async () => {
    const { host, off } = mount()

    await Promise.resolve()

    const button = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("settings.memory.action.backfill"),
    ) as HTMLButtonElement | undefined
    expect(button).toBeTruthy()
    button?.click()

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.memoryRunCalls).toEqual([{ scope: "global" }])
    expect(state.memoryGetCalls.length).toBeGreaterThanOrEqual(2)
    expect(state.dialogShows).toHaveLength(1)
    const text = state.dialogTexts[0] ?? ""
    expect(text).toContain("settings.memory.backfill.result.title")
    expect(text).toContain("settings.memory.backfill.result.status.success")
    expect(text).toContain("3")
    expect(text).toContain("2")
    expect(text).toContain("1")

    off()
  })

  test("backfill summary translates noop status instead of showing raw backend enum", async () => {
    state.memoryRunResult = {
      status: {
        memory_version: "memory-v1-tree-backfill",
        state: "completed",
        refresh_required: false,
        noop: true,
        run_status: "noop",
      },
      run: {
        run_id: "run-noop",
        memory_version: "memory-v1-tree-backfill",
        scope: "global",
        dry_run: false,
        status: "noop",
        started_at: 1,
        finished_at: 2,
        candidate_count: 0,
        promoted_daily_count: 0,
        promoted_user_count: 0,
      },
    }
    const { host, off } = mount()

    await Promise.resolve()

    const button = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("settings.memory.action.backfill"),
    ) as HTMLButtonElement | undefined
    button?.click()

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const text = state.dialogTexts[0] ?? ""
    expect(text).toContain("settings.memory.backfill.result.status.noop")
    expect(text).not.toContain(" noop")

    off()
  })

  test("backfill button is disabled when memory is disabled", async () => {
    state.setMemory?.({
      enabled: false,
    })
    const { host, off } = mount()

    await Promise.resolve()

    const button = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("settings.memory.action.backfill"),
    ) as HTMLButtonElement | undefined
    expect(button).toBeTruthy()
    expect(button?.disabled).toBe(true)
    button?.click()

    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.memoryRunCalls).toEqual([])

    off()
  })

  test("backfill stays disabled across remount while background run is pending", async () => {
    state.runMode = "deferred"
    const first = mount()

    await Promise.resolve()

    const button = [...first.host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("settings.memory.action.backfill"),
    ) as HTMLButtonElement | undefined
    expect(button).toBeTruthy()
    button?.click()

    await Promise.resolve()
    expect(state.memoryRunCalls).toEqual([{ scope: "global" }])
    expect(button?.disabled).toBe(true)
    expect(first.host.textContent).toContain("settings.memory.backfill.runningHint")
    expect(first.host.querySelector('[title="settings.memory.backfill.runningTooltip"]')).toBeTruthy()

    first.off()
    const second = mount()

    await Promise.resolve()

    const remounted = [...second.host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("settings.memory.action.backfilling"),
    ) as HTMLButtonElement | undefined
    expect(remounted).toBeTruthy()
    expect(remounted?.disabled).toBe(true)
    expect(second.host.textContent).toContain("settings.memory.backfill.runningHint")
    expect(second.host.querySelector('[title="settings.memory.backfill.runningTooltip"]')).toBeTruthy()

    state.pendingRuns[0]?.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(remounted?.disabled).toBe(false)

    second.off()
  })

  test("backfill action has no separate rescan button", async () => {
    const { host, off } = mount()

    await Promise.resolve()

    const backfill = [...host.querySelectorAll("button")].filter((item) =>
      item.textContent?.includes("settings.memory.action.backfill"),
    )
    const rescan = [...host.querySelectorAll("button")].filter((item) =>
      item.textContent?.includes("settings.memory.action.rescan"),
    )
    expect(backfill).toHaveLength(1)
    expect(rescan).toHaveLength(0)

    off()
  })

  test("latest failed overlapping update restores authoritative config via bootstrap", async () => {
    state.updateMode = "deferred"
    const { host, off } = mount()
    await Promise.resolve()

    const switches = [...host.querySelectorAll('[data-switch="true"]')] as HTMLButtonElement[]
    expect(switches.length).toBeGreaterThanOrEqual(1)
    switches[0].click()
    switches[0].click()
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
    const switchesAfter = [...host.querySelectorAll('[data-switch="true"]')] as HTMLButtonElement[]
    expect(switchesAfter[0]?.textContent).toBe("true")

    off()
  })
})
