import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

export function NativeHistoryControl() {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const native = useLocal().native
  const language = useLanguage()
  const [state, setState] = createStore({ loading: false, status: "pending", error: "" })
  let revision = 0
  const key = () => `${sdk.url}\n${sdk.directory}\n${params.id ?? ""}`
  const running = () => !!params.id && (sync.data.session_status[params.id]?.type ?? "idle") !== "idle"
  const thread = () => (params.id ? sync.session.get(params.id)?.engine?.thread : undefined)

  async function refresh(force = false) {
    const id = params.id
    if (!id || !thread() || !native.enabled() || running() || state.loading) return
    const current = key()
    const sequence = ++revision
    const client = sdk.client
    setState({ loading: true, error: "" })
    await client.native
      .history({ sessionID: id, refresh: force })
      .then(async (response) => {
        if (current !== key() || sequence !== revision) return
        const result = response.data
        setState({ status: result?.state ?? "unavailable", error: result?.error ?? "" })
        // The server publishes the cache transaction through normal message
        // events. A forced reload here can race with the next streaming turn.
      })
      .catch((error: unknown) => {
        if (current !== key() || sequence !== revision) return
        setState({ status: "unavailable", error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        if (current === key() && sequence === revision) setState("loading", false)
      })
  }

  createEffect(
    on([key, thread, running, () => native.enabled()], () => {
      revision++
      setState({ loading: false, status: "pending", error: "" })
      void refresh()
    }),
  )

  const focus = () => void refresh()
  window.addEventListener("focus", focus)
  onCleanup(() => {
    revision++
    window.removeEventListener("focus", focus)
  })

  const label = () => language.t(state.loading ? "native.history.syncing" : "native.history.refresh")
  const error = () => (state.status === "partial" ? "" : state.error)
  return (
    <Show when={params.id && thread()}>
      <IconButton
        icon="refresh"
        variant="ghost"
        size="small"
        disabled={state.loading || running() || !native.enabled()}
        onClick={() => void refresh(true)}
        aria-label={label()}
        aria-busy={state.loading}
        data-action="prompt-native-history"
        title={error() || label()}
      />
      <Show when={error()}>
        <span role="status" class="max-w-[240px] truncate text-12-regular text-text-weak" title={error()}>
          {language.t("native.history.unavailable")}
        </span>
      </Show>
    </Show>
  )
}
