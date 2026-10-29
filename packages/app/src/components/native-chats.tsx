import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeChat, NativeChatPage, Session } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

function message(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "object" && value !== null && "error" in value) return message(value.error)
  return String(value)
}

export function NativeChats(props: { onSelect: (session: Session) => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore<{
    query: string
    filter: string
    data?: NativeChatPage
    busy: boolean
    pending?: string
    error?: string
  }>({ query: "", filter: "", busy: false })
  let revision = 0
  let disposed = false
  const key = () => `${sdk.url}\n${sdk.directory}`

  async function load(more = false) {
    if (state.pending) return
    const scope = key()
    const stamp = ++revision
    const before = more ? state.data : undefined
    const search = more ? state.filter : state.query.trim()
    setState({ busy: true, error: undefined, filter: search, ...(!more ? { data: undefined } : {}) })
    await sdk.client.native
      .chats({ search, cursor: before?.cursor, scope: before?.scope }, { throwOnError: true })
      .then((result) => {
        if (disposed || stamp !== revision || scope !== key()) return
        if (!result.data) throw new Error(language.t("native.chats.unavailable"))
        if (before && before.scope !== result.data.scope) throw new Error(language.t("native.chats.changed"))
        const chats = new Map([...(before?.chats ?? []), ...result.data.chats].map((chat) => [chat.id, chat]))
        setState("data", { ...result.data, chats: [...chats.values()] })
      })
      .catch((err: unknown) => {
        if (!disposed && stamp === revision && scope === key()) setState("error", message(err))
      })
      .finally(() => {
        if (!disposed && stamp === revision && scope === key()) setState("busy", false)
      })
  }

  async function attach(chat: NativeChat) {
    if (state.busy || state.pending || !state.data) return
    const scope = key()
    const stamp = ++revision
    setState({ pending: chat.id, error: undefined })
    await sdk.client.native
      .attachChat({ threadID: chat.id, scope: state.data.scope }, { throwOnError: true })
      .then((result) => {
        if (disposed || stamp !== revision || scope !== key()) return
        if (!result.data) throw new Error(language.t("native.chats.unavailable"))
        props.onSelect(result.data)
        dialog.close()
      })
      .catch((err: unknown) => {
        if (!disposed && stamp === revision && scope === key()) setState("error", message(err))
      })
      .finally(() => {
        if (!disposed && stamp === revision && scope === key()) setState("pending", undefined)
      })
  }

  createEffect(
    on(key, () => {
      setState({ query: "", filter: "", pending: undefined, data: undefined })
      void load()
    }),
  )
  onCleanup(() => {
    disposed = true
    revision++
  })
  return (
    <Dialog title={language.t("native.slash.resume")}>
      <div class="p-4 flex flex-col gap-3 max-h-[70vh] overflow-y-auto">
        <p class="text-12-regular text-text-weak">{language.t("native.chats.description")}</p>
        <form
          class="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void load()
          }}
        >
          <input
            class="flex-1 min-w-0 rounded-md border border-border-base bg-background-base px-3 py-2"
            value={state.query}
            placeholder={language.t("common.search.placeholder")}
            aria-label={language.t("common.search.placeholder")}
            disabled={!!state.pending}
            onInput={(event) => setState("query", event.currentTarget.value)}
          />
          <Button type="submit" size="small" variant="secondary" disabled={state.busy || !!state.pending}>
            {language.t(state.busy ? "common.loading" : "native.chats.search")}
          </Button>
        </form>
        <Show when={state.error}>
          {(error) => (
            <div role="alert" class="text-12-regular break-words">
              {error()}
            </div>
          )}
        </Show>
        <Show when={!state.busy && !state.error && !state.data?.chats.length}>
          <div class="text-12-regular text-text-weak">{language.t("native.chats.empty")}</div>
        </Show>
        <For each={state.data?.chats}>
          {(chat) => (
            <div class="flex items-center gap-3 rounded-md border border-border-base p-3">
              <div class="flex-1 min-w-0">
                <div class="truncate" title={chat.title}>
                  {chat.title}
                </div>
                <div class="text-12-regular text-text-weak">{new Date(chat.updated).toLocaleString()}</div>
                <Show when={!chat.sessionID && !["idle", "notLoaded"].includes(chat.state)}>
                  <div class="text-12-regular text-text-weak">{language.t("native.chats.wait")}</div>
                </Show>
              </div>
              <Button
                size="small"
                variant="secondary"
                disabled={
                  state.busy || !!state.pending || (!chat.sessionID && !["idle", "notLoaded"].includes(chat.state))
                }
                onClick={() => void attach(chat)}
              >
                {language.t(
                  state.pending === chat.id
                    ? "common.loading"
                    : chat.sessionID
                      ? "native.chats.open"
                      : "native.chats.attach",
                )}
              </Button>
            </div>
          )}
        </For>
        <Show when={state.data?.cursor}>
          <Button
            size="small"
            variant="secondary"
            disabled={state.busy || !!state.pending}
            onClick={() => void load(true)}
          >
            {language.t(state.busy ? "common.loading" : "native.chats.more")}
          </Button>
        </Show>
      </div>
    </Dialog>
  )
}
