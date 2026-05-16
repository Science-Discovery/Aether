import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({
  now: 1_777_000_000_000,
  runCalls: [] as string[],
  assistantCalls: [] as Array<{ instruction: string; selectedID?: string; projectID?: string; sessionID?: string }>,
  assistantReject: false,
  deleteCalls: [] as string[],
  configUpdates: [] as Array<{ cron?: { enabled?: boolean } }>,
  toasts: [] as Array<{ title?: string; description?: string }>,
  listCalls: 0,
  runsCalls: [] as Array<{ id: string; count?: number }>,
  navigateCalls: [] as string[],
  loadSessionsCalls: [] as Array<{ directory: string; force?: boolean }>,
  peekCalls: [] as Array<{ directory: string; bootstrap?: boolean }>,
  serverOpenCalls: [] as string[],
  globalCronEnabled: true,
  routeDir: "encoded_project" as string | undefined,
  routeID: "session_1" as string | undefined,
  currentProjectID: "project_current",
  jobs: [
    {
      definition: {
        id: "job_1",
        name: "Nightly direct",
        enabled: true,
        mode: "direct",
        project_id: null,
        session_id: null,
        schedule_type: "cron",
        schedule_value: "0 3 * * *",
        timezone: "Asia/Shanghai",
        payload: { action: "debug_noop" },
      },
      state: {
        job_id: "job_1",
        enabled: true,
        next_run_at: 1_777_000_000_000 + 60_000,
        last_run_at: null,
        last_status: null,
        running: false,
        start_at: null,
        updated_at: 1_777_000_000_000,
      },
    },
    {
      definition: {
        id: "job_2",
        name: "Expired once",
        enabled: true,
        mode: "session_agent",
        project_id: "project_1",
        session_id: "session_1",
        schedule_type: "once",
        schedule_value: "0 3 * * *",
        timezone: "Asia/Shanghai",
        payload: { message: "Summarize the session" },
      },
      state: {
        job_id: "job_2",
        enabled: false,
        next_run_at: null,
        last_run_at: null,
        last_status: "expired",
        running: false,
        start_at: null,
        updated_at: 1_777_000_000_000,
      },
    },
  ],
  runs: [
    {
      run_id: "run_1",
      job_id: "job_1",
      started_at: 1_777_000_000_000,
      finished_at: 1_777_000_000_000 + 10,
      status: "success",
      output_summary: "debug_noop executed",
      mode: "direct",
      project_id: null,
      session_id: null,
      created_session_id: null,
      payload_snapshot: { action: "debug_noop" },
      trigger_reason: "manual",
    },
  ],
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, input?: Record<string, string>) => {
      if (!input) return key
      return Object.entries(input).reduce((next, [name, value]) => next.replace(`{{${name}}}`, value), key)
    },
  }),
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => (href: string) => {
    state.navigateCalls.push(href)
  },
  useParams: () => ({
    dir: state.routeDir,
    id: state.routeID,
  }),
}))

vi.mock("@/utils/base64", () => ({
  decode64: (value: string | undefined) => (value === "encoded_project" ? "/tmp/project" : undefined),
}))

vi.mock("@opencode-ai/util/encode", () => ({
  base64Encode: (value: string) => `encoded_${value.split("/").filter(Boolean).join("_")}`,
}))

vi.mock("@/context/global-sync", async () => {
  const { createStore } = await import("solid-js/store")
  const [data, setData] = createStore({
    project: [
      {
        id: "project_1",
        worktree: "/tmp/project",
        time: { created: 0, updated: 0 },
        sandboxes: [],
      },
    ],
    config: {
      cron: {
        enabled: state.globalCronEnabled,
      },
    },
  })
  return {
    useGlobalSync: () => ({
      data,
      set: (...input: unknown[]) => (setData as (...args: unknown[]) => unknown)(...input),
      updateConfig: async (config: { cron?: { enabled?: boolean } }) => {
        state.configUpdates.push(config)
        if (typeof config.cron?.enabled === "boolean") {
          state.globalCronEnabled = config.cron.enabled
          setData("config", "cron", "enabled", config.cron.enabled)
        }
        return data.config
      },
      bootstrap: async () => undefined,
      peek: (directory: string, options?: { bootstrap?: boolean }) => {
        state.peekCalls.push({ directory, bootstrap: options?.bootstrap })
      },
      project: {
        loadSessions: async (directory: string, options?: { force?: boolean }) => {
          state.loadSessionsCalls.push({ directory, force: options?.force })
        },
      },
    }),
  }
})

vi.mock("@/context/server", () => ({
  useServer: () => ({
    projects: {
      open: (directory: string) => {
        state.serverOpenCalls.push(directory)
      },
    },
  }),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      project: {
        current: async () => ({
          data: {
            id: state.currentProjectID,
            worktree: "/tmp/current",
            time: { created: 0, updated: 0 },
            sandboxes: [],
          },
        }),
      },
      cron: {
        jobs: {
          list: async () => {
            state.listCalls += 1
            return { data: state.jobs }
          },
          runs: async (input: { id: string; count?: number }) => {
            state.runsCalls.push(input)
            return { data: state.runs.filter((run) => run.job_id === input.id) }
          },
          run: async (input: { id: string }) => {
            state.runCalls.push(input.id)
            return {
              data: {
                ...state.runs[0],
                job_id: input.id,
              },
            }
          },
          delete: async (input: { id: string }) => {
            state.deleteCalls.push(input.id)
            state.jobs = state.jobs.filter((job) => job.definition.id !== input.id)
            return {
              data: {
                ok: true,
                job_id: input.id,
                definition: state.jobs[0]?.definition,
              },
            }
          },
          assistant: async (input: {
            instruction: string
            selectedID?: string
            projectID?: string
            sessionID?: string
          }) => {
            state.assistantCalls.push(input)
            if (state.assistantReject) {
              return {
                data: {
                  action: "reject",
                  summary: "cannot create cron",
                  job: null,
                },
              }
            }
            return {
              data: {
                action: input.selectedID ? "update" : "create",
                summary: "assistant ok",
                job: state.jobs[0],
              },
            }
          },
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

import { SettingsCron } from "./settings-cron"

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <SettingsCron />, host)
  return { host, off }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ""
  state.runCalls = []
  state.assistantCalls = []
  state.assistantReject = false
  state.deleteCalls = []
  state.configUpdates = []
  state.toasts = []
  state.listCalls = 0
  state.runsCalls = []
  state.navigateCalls = []
  state.loadSessionsCalls = []
  state.peekCalls = []
  state.serverOpenCalls = []
  state.globalCronEnabled = true
  state.routeDir = "encoded_project"
  state.routeID = "session_1"
  state.currentProjectID = "project_current"
  state.jobs = [
    {
      definition: {
        id: "job_1",
        name: "Nightly direct",
        enabled: true,
        mode: "direct",
        project_id: null,
        session_id: null,
        schedule_type: "cron",
        schedule_value: "0 3 * * *",
        timezone: "Asia/Shanghai",
        payload: { action: "debug_noop" },
      },
      state: {
        job_id: "job_1",
        enabled: true,
        next_run_at: state.now + 60_000,
        last_run_at: null,
        last_status: null,
        running: false,
        start_at: null,
        updated_at: state.now,
      },
    },
    {
      definition: {
        id: "job_2",
        name: "Expired once",
        enabled: true,
        mode: "session_agent",
        project_id: "project_1",
        session_id: "session_1",
        schedule_type: "once",
        schedule_value: "0 3 * * *",
        timezone: "Asia/Shanghai",
        payload: { message: "Summarize the session" },
      },
      state: {
        job_id: "job_2",
        enabled: false,
        next_run_at: null,
        last_run_at: null,
        last_status: "expired",
        running: false,
        start_at: null,
        updated_at: state.now,
      },
    },
  ]
  state.runs = [
    {
      run_id: "run_1",
      job_id: "job_1",
      started_at: state.now,
      finished_at: state.now + 10,
      status: "success",
      output_summary: "debug_noop executed",
      mode: "isolated_agent",
      project_id: "project_1",
      session_id: "session_created",
      created_session_id: "session_created",
      payload_snapshot: { action: "debug_noop" },
      trigger_reason: "manual",
    },
  ]
  Object.defineProperty(window, "confirm", {
    configurable: true,
    value: vi.fn(() => true),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("settings cron", () => {
  test("renders jobs, status metrics, and recent runs", async () => {
    const { host, off } = mount()
    await flush()

    expect(host.textContent).toContain("Nightly direct")
    expect(host.textContent).toContain("Expired once")
    expect(host.textContent).toContain("settings.cron.scheduler.running")
    ;([...host.querySelectorAll("[data-action='settings-cron-select']")] as HTMLButtonElement[])[0]?.click()
    await flush()

    expect(host.textContent).toContain("debug_noop executed")
    expect(state.runsCalls[0]).toEqual({ id: "job_1", count: 10 })
    const open = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "settings.cron.action.openSession",
    )
    expect(open).toBeTruthy()
    open?.click()
    await flush()
    expect(state.serverOpenCalls).toContain("/tmp/project")
    expect(state.peekCalls).toContainEqual({ directory: "/tmp/project", bootstrap: true })
    expect(state.loadSessionsCalls).toContainEqual({ directory: "/tmp/project", force: true })
    expect(state.navigateCalls).toEqual(["/encoded_tmp_project/session/session_created"])

    off()
  })

  test("run now and delete call cron API and refresh jobs", async () => {
    const { host, off } = mount()
    await flush()
    ;([...host.querySelectorAll("[data-action='settings-cron-select']")] as HTMLButtonElement[])[0]?.click()
    await flush()

    const run = [...host.querySelectorAll("button")].find((button) => button.textContent === "settings.cron.action.runNow")
    expect(run).toBeTruthy()
    run?.click()
    await flush()
    expect(state.runCalls).toEqual(["job_1"])
    expect(state.listCalls).toBeGreaterThan(1)

    const del = [...host.querySelectorAll("button")].find((button) => button.textContent === "settings.cron.action.delete")
    expect(del).toBeTruthy()
    del?.click()
    await flush()
    expect(state.deleteCalls).toEqual(["job_1"])
    expect(window.confirm).toHaveBeenCalled()

    off()
  })

  test("toggles global cron execution through config update", async () => {
    const { host, off } = mount()
    await flush()

    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement | null
    expect(toggle).toBeTruthy()
    expect(toggle?.getAttribute("aria-checked")).toBe("true")

    toggle?.click()
    await flush()

    expect(state.configUpdates).toEqual([{ cron: { enabled: false } }])
    expect(host.textContent).toContain("settings.cron.global.disabledHint")

    off()
  })

  test("cron assistant hint targets the selected job and submits instruction", async () => {
    const { host, off } = mount()
    await flush()

    expect(host.textContent).toContain("settings.cron.assistant.create")
    ;([...host.querySelectorAll("[data-action='settings-cron-select']")] as HTMLButtonElement[])[0]?.click()
    await flush()

    expect(host.textContent).toContain("settings.cron.assistant.update")
    expect(host.textContent).toContain("Nightly direct")

    const input = host.querySelector("[data-testid='settings-cron-assistant-input']") as HTMLTextAreaElement
    input.value = "把这个任务改成每天四点"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    ;(host.querySelector("[data-testid='settings-cron-assistant-submit']") as HTMLButtonElement).click()
    await flush()

    expect(state.assistantCalls.at(-1)).toEqual({
      instruction: "把这个任务改成每天四点",
      selectedID: "job_1",
      projectID: "project_1",
      sessionID: "session_1",
    })
    off()
  })

  test("clicking blank space clears the selected cron job", async () => {
    const { host, off } = mount()
    await flush()

    ;([...host.querySelectorAll("[data-action='settings-cron-select']")] as HTMLButtonElement[])[0]?.click()
    await flush()
    expect(host.textContent).toContain("settings.cron.assistant.update")
    expect(host.textContent).toContain("settings.cron.action.runNow")

    ;(host.querySelector("[data-testid='settings-cron-root']") as HTMLDivElement).click()
    await flush()

    expect(host.textContent).toContain("settings.cron.assistant.create")
    expect(host.textContent).not.toContain("settings.cron.action.runNow")
    off()
  })

  test("cron assistant hint creates a new job when no job is selected", async () => {
    const { host, off } = mount()
    await flush()

    expect(host.textContent).toContain("settings.cron.assistant.create")
    expect(host.textContent).not.toContain("settings.cron.assistant.update")

    const input = host.querySelector("[data-testid='settings-cron-assistant-input']") as HTMLTextAreaElement
    input.value = "每天早上九点提醒我写日报"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    ;(host.querySelector("[data-testid='settings-cron-assistant-submit']") as HTMLButtonElement).click()
    await flush()

    expect(state.assistantCalls.at(-1)).toEqual({
      instruction: "每天早上九点提醒我写日报",
      selectedID: undefined,
      projectID: "project_1",
      sessionID: "session_1",
    })
    off()
  })

  test("cron assistant falls back to the current project when there is no current session route", async () => {
    state.routeDir = undefined
    state.routeID = undefined
    const { host, off } = mount()
    await flush()

    const input = host.querySelector("[data-testid='settings-cron-assistant-input']") as HTMLTextAreaElement
    input.value = "每天早上九点提醒我写日报"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    ;(host.querySelector("[data-testid='settings-cron-assistant-submit']") as HTMLButtonElement).click()
    await flush()

    expect(state.assistantCalls.at(-1)).toEqual({
      instruction: "每天早上九点提醒我写日报",
      selectedID: undefined,
      projectID: "project_current",
      sessionID: undefined,
    })
    off()
  })

  test("cron assistant shows a not-created toast when the assistant rejects a request", async () => {
    state.assistantReject = true
    const { host, off } = mount()
    await flush()

    const input = host.querySelector("[data-testid='settings-cron-assistant-input']") as HTMLTextAreaElement
    input.value = "随便聊聊"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    ;(host.querySelector("[data-testid='settings-cron-assistant-submit']") as HTMLButtonElement).click()
    await flush()

    expect(state.toasts.at(-1)).toEqual({
      title: "settings.cron.assistant.toast.rejected",
      description: "cannot create cron",
    })
    expect(input.value).toBe("随便聊聊")
    off()
  })
})
