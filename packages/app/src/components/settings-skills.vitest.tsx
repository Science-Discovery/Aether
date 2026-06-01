import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { ErrorBoundary } from "solid-js"

const state = vi.hoisted(() => ({
  configUpdates: [] as Array<{ skills?: Record<string, unknown> }>,
  evolutionDirsCalls: 0,
  rejectDirs: false,
  openPathCalls: [] as string[],
  evolutionEnabled: undefined as boolean | undefined,
  dirs: [
    { projectId: "p1", name: "Aether", directory: "/home/u/code/Aether", evolutionDir: "/data/skill-evolution/p1/skills" },
  ],
}))

vi.mock("@/context/global-sync", async () => {
  const { createStore } = await import("solid-js/store")
  const [data, setData] = createStore({
    config: {
      skills: {
        evolution_enabled: state.evolutionEnabled,
      },
    },
  })
  return {
    useGlobalSync: () => ({
      data,
      set: (...input: unknown[]) => (setData as (...args: unknown[]) => unknown)(...input),
      updateConfig: async (config: { skills?: Record<string, unknown> }) => {
        state.configUpdates.push(config)
        if (config.skills) setData("config", "skills", (prev) => ({ ...prev, ...config.skills }))
        return data.config
      },
    }),
  }
})

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      config: {
        skills: {
          evolutionDirs: async () => {
            state.evolutionDirsCalls += 1
            if (state.rejectDirs) throw new Error("boom")
            return { data: state.dirs }
          },
        },
      },
    },
  }),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({
    openPath: async (path: string) => {
      state.openPathCalls.push(path)
    },
  }),
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
  showToast: () => {},
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

import { SettingsSkills } from "./settings-skills"

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <SettingsSkills />, host)
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
  state.evolutionDirsCalls = 0
  state.openPathCalls = []
})

afterEach(() => {})

describe("SettingsSkills", () => {
  test("renders without crashing and shows the master switch", async () => {
    const { host, off } = mount()
    await flush()
    // Master switch present, defaults to on (evolution_enabled unset → on)
    const sw = host.querySelector('[role="switch"]')
    expect(sw).not.toBeNull()
    expect(sw?.getAttribute("aria-checked")).toBe("true")
    off()
  })

  test("lists each project's output directory", async () => {
    const { host, off } = mount()
    await flush()
    expect(state.evolutionDirsCalls).toBeGreaterThan(0)
    expect(host.textContent).toContain("/data/skill-evolution/p1/skills")
    off()
  })

  test("does not crash when evolutionDirs rejects (resource error path)", async () => {
    // Reproduces the real crash: the new endpoint call fails (e.g. backend not
    // restarted → 404). A resource in error state, accessed bare in JSX, re-throws
    // and tears down the subtree — caught here by an ErrorBoundary fallback.
    state.rejectDirs = true
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(
      () => (
        <ErrorBoundary fallback={<div data-testid="crashed">crashed</div>}>
          <SettingsSkills />
        </ErrorBoundary>
      ),
      host,
    )
    await flush()
    state.rejectDirs = false
    // The master switch must still render; no ErrorBoundary fallback.
    expect(host.querySelector('[data-testid="crashed"]')).toBeNull()
    expect(host.querySelector('[role="switch"]')).not.toBeNull()
    off()
  })

  test("toggling the master switch off writes evolution_enabled=false", async () => {
    const { host, off } = mount()
    await flush()
    const sw = host.querySelector('[role="switch"]') as HTMLButtonElement
    sw.click()
    await flush()
    expect(state.configUpdates).toContainEqual({ skills: { evolution_enabled: false } })
    off()
  })
})
