import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useMaybeConversationQuote } from "@/context/conversation-quote"
import { useMaybeFileQuote } from "@/context/file-quote"
import { useMaybeQuickReadingMode } from "@/context/quick-reading-mode"
import { useMaybeReadingMode } from "@/context/reading-mode"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { extractPromptFromParts, skill } from "@/utils/prompt"
import { formatServerError } from "@/utils/server-errors"

export function useNativeRevert() {
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()
  const quote = useMaybeConversationQuote()
  const file = useMaybeFileQuote()
  const quick = useMaybeQuickReadingMode()
  const reading = useMaybeReadingMode()
  type Status = NonNullable<Awaited<ReturnType<typeof sdk.client.native.revertStatus>>["data"]>
  const [state, setState] = createStore<{
    key: string
    ready: boolean
    busy: boolean
    record?: Status
    error?: string
  }>({ key: "", ready: false, busy: false })
  let epoch = 0
  let disposed = false
  const seen = new Map<string, string>()
  const source = () => sync.data.session.find((item) => item.id === params.id)
  const enabled = createMemo(() => source()?.engine?.type === "codex")
  // History refresh replaces the session object. Only a changed identity should
  // restart recovery, or an applied revert will keep refreshing itself.
  const key = createMemo(() => `${sdk.url}\n${sdk.directory}\n${params.id ?? ""}\n${source()?.engine?.thread ?? ""}`)
  const valid = (stamp: number, scope: string) => !disposed && epoch === stamp && scope === key()
  const blocked = () =>
    enabled() &&
    (state.key !== key() || !state.ready || state.busy || (!!state.record && state.record.state !== "applied"))
  const fail = (err: unknown) =>
    showToast({ title: language.t("common.requestFailed"), description: formatServerError(err, language.t) })
  const occupied = () =>
    prompt.dirty() ||
    prompt.context.items().length > 0 ||
    !!quote?.store.pendingQuestions.some((item) => item.sessionID === params.id) ||
    file?.store.question?.sessionID === params.id ||
    quick?.store.pendingQuestion?.sessionID === params.id ||
    !!reading?.store.pendingQuestion

  async function history(id: string, scope: string, stamp: number, operation: string) {
    if (!valid(stamp, scope) || seen.get(scope) === operation) return
    sync.session.invalidate(id)
    await sync.session.sync(id, { force: true })
    if (!valid(stamp, scope)) return
    seen.set(scope, operation)
    if (seen.size > 32) seen.delete(seen.keys().next().value!)
  }

  async function read(id: string, scope: string, stamp: number) {
    const result = await sdk.client.native.revertStatus({ sessionID: id }, { throwOnError: true })
    if (!valid(stamp, scope)) return
    if (result.data === undefined) throw new Error(language.t("common.requestFailed"))
    setState({ record: result.data ?? undefined, ready: true, error: result.data?.error })
    if (result.data?.state === "applied") await history(id, scope, stamp, result.data.id)
  }

  async function refresh() {
    const id = params.id
    if (!id || !enabled() || disposed || state.busy) return
    const scope = key()
    const stamp = ++epoch
    setState({ key: scope, busy: true, error: undefined })
    await read(id, scope, stamp)
      .catch((err: unknown) => {
        if (valid(stamp, scope)) setState({ ready: false, error: formatServerError(err, language.t) })
      })
      .finally(() => {
        if (valid(stamp, scope)) setState("busy", false)
      })
  }

  async function commit(id: string, operation: string) {
    if (state.busy || disposed || id !== params.id) return
    const scope = key()
    const stamp = ++epoch
    setState({ key: scope, busy: true, error: undefined })
    await sdk.client.native
      .revert({ sessionID: id, id: operation }, { throwOnError: true })
      .then(async (result) => {
        if (!valid(stamp, scope)) return
        if (!result.data) throw new Error(language.t("common.requestFailed"))
        await read(id, scope, stamp)
      })
      .catch(async (err: unknown) => {
        if (!valid(stamp, scope)) return
        fail(err)
        await read(id, scope, stamp).catch((error: unknown) => {
          if (valid(stamp, scope)) setState({ ready: false, error: formatServerError(error, language.t) })
        })
      })
      .finally(() => {
        if (valid(stamp, scope)) setState("busy", false)
      })
  }

  const check = () => {
    const record = state.record
    if (record && record.state !== "applied") return commit(record.sessionID, record.id)
    return refresh()
  }

  createEffect(
    on([key, enabled], () => {
      epoch++
      setState({ key: key(), ready: false, busy: false, record: undefined, error: undefined })
      if (enabled()) void refresh()
    }),
  )
  onCleanup(() => {
    disposed = true
    epoch++
  })

  async function edit(input: { sessionID: string; messageID: string }) {
    const session = source()
    if (!session || session.id !== input.sessionID || !enabled() || blocked() || disposed) return
    if (!prompt.ready() || occupied()) {
      showToast({ title: language.t("native.revert.draft") })
      return
    }
    const parts = sync.data.part[input.messageID] ?? []
    const message = sync.data.message[input.sessionID]?.find((item) => item.id === input.messageID)
    if (message?.role !== "user" || !parts.length) {
      showToast({ title: language.t("native.fork.loading") })
      return
    }
    const value = extractPromptFromParts(parts, {
      directory: session.directory,
      attachmentName: language.t("common.attachment"),
    })
    if (
      value.some((part) => part.type === "image") ||
      parts.some((part) => part.type === "text" && /^\s*<send_user_message_question_reply>/.test(part.text)) ||
      parts.some(
        (part) => part.type === "text" && part.text.trim() && (part.ignored || part.synthetic) && !skill(part),
      ) ||
      parts
        .flatMap((part) => (skill(part) ? [skill(part)!] : []))
        .some(
          (item) => !value.some((part) => part.type === "skill" && part.name === item.name && part.path === item.path),
        ) ||
      parts.filter((part) => part.type === "text" && part.text.trim() && !part.ignored && !part.synthetic).length > 1 ||
      parts.filter((part) => part.type === "file").length !==
        value.filter((part) => part.type === "file" || part.type === "image").length
    ) {
      showToast({ title: language.t("native.revert.unsupported") })
      return
    }
    const scope = key()
    const stamp = ++epoch
    const fingerprint = JSON.stringify(parts)
    setState({ busy: true, error: undefined })
    await sdk.client.native
      .prepareRevert(input, { throwOnError: true })
      .then((result) => {
        if (!valid(stamp, scope)) return
        const prepared = result.data
        if (!prepared) throw new Error(language.t("common.requestFailed"))
        dialog.show(() => (
          <Dialog title={language.t("native.revert.title")} fit>
            <div class="flex flex-col gap-4 p-4">
              <p class="text-sm text-text-base">{language.t("native.revert.description", { count: prepared.turns })}</p>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
                <Button
                  onClick={() => {
                    dialog.close()
                    if (!valid(stamp, scope) || state.busy) return
                    if (
                      !prompt.ready() ||
                      occupied() ||
                      JSON.stringify(sync.data.part[input.messageID]) !== fingerprint
                    ) {
                      showToast({ title: language.t("native.revert.changed") })
                      return
                    }
                    prompt.set(value, undefined, { dir: base64Encode(session.directory), id: session.id })
                    void commit(session.id, prepared.id)
                  }}
                >
                  {language.t("native.revert.confirm")}
                </Button>
              </div>
            </div>
          </Dialog>
        ))
      })
      .catch((err: unknown) => {
        if (valid(stamp, scope)) fail(err)
      })
      .finally(() => {
        if (valid(stamp, scope)) setState("busy", false)
      })
  }

  return {
    edit,
    check,
    blocked,
    busy: () => state.busy,
    notice: () =>
      enabled() && state.key === key() && (!!state.error || (!!state.record && state.record.state !== "applied")),
    error: () => state.error,
  }
}

export function NativeRevertNotice(props: { revert: ReturnType<typeof useNativeRevert> }) {
  const language = useLanguage()
  return (
    <Show when={props.revert.notice()}>
      <div
        class="flex flex-wrap items-center gap-2 px-3 py-1 text-12-regular text-text-weak"
        role="status"
        data-component="native-revert"
      >
        <span>{language.t("native.revert.unconfirmed")}</span>
        <Button size="small" variant="ghost" disabled={props.revert.busy()} onClick={() => void props.revert.check()}>
          {language.t("native.revert.check")}
        </Button>
        <Show when={props.revert.error()}>{(error) => <span class="w-full break-words">{error()}</span>}</Show>
      </div>
    </Show>
  )
}
