import { expect, test } from "vitest"
import { createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { applyGlobalEvent } from "./event-reducer"
import { createProviderRefresh } from "./provider-refresh"
import { resolveModelVariant } from "../model-variant"

type Model = ProviderListResponse["all"][number]["models"][string]

function catalog(models: Record<string, Model>): ProviderListResponse {
  return { all: [{ id: "sample", name: "Sample", env: [], models }], connected: ["sample"], default: {} }
}

test.each(["provider.models.updated", "provider.updated"])("updates open model lists after %s", async (type) => {
  const old: Model = {
    id: "dynamic",
    name: "Old Name",
    release_date: "2026-09-15",
    attachment: false,
    reasoning: false,
    tool_call: true,
    limit: { context: 32_000, output: 1_000 },
    cost: { input: 1, output: 2 },
    modalities: { input: ["text"], output: ["text"] },
    variants: { low: {}, high: {} },
  }
  const fresh: Model = {
    ...old,
    name: "New Name",
    attachment: true,
    reasoning: true,
    limit: { context: 128_000, output: 8_000 },
    cost: { input: 2, output: 4 },
    modalities: { input: ["text", "image"], output: ["text"] },
    variants: { high: {}, max: {} },
  }
  const mounted = createRoot((dispose) => {
    const scopes = ["global", "project"].map((key) => {
      const [state, set] = createStore({
        provider: structuredClone(catalog({ dynamic: old, removed: { ...old, id: "removed" } })),
      })
      const list = useFilteredList({
        items: () => Object.values(state.provider.all[0]!.models),
        key: (model) => model.id,
        filterKeys: ["name", "id"],
      })
      return {
        list,
        target: {
          key,
          identity: state,
          current: () => state,
          load: async () =>
            structuredClone(
              catalog({
                dynamic: fresh,
                added: { ...fresh, id: "added" },
                deprecated: { ...fresh, id: "deprecated", status: "deprecated" },
              }),
            ),
          apply: (data: ProviderListResponse) => set("provider", reconcile(data)),
        },
      }
    })
    const refresh = createProviderRefresh({
      global: () => scopes[0]!.target,
      child: () => scopes[1]!.target,
      list: () => ["project"],
    })
    return { scopes, refresh, dispose }
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    mounted.scopes.forEach((scope) => expect(scope.list.flat()).toHaveLength(2))
    let pending: Promise<void> | undefined
    applyGlobalEvent({
      event: { type },
      project: [],
      setGlobalProject() {},
      refresh() {},
      providers: () => {
        pending = mounted.refresh.all()
      },
    })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    mounted.scopes.forEach((scope) => {
      expect(
        scope.list
          .flat()
          .map((model) => model.id)
          .sort(),
      ).toEqual(["added", "dynamic"])
      const model = scope.list.flat().find((model) => model.id === "dynamic")!
      expect(model.name).toBe("New Name")
      expect(model.limit.context).toBe(128_000)
      expect(model.limit.output).toBe(8_000)
      expect(model.cost?.input).toBe(2)
      expect(model.cost?.output).toBe(4)
      expect(model.reasoning).toBe(true)
      expect(model.modalities?.input).toEqual(["text", "image"])
      const variants = Object.keys(model.variants!)
      expect(variants).toEqual(["high", "max"])
      expect(resolveModelVariant({ variants, selected: "low", configured: undefined })).toBeUndefined()
      expect(resolveModelVariant({ variants, selected: "max", configured: undefined })).toBe("max")
      scope.list.onInput("New Name")
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    mounted.scopes.forEach((scope) => {
      expect(scope.list.flat()).toHaveLength(2)
      scope.list.onInput("Old Name")
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    mounted.scopes.forEach((scope) => expect(scope.list.flat()).toHaveLength(0))
  } finally {
    mounted.dispose()
  }
})
