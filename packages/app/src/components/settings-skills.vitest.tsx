import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { ErrorBoundary } from "solid-js"

const state = vi.hoisted(() => ({
  configUpdates: [] as Array<{ skills?: Record<string, unknown> }>,
  evolutionDirsCalls: 0,
  rejectDirs: false,
  openPathCalls: [] as string[],
  revealCalls: [] as string[],
  copyCalls: [] as string[],
  openProjectCalls: [] as string[],
  navigateCalls: [] as string[],
  evolutionEnabled: undefined as boolean | undefined,
  dirs: [
    { directory: "/data/skill-evolution/p1", evolutionDir: "/data/skill-evolution/p1", projectPath: "/home/u/code/test" },
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
          evolutionReveal: async (input: { dir: string }) => {
            state.revealCalls.push(input.dir)
            return { data: { ok: true } }
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

vi.mock("@/context/layout", () => ({
  useLayout: () => ({
    projects: { open: (dir: string) => void state.openProjectCalls.push(dir) },
  }),
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => (to: string) => void state.navigateCalls.push(to),
}))

vi.mock("@opencode-ai/util/encode", () => ({
  base64Encode: (s: string) => `b64(${s})`,
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
  state.revealCalls = []
  state.copyCalls = []
  state.openProjectCalls = []
  state.navigateCalls = []
  // jsdom's navigator.clipboard is a read-only getter, so define it instead of
  // assigning. Captures writeText calls so we can assert copy works.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void state.copyCalls.push(text) },
  })
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
    expect(host.textContent).toContain("/data/skill-evolution/p1")
    off()
  })

  test("copy button writes the directory path to the clipboard", async () => {
    const { host, off } = mount()
    await flush()
    const copyBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "settingsSkills.copyDir")
    expect(copyBtn).toBeTruthy()
    copyBtn!.click()
    await flush()
    expect(state.copyCalls).toEqual(["/data/skill-evolution/p1"])
    off()
  })

  test("open button calls the backend reveal endpoint with the directory", async () => {
    const { host, off } = mount()
    await flush()
    const openBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "settingsSkills.openDir")
    expect(openBtn).toBeTruthy()
    openBtn!.click()
    await flush()
    expect(state.revealCalls).toEqual(["/data/skill-evolution/p1"])
    off()
  })

  test("open-as-project button registers the dir and navigates to it", async () => {
    const { host, off } = mount()
    await flush()
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "settingsSkills.openAsProject")
    expect(btn).toBeTruthy()
    btn!.click()
    await flush()
    expect(state.openProjectCalls).toEqual(["/data/skill-evolution/p1"])
    expect(state.navigateCalls).toEqual(["/b64(/data/skill-evolution/p1)"])
    off()
  })

  test("shows the resolved real project path when available", async () => {
    const { host, off } = mount()
    await flush()
    expect(host.textContent).toContain("/home/u/code/test")
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
