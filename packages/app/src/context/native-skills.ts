import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeCodexSkills } from "@opencode-ai/sdk/v2"

export function createNativeSkills(input: {
  key: () => string
  active: () => boolean
  read: (refresh: boolean) => Promise<NativeCodexSkills | undefined>
}) {
  const [store, setStore] = createStore<{ data?: NativeCodexSkills; loading: boolean; error?: string }>({
    loading: false,
  })
  let revision = 0
  let disposed = false
  const key = createMemo(input.key)
  const active = createMemo(input.active)
  async function refresh(force = true) {
    const scope = key()
    if (!scope || disposed || (store.loading && !force)) return
    const version = ++revision
    setStore({ loading: true, error: undefined })
    await input
      .read(force)
      .then((data) => {
        if (disposed || version !== revision || scope !== key()) return
        if (!data) throw new Error("Codex did not return a skills catalog.")
        setStore({ data, error: data.error })
      })
      .catch((err: unknown) => {
        if (disposed || version !== revision || scope !== key()) return
        setStore({ data: undefined, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        if (!disposed && version === revision && scope === key()) setStore("loading", false)
      })
  }
  createEffect(
    on(key, () => {
      revision++
      setStore({ data: undefined, loading: false, error: undefined })
      if (active()) void refresh(false)
    }),
  )
  createEffect(
    on(active, (value) => {
      if (value && !store.data && !store.loading) void refresh(false)
    }),
  )
  onCleanup(() => {
    disposed = true
    revision++
  })
  return { data: () => store.data, loading: () => store.loading, error: () => store.error, refresh }
}
