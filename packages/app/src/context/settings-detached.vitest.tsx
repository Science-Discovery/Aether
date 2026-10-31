import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { SettingsProvider, useSettings } from "./settings"

vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))

const disposers: (() => void)[] = []

function mount() {
  const value: { settings?: ReturnType<typeof useSettings> } = {}
  const host = document.createElement("div")
  document.body.append(host)
  const Read = () => {
    value.settings = useSettings()
    return null
  }
  const off = render(
    () => (
      <SettingsProvider>
        <Read />
      </SettingsProvider>
    ),
    host,
  )
  disposers.push(off)
  return { settings: value.settings!, off }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
  localStorage.clear()
})

describe("independent fork preference", () => {
  test("defaults to attached forks and persists independently of the conversation graph switch", () => {
    const first = mount()
    expect(first.settings.general.detached()).toBe(false)
    first.settings.general.setBranchesTab(false)
    first.settings.general.setDetached(true)
    expect(first.settings.general.detached()).toBe(true)
    first.off()
    const second = mount()
    expect(second.settings.general.branchesTab()).toBe(false)
    expect(second.settings.general.detached()).toBe(true)
  })
})
