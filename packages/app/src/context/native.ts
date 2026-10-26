import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { nativeEffort, nativeModel, type NativeEngine, type NativePermission } from "@/utils/native"
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
    saving: Record<string, boolean | undefined>
    errors: Record<string, string | undefined>
  }>({ picks: {}, saving: {}, errors: {} })
  const scope = () => `${sdk.url}\n${sdk.directory}\n${params.id ?? ""}`
  const engine = createMemo(() => {
    if (!params.id) return store.draft
    const saved = sync.session.get(params.id)?.engine
    if (!saved) return
    // Only model/effort may be unsent choices. Permission is persisted session
    // state and must follow external changes even while those choices exist.
    return { ...saved, ...store.picks[scope()], permission: saved.permission }
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
  const permission = createMemo(() => engine()?.permission ?? (params.id ? "user" : "auto"))
  const write = (value: NativeEngine) => {
    if (params.id) {
      if (!sync.session.get(params.id)?.engine) return
      setStore("picks", scope(), value)
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
    permission,
    saving: () => !!params.id && !!store.saving[scope()],
    permissionError: () => (params.id ? store.errors[scope()] : undefined),
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
        !(params.id && store.saving[scope()]) &&
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
      setStore("draft", value === "codex" ? { type: "codex", permission: "auto" } : undefined)
    },
    setModel(value: string) {
      // Select can repeat its controlled value when an async catalog arrives.
      if (!engine() || value === model()?.id) return
      write({ type: "codex", model: value, permission: permission() })
    },
    setEffort(value: string | undefined) {
      if (!engine()) return
      write({ type: "codex", model: model()?.id, effort: value, permission: permission() })
    },
    async setPermission(value: NativePermission) {
      const initial = engine()
      if (!initial || value === permission()) return
      const id = params.id
      if (!id) {
        write({ ...initial, permission: value })
        return
      }
      const key = scope()
      const server = sdk.url
      const directory = sdk.directory
      if (store.saving[key]) return
      setStore("saving", key, true)
      setStore("errors", key, undefined)
      await sdk.client.session
        .update({ sessionID: id, engine: { type: "codex", permission: value } })
        .then((response) => {
          if (response.data?.engine?.permission !== value)
            throw new Error(
              "The Aether server did not confirm the selected Codex permission. Update the server and try again.",
            )
          if (sdk.url !== server || sdk.directory !== directory) return
          const current = sync.session.get(id)
          if (!current?.engine || current.time.updated >= response.data.time.updated) return
          // Confirm the saved permission even when SSE is delayed, without
          // replacing newer events or the runtime's thread/cursor metadata.
          sync.set("session", (item) => item.id === id, {
            engine: { ...current.engine, permission: value },
            time: { ...current.time, updated: response.data.time.updated },
          })
        })
        .catch((error: unknown) => {
          setStore("errors", key, error instanceof Error ? error.message : String(error))
        })
        .finally(() => setStore("saving", key, false))
    },
    selection(): NativeEngine | undefined {
      if (!enabled() || !engine() || !model() || (params.id && store.saving[scope()])) return
      return { type: "codex", model: model()!.id, effort: effort(), permission: permission() }
    },
  }
}
