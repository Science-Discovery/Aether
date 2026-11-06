import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"

type Config = { knowledge?: { enabled?: boolean }; skills?: { evolution_enabled?: boolean } }

const state = vi.hoisted(() => ({
  set: (_config: Config, _ready = true) => {},
  opened: 0,
}))

vi.mock("@/context/global-sync", async () => {
  const { batch } = await import("solid-js")
  const { createStore, reconcile } = await import("solid-js/store")
  const [data, setData] = createStore({ config: {} as Config, ready: true })
  state.set = (config, ready = true) => {
    batch(() => {
      setData("config", reconcile(config))
      setData("ready", ready)
    })
  }
  return {
    useGlobalSync: () => ({
      data,
      get ready() {
        return data.ready
      },
    }),
  }
})

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => state.opened++ }) }))
vi.mock("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props: { children: unknown }) => props.children }))
vi.mock("@/components/knowledge-button", () => ({ KnowledgeButton: () => <button data-knowledge>knowledge</button> }))
vi.mock("@/skill-evolution/dialog-evolved-skills", () => ({ DialogEvolvedSkills: () => <div /> }))

import { FeatureButtons } from "./feature-buttons"

const mount = () => {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <FeatureButtons sessionID="session" />, host)
  return { host, off }
}

beforeEach(() => {
  document.body.innerHTML = ""
  state.set({})
  state.opened = 0
})

describe("composer feature shortcuts", () => {
  test("missing flags and pending config show neither feature", () => {
    const { host, off } = mount()
    expect(host.querySelectorAll("button")).toHaveLength(0)
    state.set({ knowledge: { enabled: true }, skills: { evolution_enabled: true } }, false)
    expect(host.querySelectorAll("button")).toHaveLength(0)
    off()
  })

  test("each explicit opt-in controls its own shortcut reactively", () => {
    const { host, off } = mount()
    state.set({ knowledge: { enabled: true } })
    expect(host.querySelector("[data-knowledge]")).not.toBeNull()
    expect(host.querySelector('[aria-label="evolvedSkills.title"]')).toBeNull()
    state.set({ skills: { evolution_enabled: true } })
    expect(host.querySelector("[data-knowledge]")).toBeNull()
    expect(host.querySelector('[aria-label="evolvedSkills.title"]')).not.toBeNull()
    state.set({ knowledge: { enabled: false }, skills: { evolution_enabled: false } })
    expect(host.querySelectorAll("button")).toHaveLength(0)
    off()
  })

  test("the enabled skill shortcut opens its dialog", () => {
    state.set({ skills: { evolution_enabled: true } })
    const { host, off } = mount()
    host.querySelector<HTMLButtonElement>('[aria-label="evolvedSkills.title"]')!.click()
    expect(state.opened).toBe(1)
    off()
  })
})
