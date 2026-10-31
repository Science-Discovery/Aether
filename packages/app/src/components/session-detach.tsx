import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { formatServerError } from "@/utils/server-errors"

export function SessionDetach(props: { session?: Session }) {
  const sdk = useSDK()
  const sync = useSync()
  const global = useGlobalSync()
  const language = useLanguage()
  const [state, setState] = createStore({ pending: false })

  const detach = () => {
    const session = props.session
    if (state.pending || !session?.parentID || !session.forkParentSessionID || session.time.archived) return
    setState("pending", true)
    void sdk.client.session
      .detach({ sessionID: session.id })
      .then((result) => {
        if (!result.data) throw new Error(language.t("common.requestFailed"))
        sync.session.update(result.data)
        return global.project.loadSessions(session.directory, { force: true }).catch((err: unknown) => {
          showToast({
            variant: "error",
            title: language.t("session.detach.refreshFailed.title"),
            description: formatServerError(err, language.t),
          })
        })
      })
      .catch((err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("session.detach.failed.title"),
          description: formatServerError(err, language.t),
        })
      })
      .finally(() => setState("pending", false))
  }

  return (
    <Show when={props.session?.parentID && props.session.forkParentSessionID && !props.session.time.archived}>
      <DropdownMenu.Item data-action="session-detach" disabled={state.pending} onSelect={detach}>
        <DropdownMenu.ItemLabel>{language.t("session.detach.action")}</DropdownMenu.ItemLabel>
      </DropdownMenu.Item>
    </Show>
  )
}
