import type { NativeCodexStatus } from "@opencode-ai/sdk/v2"
import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

// A connection probe must not suspend the surrounding conversation while the
// executable starts. Keep the last catalog visible during background refreshes.
export function createNativeStatus(opts: {
  key: Accessor<string>
  enabled: Accessor<boolean>
  active: Accessor<boolean>
  read: (refresh: boolean) => Promise<NativeCodexStatus | undefined>
}) {
  const [store, setStore] = createStore<{
    key: string
    data?: NativeCodexStatus
    error?: unknown
    loading: boolean
    fresh: boolean
    expires: number
  }>({ key: "", loading: false, fresh: false, expires: 0 })
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  const current = () => opts.enabled() && store.key === opts.key()

  function load(refresh = false): Promise<void> {
    if (!opts.enabled()) return Promise.resolve()
    const key = opts.key()
    if (pending && store.key === key) return pending
    const run = ++epoch
    clearTimeout(timer)
    setStore({
      key,
      ...(store.key === key ? {} : { data: undefined }),
      loading: true,
      fresh: false,
      error: undefined,
    })
    pending = opts
      .read(refresh)
      .then((data) => {
        if (run !== epoch || !opts.enabled() || opts.key() !== key) return
        const good = !!data?.enabled && data.installed && data.connected && data.auth !== "missing" && !data.error
        setStore({ data, fresh: true, expires: Date.now() + (good ? 60_000 : 5_000) })
        timer = setTimeout(
          () => {
            if (run !== epoch) return
            setStore("fresh", false)
            if (good && opts.active()) void load()
          },
          good ? 60_000 : 5_000,
        )
      })
      .catch((error: unknown) => {
        if (run !== epoch || !opts.enabled() || opts.key() !== key) return
        setStore({ error, expires: Date.now() + 5_000 })
      })
      .finally(() => {
        if (run !== epoch) return
        pending = undefined
        setStore("loading", false)
      })
    return pending
  }

  const ensure = () => {
    if (current() && Date.now() < store.expires) return Promise.resolve()
    return load()
  }
  createEffect(
    on([opts.key, opts.enabled], () => {
      epoch++
      clearTimeout(timer)
      pending = undefined
      setStore({ key: "", data: undefined, error: undefined, loading: false, fresh: false, expires: 0 })
      if (opts.enabled()) void load()
    }),
  )
  createEffect(on(opts.active, (active) => active && void ensure()))
  onCleanup(() => {
    epoch++
    clearTimeout(timer)
  })
  return {
    data: () => (current() ? store.data : undefined),
    error: () => (current() ? store.error : undefined),
    loading: () => current() && store.loading,
    fresh: () => current() && store.fresh && !store.loading && !store.error,
    refresh: () => load(true),
  }
}
