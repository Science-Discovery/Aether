import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { isChatModel } from "@/utils/voice"
import { popularProviders, rank } from "@opencode-ai/util/provider"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

export { popularProviders, rank }
const popularProviderSet = new Set(popularProviders)

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.status === "complete" || projectStore.provider.all.length > 0) return projectStore.provider
    }
    return globalSync.data.provider
  }
  return {
    ready: () => {
      if (!globalSync.ready) return false
      if (!dir()) return true
      const [store] = globalSync.child(dir())
      return store.modelReady ?? store.status === "complete"
    },
    all: () => providers().all,
    default: () => providers().default,
    popular: () => providers().all.filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => connected.has(p.id))
    },
    chat: () => {
      const connected = new Set(providers().connected)
      const disabled = new Set([
        ...(globalSync.data.config.disabled_models ?? []),
        ...(dir() ? (globalSync.child(dir())[0].config.disabled_models ?? []) : []),
      ])
      return providers().all.filter(
        (p) =>
          connected.has(p.id) &&
          Object.values(p.models).some(
            (m) =>
              !("disabled" in m && m.disabled === true) &&
              isChatModel({ ...m, provider: p }) &&
              !disabled.has(`${p.id}/${m.id}`) &&
              !disabled.has(m.id),
          ),
      )
    },
  }
}
