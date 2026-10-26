import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { nativeEffort, nativeModel, type NativeEngine } from "@/utils/native"
import { createNativeStatus } from "./native-status"

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
  const enabled = createMemo(() => global.ready && global.data.config.native?.codex?.enabled !== false)
  const result = createNativeStatus({
    key: () => `${sdk.url}\n${sdk.directory}\n${global.data.config.native?.codex?.path ?? ""}`,
    enabled,
    active,
    read: (refresh) => sdk.client.native.status({ refresh }).then((response) => response.data),
  })
  const model = createMemo(() => nativeModel(result.data()?.models ?? [], engine()?.model))
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
    enabled,
    known: () => !params.id || !!sync.session.get(params.id),
    model,
    effort,
    status: result.data,
    error: result.error,
    loading: result.loading,
    refresh: result.refresh,
    locked: () => !!params.id,
    ready: () => {
      const status = result.data()
      // Discovery freshness is not the session connection's health. The
      // server validates the selected model again when dispatching a turn.
      return (
        enabled() &&
        active() &&
        !!status?.enabled &&
        status.installed &&
        status.connected &&
        status.auth !== "missing" &&
        !status.error &&
        !!model()
      )
    },
    select(value: "aether" | "codex") {
      if (params.id) return
      if (value === "codex" && !enabled()) return
      setStore("draft", value === "codex" ? { type: "codex" } : undefined)
    },
    setModel(value: string) {
      // Select can repeat its controlled value when an async catalog arrives.
      if (!engine() || value === model()?.id) return
      write({ type: "codex", model: value })
    },
    setEffort(value: string | undefined) {
      if (!engine()) return
      write({ type: "codex", model: model()?.id, effort: value })
    },
    selection(): NativeEngine | undefined {
      if (!enabled() || !engine() || !model()) return
      return { type: "codex", model: model()!.id, effort: effort() }
    },
  }
}
