import { useParams } from "@solidjs/router"
import { createMemo, createEffect, on, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { EngineConfigOption, EngineInput, EngineModel, EngineStatus } from "@opencode-ai/sdk/v2"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

export type AcpID = EngineInput["type"]
export type AcpModel = { id: string; name: string; value: string }
type Pick = { model?: string; effort?: string; mode?: string }

export function createAcp() {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const [store, setStore] = createStore<{
    status: EngineStatus[]
    draft?: AcpID
    models?: EngineModel[]
    config?: EngineConfigOption[]
    pick: Pick
    loading: boolean
    loadingConfig: boolean
    error?: string
    configError?: string
  }>({ status: [], pick: {}, loading: false, loadingConfig: false })

  const refresh = async (force = false) => {
    if (store.loading) return
    setStore({ loading: true, error: undefined })
    await sdk.client.engine
      .list(force ? { refresh: true } : undefined)
      .then((response) => setStore("status", response.data ?? []))
      .catch((error: unknown) => setStore("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setStore("loading", false))
  }

  const loaded = new Map<string, number>()

  async function load(id: AcpID, model?: string) {
    const key = `${id}\n${model ?? ""}`
    const at = loaded.get(key)
    if (at && Date.now() - at < 30_000) return
    loaded.set(key, Date.now())
    setStore({ loadingConfig: true, configError: undefined })
    await sdk.client.engine
      .config({ id, ...(model ? { model } : {}) })
      .then((response) => {
        if (current() !== id) return
        const config = response.data?.config ?? []
        setStore("config", config)
        setStore("models", response.data?.models ?? [])
        if (response.data?.error) {
          loaded.delete(key)
          setStore("configError", response.data.error)
        }
        const effort = config.find(
          (item) => item.category === "thought_level" || item.id === "reasoning_effort",
        )
        if (store.pick.effort && !effort?.options?.some((item) => item.value === store.pick.effort))
          setStore("pick", "effort", undefined)
      })
      .catch((error: unknown) => {
        loaded.delete(key)
        setStore("configError", error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStore("loadingConfig", false))
  }

  onMount(() => void refresh())
  createEffect(
    on(
      () => store.draft,
      (id) => {
        if (!id || sdk.directory === undefined) return
        void load(id)
      },
    ),
  )

  const saved = createMemo(() => (params.id ? sync.session.get(params.id)?.acp : undefined))
  const current = createMemo<AcpID | undefined>(() => saved()?.type ?? store.draft)
  const config = createMemo<EngineConfigOption[]>(() => store.config ?? saved()?.config ?? [])
  const option = (category: string, id: string) =>
    config().find((item) => item.category === category || item.id === id)
  const models = createMemo<AcpModel[]>(() => {
    const list: EngineModel[] = saved()?.models?.length
      ? saved()!.models!
      : store.models?.length
        ? store.models
        : (option("model", "model")?.options?.map((item) => ({ id: item.value, name: item.name })) ?? [])
    return list.map((item) => ({ id: encodeURIComponent(item.id), name: item.name, value: item.id }))
  })
  const model = () => store.pick.model ?? saved()?.model ?? option("model", "model")?.value
  const effort = () => {
    const value = option("thought_level", "reasoning_effort")?.value
    if (store.pick.effort) return store.pick.effort
    if (store.pick.model) return value
    return saved()?.effort ?? value
  }
  const mode = () => store.pick.mode ?? saved()?.mode ?? option("mode", "mode")?.value
  const info = createMemo<EngineInput | undefined>(() => {
    const type = current()
    if (!type) return
    return {
      type,
      ...(model() ? { model: model() } : {}),
      ...(effort() ? { effort: effort() } : {}),
      ...(mode() ? { mode: mode() } : {}),
    }
  })
  const available = createMemo(() => store.status.filter((item) => item.installed))

  return {
    status: () => store.status,
    available,
    current,
    info,
    models,
    config,
    model,
    effort,
    mode,
    effortOptions: () => option("thought_level", "reasoning_effort")?.options ?? [],
    modeOptions: () => option("mode", "mode")?.options ?? [],
    loading: () => store.loading,
    loadingConfig: () => store.loadingConfig,
    error: () => store.error,
    configError: () => store.configError,
    refresh,
    known: () => !params.id || !!sync.session.get(params.id),
    locked: () => !!params.id,
    select(value: AcpID | undefined) {
      if (params.id) return
      setStore({ draft: value, pick: {}, config: undefined, models: undefined, configError: undefined })
    },
    setModel(value: string | undefined) {
      if (value === model()) return
      setStore("pick", "model", value)
      setStore("pick", "effort", undefined)
      const id = current()
      if (id) void load(id, value)
    },
    setEffort(value: string | undefined) {
      if (value === effort()) return
      setStore("pick", "effort", value)
    },
    setMode(value: string | undefined) {
      if (params.id || value === mode()) return
      setStore("pick", "mode", value)
    },
    name(value?: AcpID) {
      if (!value) return undefined
      return store.status.find((item) => item.id === value)?.name ?? value
    },
  }
}
