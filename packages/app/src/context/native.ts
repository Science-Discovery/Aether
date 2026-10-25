import { useParams } from "@solidjs/router"
import { createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { nativeEffort, nativeModel, type NativeEngine } from "@/utils/native"

// Engine identity belongs to the session. Unsent model choices stay local until
// the next turn persists them, and cannot change another session's engine.
export function createNative() {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const global = useGlobalSync()
  const [store, setStore] = createStore<{
    draft?: NativeEngine
    picks: Record<string, NativeEngine | undefined>
  }>({ picks: {} })
  const engine = createMemo(() => {
    if (!params.id) return store.draft
    const saved = sync.session.get(params.id)?.engine
    if (!saved) return
    return store.picks[params.id] ?? saved
  })
  const active = createMemo(() => !!engine())
  const [result, actions] = createResource(
    () => active() && `${sdk.url}\n${sdk.directory}\n${global.data.config.native?.codex?.path ?? ""}`,
    async () =>
      sdk.client.native
        .status()
        .then((response) => ({ data: response.data, error: undefined }))
        .catch((error: unknown) => ({ data: undefined, error })),
  )
  const model = createMemo(() => nativeModel(result()?.data?.models ?? [], engine()?.model))
  const effort = createMemo(() => nativeEffort(model(), engine()?.effort))
  const write = (value: NativeEngine) => {
    if (params.id) {
      if (!sync.session.get(params.id)?.engine) return
      setStore("picks", params.id, value)
      return
    }
    setStore("draft", value)
  }
  return {
    engine,
    known: () => !params.id || !!sync.session.get(params.id),
    model,
    effort,
    status: () => result()?.data,
    error: () => result()?.error,
    loading: () => result.loading,
    refresh: () => actions.refetch(),
    locked: () => !!params.id,
    ready: () => {
      const status = result()?.data
      return (
        active() && !result.loading && !!status?.installed && status.connected && status.auth !== "missing" && !!model()
      )
    },
    select(value: "aether" | "codex") {
      if (params.id) return
      setStore("draft", value === "codex" ? { type: "codex" } : undefined)
    },
    setModel(value: string) {
      if (!engine()) return
      write({ type: "codex", model: value })
    },
    setEffort(value: string | undefined) {
      if (!engine()) return
      write({ type: "codex", model: model()?.id, effort: value })
    },
    selection(): NativeEngine | undefined {
      if (!engine() || !model()) return
      return { type: "codex", model: model()!.id, effort: effort() }
    },
  }
}
