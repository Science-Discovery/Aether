import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { useGlobalSync } from "@/context/global-sync"
import { Persist, persisted } from "@/utils/persist"
import { uniqueBy } from "remeda"

export type ModelKey = { providerID: string; modelID: string }

type User = ModelKey & { favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

function disabledModelID(model: ModelKey) {
  return `${model.providerID}/${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()
    const globalSync = useGlobalSync()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const disabledModelsSet = createMemo(() => {
      const list = globalSync.data.config.disabled_models ?? []
      return new Set(list)
    })

    const favoritesSet = createMemo(() => {
      const map = new Map<string, boolean>()
      for (const item of store.user) {
        if (item.favorite) map.set(`${item.providerID}:${item.modelID}`, true)
      }
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    const visible = (model: ModelKey) => {
      const id = disabledModelID(model)
      return !disabledModelsSet().has(id) && !disabledModelsSet().has(model.modelID)
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      const id = disabledModelID(model)
      const before = globalSync.data.config.disabled_models ?? []
      const isCurrentlyDisabled = before.includes(id) || before.includes(model.modelID)
      if (state && !isCurrentlyDisabled) return
      if (!state && isCurrentlyDisabled) return
      if (state) {
        const next = before.filter((x) => x !== id && x !== model.modelID)
        globalSync.set("config", "disabled_models", next)
        globalSync.updateConfig({ disabled_models: next }).catch((err: unknown) => {
          globalSync.set("config", "disabled_models", before)
          console.error("Failed to enable model", err)
        })
      } else {
        const next = [...before, id]
        globalSync.set("config", "disabled_models", next)
        globalSync.updateConfig({ disabled_models: next }).catch((err: unknown) => {
          globalSync.set("config", "disabled_models", before)
          console.error("Failed to disable model", err)
        })
      }
    }

    const toggleFavorite = (model: ModelKey, state: boolean) => {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, favorite: state }))
        return
      }
      setStore("user", store.user.length, { ...model, favorite: state })
    }

    const isFavorite = (model: ModelKey) => favoritesSet().get(modelKey(model)) ?? false

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.length = RECENT_LIMIT
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      isFavorite,
      toggleFavorite,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
