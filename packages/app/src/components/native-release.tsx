import { Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

function message(value: unknown): string {
  if (value instanceof Error) return value.message
  if (value && typeof value === "object" && "error" in value) return message(value.error)
  return String(value)
}

export function NativeRelease(props: { sessionID: string; valid: () => boolean }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore({ busy: false, done: false, error: "" })
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  async function release() {
    if (disposed || !props.valid() || state.busy || state.done) return
    const scope = `${sdk.url}\n${sdk.directory}\n${props.sessionID}`
    const valid = () => !disposed && props.valid() && scope === `${sdk.url}\n${sdk.directory}\n${props.sessionID}`
    setState({ busy: true, error: "" })
    await sdk.client.native
      .release({ sessionID: props.sessionID }, { throwOnError: true })
      .then(() => {
        if (valid()) setState("done", true)
      })
      .catch((error: unknown) => {
        if (valid()) setState("error", message(error))
      })
      .finally(() => {
        if (valid()) setState("busy", false)
      })
  }
  return (
    <Dialog title={language.t("native.slash.release")}>
      <div class="p-4 flex flex-col gap-3">
        <p class="text-12-regular text-text-weak">{language.t("native.release.description")}</p>
        <Show when={state.error}>
          <p role="alert" class="break-words">
            {state.error}
          </p>
        </Show>
        <Show
          when={state.done}
          fallback={
            <Button size="small" disabled={!props.valid() || state.busy} onClick={() => void release()}>
              {language.t(state.busy ? "common.loading" : "native.release.action")}
            </Button>
          }
        >
          <p role="status">{language.t("native.release.done")}</p>
        </Show>
      </div>
    </Dialog>
  )
}
