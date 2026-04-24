import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"

const state = vi.hoisted(() => ({
  now: 1_777_000_000_000,
  runCalls: [] as string[],
  deleteCalls: [] as string[],
  configUpdates: [] as Array<{ cron?: { enabled?: boolean } }>,
  listCalls: 0,
  runsCalls: [] as Array<{ id: string; count?: number }>,
  globalCronEnabled: true,
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

vi.mock("@/context/global-sync", async () => {
  const { createStore } = await import("solid-js/store")
  const [data, setData] = createStore({
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
    }),
  }
})

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
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
        },
      },
    },
  }),
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
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
  showToast: () => undefined,
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
  state.deleteCalls = []
  state.configUpdates = []
  state.listCalls = 0
  state.runsCalls = []
  state.globalCronEnabled = true
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
      mode: "direct",
      project_id: null,
      session_id: null,
      created_session_id: null,
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
    expect(host.textContent).toContain("debug_noop executed")
    expect(state.runsCalls[0]).toEqual({ id: "job_1", count: 10 })

    off()
  })

  test("run now and delete call cron API and refresh jobs", async () => {
    const { host, off } = mount()
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
})
