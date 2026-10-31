import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { SessionDetach } from "@/components/session-detach"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

function Delete(props: { session: Session; remove: (session: Session) => Promise<boolean | void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ pending: false })
  const remove = () => {
    if (state.pending) return
    setState("pending", true)
    void props
      .remove(props.session)
      .then((result) => {
        if (result !== false) dialog.close()
      })
      .catch((err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("session.delete.failed.title"),
          description: formatServerError(err, language.t),
        })
      })
      .finally(() => setState("pending", false))
  }
  return (
    <Dialog title={language.t("session.branch.delete")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-14-regular text-text-strong">
          {language.t("session.branch.delete.confirm", { name: props.session.title })}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" disabled={state.pending} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            data-action="branch-delete-confirm"
            disabled={state.pending}
            onClick={remove}
          >
            {language.t("session.branch.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SessionBranchMenu(props: {
  session: Session
  deleteSession?: (session: Session) => Promise<boolean | void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  return (
    <ContextMenu.Group>
      <ContextMenu.GroupLabel class="max-w-64 truncate" title={props.session.title}>
        {language.t("session.branch.menu.title", { name: props.session.title })}
      </ContextMenu.GroupLabel>
      <SessionDetach session={props.session} context />
      <Show when={props.deleteSession}>
        {(remove) => (
          <ContextMenu.Item
            data-action="branch-delete"
            onSelect={() => {
              const session = props.session
              dialog.show(() => <Delete session={session} remove={remove()} />)
            }}
          >
            <ContextMenu.ItemLabel>{language.t("session.branch.delete")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        )}
      </Show>
    </ContextMenu.Group>
  )
}
