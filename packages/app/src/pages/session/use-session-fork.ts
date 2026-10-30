import { createEffect, on, onCleanup } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { extractPromptFromParts } from "@/utils/prompt"
import { formatServerError } from "@/utils/server-errors"

export function useSessionFork() {
  const sdk = useSDK()
  const sync = useSync()
  const prompt = usePrompt()
  const language = useLanguage()
  const params = useParams()
  const navigate = useNavigate()
  let busy = false
  let disposed = false
  let revision = 0
  createEffect(
    on(
      () => [sdk.url, sdk.directory, params.id],
      () => revision++,
    ),
  )
  onCleanup(() => (disposed = true))

  return async (input: { sessionID: string; messageID: string }, mode: "fork" | "edit", done?: () => void) => {
    if (busy || disposed) return
    const scope = `${sdk.url}\n${sdk.directory}\n${params.id}`
    const stamp = revision
    const source = sync.data.session.find((item) => item.id === input.sessionID)
    if (!source) {
      showToast({ title: language.t("native.fork.loading") })
      return
    }
    const native = source?.engine?.type === "codex"
    const parts = sync.data.part[input.messageID] ?? []
    if (
      native &&
      mode === "edit" &&
      parts.some((part) => part.type === "text" && /^\s*<send_user_message_question_reply>/.test(part.text))
    ) {
      showToast({ title: language.t("native.fork.questionReply") })
      return
    }
    const restore = !native || mode === "edit"
    const value = restore
      ? extractPromptFromParts(parts, {
          directory: source?.directory ?? sdk.directory,
          attachmentName: language.t("common.attachment"),
        })
      : undefined
    if (
      native &&
      mode === "edit" &&
      value &&
      (parts.some((part) => part.type === "text" && part.text.trim() && (part.ignored || part.synthetic)) ||
        parts.filter((part) => part.type === "text" && part.text.trim() && !part.ignored && !part.synthetic).length >
          1 ||
        parts.filter((part) => part.type === "file").length !==
          value.filter((part) => part.type === "file" || part.type === "image").length)
    ) {
      showToast({ title: language.t("native.fork.unsupportedDraft") })
      return
    }
    busy = true
    await sdk.client.session
      .fork({ ...input, ...(native ? { after: !restore } : {}) }, { throwOnError: true })
      .then((result) => {
        if (disposed || stamp !== revision || scope !== `${sdk.url}\n${sdk.directory}\n${params.id}`) return
        const next = result.data
        if (!next) throw new Error(language.t("common.requestFailed"))
        const dir = base64Encode(next.directory)
        if (next.directory === sdk.directory)
          sync.set("session", (items) =>
            [...items.filter((item) => item.id !== next.id), next].sort((a, b) =>
              a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
            ),
          )
        if (value) prompt.set(value, undefined, { dir, id: next.id })
        done?.()
        if (native && !restore) {
          navigate(`/${dir}/session/${next.id}`, { state: { nativeFork: next.id } })
          return
        }
        navigate(`/${dir}/session/${next.id}`)
      })
      .catch((err: unknown) => {
        if (disposed || stamp !== revision || scope !== `${sdk.url}\n${sdk.directory}\n${params.id}`) return
        showToast({ title: language.t("common.requestFailed"), description: formatServerError(err, language.t) })
      })
      .finally(() => (busy = false))
  }
}
