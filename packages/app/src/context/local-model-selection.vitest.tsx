import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/util/encode"
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { ModelsProvider } from "./models"
import { LocalProvider, useLocal, type ModelKey } from "./local"
import { useProviders } from "@/hooks/use-providers"
import { Persist, removePersisted } from "@/utils/persist"

vi.mock("@solidjs/router", () => ({ useParams: () => env.params }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
vi.mock("@/context/global-sync", () => ({ useGlobalSync: () => env.global }))
vi.mock("@/context/sdk", () => ({ useSDK: () => env.sdk }))
vi.mock("@/context/sync", () => ({ useSync: () => ({ data: env.data }) }))

const removed = { providerID: "opencode", modelID: "big-pickle" }
const paid = { providerID: "opencode", modelID: "paid" }
const custom = { providerID: "custom", modelID: "big-pickle" }
const cleanup: Array<() => void> = []
let env: ReturnType<typeof fixture>
let count = 0

function catalog(): ProviderListResponse {
  return {
    all: [paid, custom].map((key) => ({
      id: key.providerID,
      name: key.providerID,
      env: [],
      models: {
        [key.modelID]: {
          id: key.modelID,
          name: key.modelID,
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: key === paid ? 1 : 0, output: key === paid ? 1 : 0 },
          limit: { context: 1000, output: 100 },
        },
      },
    })),
    connected: ["opencode", "custom"],
    default: { opencode: "paid", custom: "big-pickle" },
  } as unknown as ProviderListResponse
}

function fixture(input?: { scope?: ModelKey; agent?: ModelKey; model?: string; recent?: ModelKey[] }) {
  const dir = `/models-${++count}`
  const [params] = createStore({ id: "session", dir: base64Encode(dir) })
  const [data, set] = createStore({
    ready: true,
    provider: catalog(),
    agent: [{ name: "build", mode: "primary", model: input?.agent }],
    config: { model: input?.model, disabled_models: [] as string[] },
  })
  const [project, change] = createStore({
    status: "complete",
    modelReady: true,
    provider: catalog(),
    config: { disabled_models: [] as string[] },
  })
  const target = Persist.workspace(dir, "model-selection")
  localStorage.setItem(
    `${target.storage}:${target.key}`,
    JSON.stringify({
      session: input?.scope ? { session: { agent: "build", model: input.scope } } : {},
    }),
  )
  removePersisted(Persist.global("model"))
  localStorage.setItem(
    "opencode.global.dat:model",
    JSON.stringify({ user: [], recent: input?.recent ?? [], variant: {} }),
  )
  return {
    params,
    data,
    set,
    project,
    change,
    target,
    global: {
      data,
      get ready() {
        return data.ready
      },
      child: () => [project],
      set,
      updateConfig: async () => undefined,
    },
    sdk: {
      directory: dir,
      event: { listen: () => () => undefined },
      client: {
        session: {
          preference: {
            get: async () => ({ data: undefined }),
            update: async () => ({ data: undefined }),
          },
        },
      },
    },
  }
}

function mount() {
  const result: { local?: ReturnType<typeof useLocal>; providers?: ReturnType<typeof useProviders> } = {}
  const Probe = () => {
    result.local = useLocal()
    result.providers = useProviders()
    return <output>{result.local.model.current()?.id ?? "none"}</output>
  }
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <ModelsProvider>
        <LocalProvider>
          <Probe />
        </LocalProvider>
      </ModelsProvider>
    ),
    host,
  )
  const close = () => {
    dispose()
    host.remove()
  }
  cleanup.push(close)
  return { result, close }
}

afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

describe("local model selection", () => {
  test("an old session blocks fallback and keeps its saved selection during loading", () => {
    env = fixture({ scope: removed })
    env.set("ready", false)
    const { result } = mount()
    expect(result.local?.model.current()).toBeUndefined()
    expect(result.local?.model.unavailable()).toBe(false)
    env.set("ready", true)
    expect(result.local?.model.unavailable()).toBe(true)
    expect(JSON.parse(localStorage.getItem(`${env.target.storage}:${env.target.key}`)!).session.session.model).toEqual(
      removed,
    )
  })

  test.each(["agent", "default", "recent"])(
    "an unavailable %s selection cannot silently select a paid model",
    (source) => {
      env = fixture({
        agent: source === "agent" ? removed : undefined,
        model: source === "default" ? "opencode/big-pickle" : undefined,
        recent: source === "recent" ? [removed, custom] : [],
      })
      const { result } = mount()
      expect(result.local?.model.current()).toBeUndefined()
      expect(result.local?.model.unavailable()).toBe(true)
    },
  )

  test("a deliberate replacement persists across remount while retaining agent defaults", () => {
    env = fixture({ scope: removed, agent: removed, model: "opencode/big-pickle", recent: [removed] })
    const first = mount()
    first.result.local!.model.set(custom, { recent: true })
    expect(first.result.local?.model.current()?.provider.id).toBe("custom")
    first.close()
    const next = mount()
    expect(next.result.local?.model.current()?.provider.id).toBe("custom")
    expect(next.result.local?.model.unavailable()).toBe(false)
    expect(env.data.agent[0].model).toEqual(removed)
    expect(env.data.config.model).toBe("opencode/big-pickle")
  })

  test("a valid explicit selection outranks stale lower priority defaults", () => {
    env = fixture({ scope: paid, agent: removed, model: "opencode/big-pickle", recent: [removed] })
    const { result } = mount()
    expect(result.local?.model.current()?.id).toBe("paid")
    expect(result.local?.model.unavailable()).toBe(false)
  })

  test("connecting and disconnecting the first provider updates an empty session", () => {
    env = fixture()
    env.change("provider", "connected", [])
    const { result } = mount()
    expect(result.local?.model.current()).toBeUndefined()
    expect(result.providers?.chat()).toEqual([])
    env.change("provider", "connected", ["custom"])
    expect(result.local?.model.current()?.provider.id).toBe("custom")
    expect(result.providers?.chat().map((provider) => provider.id)).toEqual(["custom"])
    env.change("provider", "connected", [])
    expect(result.local?.model.current()).toBeUndefined()
  })

  test("a loaded empty project catalog does not borrow a global provider", () => {
    env = fixture()
    env.change("provider", { all: [], connected: [], default: {} })
    const { result } = mount()
    expect(result.local?.model.current()).toBeUndefined()
    expect(result.providers?.chat()).toEqual([])
  })

  test("waits for directory model metadata before using a seeded paid default", () => {
    env = fixture({ model: "opencode/paid" })
    env.change("modelReady", false)
    const { result } = mount()
    expect(result.providers?.ready()).toBe(false)
    expect(result.local?.model.current()).toBeUndefined()
    env.set("config", "model", "opencode/big-pickle")
    env.change("modelReady", true)
    expect(result.local?.model.current()).toBeUndefined()
    expect(result.local?.model.unavailable()).toBe(true)
  })

  test("unrelated directory bootstrap failures do not block loaded model metadata", () => {
    env = fixture({ scope: custom })
    env.change("status", "partial")
    const { result } = mount()
    expect(result.providers?.ready()).toBe(true)
    expect(result.local?.model.current()?.provider.id).toBe("custom")
  })

  test("project-disabled models do not count as usable or replace an explicit OpenCode selection", () => {
    env = fixture({ scope: paid })
    env.change("provider", "connected", ["opencode"])
    env.change("provider", "all", (item) => item.id === "opencode", "models", "paid", "disabled", true)
    const { result } = mount()
    expect(result.providers?.chat()).toEqual([])
    expect(result.local?.model.current()).toBeUndefined()
    expect(result.local?.model.unavailable()).toBe(true)
  })

  test("loaded project disabled settings hide its final chat model", () => {
    env = fixture({ scope: paid })
    env.change("provider", "connected", ["opencode"])
    env.change("config", "disabled_models", ["opencode/paid"])
    env.set("config", "disabled_models", ["opencode/paid"])
    const { result } = mount()
    expect(result.providers?.chat()).toEqual([])
    expect(result.local?.model.current()).toBeUndefined()
  })
})
