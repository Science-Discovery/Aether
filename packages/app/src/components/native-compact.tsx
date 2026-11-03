import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeCompactStatus } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"

function message(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "object" && value !== null && "error" in value) return message(value.error)
  return String(value)
}

export function NativeCompact(props: { sessionID: string; onComplete?: () => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore<{
    data?: NativeCompactStatus | null
    busy: boolean
    checking: boolean
    error?: string
  }>({ busy: false, checking: false })
  const key = () => `${sdk.url}\n${sdk.directory}\n${props.sessionID}`
  const [attempts, setAttempts, , ready] = persisted(
    Persist.global("native-compaction-attempts.v1"),
    createStore<Record<string, string | undefined>>({}),
  )
  let revision = 0
  let disposed = false
  const pending = () => state.busy || state.data?.state === "pending" || state.data?.state === "uncertain"
  const label = () =>
    state.data?.state === "complete"
      ? "native.compact.complete"
      : state.data?.state === "failed"
        ? "native.compact.failed"
        : state.data?.state === "uncertain"
          ? "native.compact.uncertain"
          : "native.compact.pending"
  async function refresh(force = false) {
    const scope = key()
    const stamp = revision
    const operation = attempts[scope]
    setState({ checking: true, error: undefined })
    await sdk.client.native
      .compactStatus({ sessionID: props.sessionID, refresh: force, operationId: operation }, { throwOnError: true })
      .then((result) => {
        if (disposed || revision !== stamp || key() !== scope) return
        if (operation && attempts[scope] !== operation) return
        setState({ data: result.data, error: result.data?.error })
        if (result.data?.state === "complete" || result.data?.state === "failed") setAttempts(scope, undefined)
        if (result.data?.state === "complete") props.onComplete?.()
      })
      .catch((error: unknown) => {
        if (!disposed && revision === stamp && key() === scope) setState("error", message(error))
      })
      .finally(() => {
        if (!disposed && revision === stamp && key() === scope) setState("checking", false)
      })
  }
  async function start() {
    if (!ready() || pending() || state.checking) return
    const scope = key()
    const stamp = revision
    const id = attempts[scope] ?? crypto.randomUUID()
    setAttempts(scope, id)
    setState({ busy: true, error: undefined })
    await sdk.client.native
      .compact({ sessionID: props.sessionID, id }, { throwOnError: true })
      .then((result) => {
        if (disposed || revision !== stamp || key() !== scope) return
        setState({ data: result.data, error: result.data?.error })
        if (result.data?.state === "complete" || result.data?.state === "failed") setAttempts(scope, undefined)
        if (result.data?.state === "complete") props.onComplete?.()
      })
      .catch(async (error: unknown) => {
        if (disposed || revision !== stamp || key() !== scope) return
        await refresh()
        if (!disposed && revision === stamp && key() === scope && !state.data?.error) setState("error", message(error))
      })
      .finally(() => {
        if (!disposed && revision === stamp && key() === scope) setState("busy", false)
      })
  }
  createEffect(
    on(
      () => `${key()}\n${ready()}`,
      () => {
        revision++
        setState({ data: undefined, error: undefined, busy: false, checking: false })
        if (ready()) void refresh()
      },
    ),
  )
  onCleanup(() => {
    disposed = true
    revision++
  })
  return (
    <Dialog title={language.t("native.slash.compact")}>
      <div class="p-4 flex flex-col gap-3">
        <p class="text-12-regular text-text-weak">{language.t("native.compact.description")}</p>
        <Show when={state.busy || state.data}>
          <p role="status">{language.t(state.busy ? "native.compact.pending" : label())}</p>
        </Show>
        <Show when={state.error}>
          {(error) => (
            <p role="alert" class="break-words">
              {error()}
            </p>
          )}
        </Show>
        <div class="flex gap-2">
          <Button size="small" disabled={!ready() || pending() || state.checking} onClick={() => void start()}>
            {language.t(attempts[key()] ? "native.compact.retry" : "native.compact.start")}
          </Button>
          <Button size="small" variant="secondary" disabled={state.checking} onClick={() => void refresh(true)}>
            {language.t(state.checking ? "common.loading" : "native.compact.check")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
