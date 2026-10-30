import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Message, ToolPart } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

export function NativeImage(props: { part: ToolPart; message: Message }) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const eligible = () =>
    props.message.role === "assistant" &&
    props.part.state.status === "completed" &&
    ["codex.imageView", "codex.imageGeneration"].includes(props.part.tool)
  const key = createMemo(() =>
    eligible()
      ? `${sdk.url}\n${sdk.directory}\n${props.part.sessionID}\n${props.part.messageID}\n${props.part.id}`
      : "",
  )
  const [store, setStore] = createStore<{ url?: string; name?: string; error?: string; busy: boolean }>({ busy: false })
  let revision = 0
  let disposed = false
  async function load() {
    const scope = key()
    if (!scope) return
    const request = ++revision
    setStore({ url: undefined, name: undefined, error: undefined, busy: true })
    const valid = () => !disposed && request === revision && scope === key()
    await sdk.client.native
      .image({ sessionID: props.part.sessionID, messageID: props.part.messageID, partID: props.part.id })
      .then((result) => {
        if (!valid()) return
        if (!result.data) throw new Error(language.t("native.image.unavailable"))
        setStore({ ...result.data, busy: false })
      })
      .catch((error) => {
        if (valid()) setStore({ error: formatServerError(error, language.t), busy: false })
      })
  }
  createEffect(() => {
    key()
    revision++
    setStore({ url: undefined, name: undefined, error: undefined, busy: false })
    void load()
  })
  onCleanup(() => {
    disposed = true
    revision++
  })
  return (
    <Show when={eligible()}>
      <div class="mt-2 mb-3" data-component="native-image">
        <Show when={store.url}>
          {(url) => (
            <button
              type="button"
              class="block cursor-zoom-in max-w-full"
              aria-label={store.name || language.t("native.image.preview")}
              onClick={() => dialog.show(() => <ImagePreview src={url()} alt={store.name} />)}
            >
              <img
                src={url()}
                alt={store.name || language.t("native.image.preview")}
                class="block max-h-96 max-w-full rounded-md object-contain"
                onError={() => setStore({ url: undefined, error: language.t("native.image.unavailable") })}
              />
            </button>
          )}
        </Show>
        <Show when={store.error}>
          <div class="flex flex-wrap items-center gap-2 text-12-regular text-text-weak">
            <span>{language.t("native.image.unavailable")}</span>
            <Button size="small" variant="ghost" disabled={store.busy} title={store.error} onClick={() => void load()}>
              {language.t("native.image.retry")}
            </Button>
          </div>
        </Show>
      </div>
    </Show>
  )
}
