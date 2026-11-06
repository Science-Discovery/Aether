import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

export function SessionDetach(props: { session?: Session; context?: boolean }) {
  const sdk = useGlobalSDK()
  const global = useGlobalSync()
  const language = useLanguage()
  const [state, setState] = createStore({ pending: false })

  const detach = () => {
    const session = props.session
    if (state.pending || !session?.parentID || !session.forkParentSessionID || session.time.archived) return
    const dir = session.directory
    setState("pending", true)
    void sdk
      .createClient({ directory: dir, throwOnError: true })
      .session.detach({ sessionID: session.id })
      .then((result) => {
        if (!result.data) throw new Error(language.t("common.requestFailed"))
        global.session.update(result.data)
        return global.project.loadSessions(dir, { force: true }).catch((err: unknown) => {
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
      <Dynamic
        component={props.context ? ContextMenu.Item : DropdownMenu.Item}
        data-action="session-detach"
        disabled={state.pending}
        onSelect={detach}
      >
        <Dynamic component={props.context ? ContextMenu.ItemLabel : DropdownMenu.ItemLabel}>
          {language.t(props.context ? "session.branch.detach" : "session.detach.action")}
        </Dynamic>
      </Dynamic>
    </Show>
  )
}
