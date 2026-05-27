import type { Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

export const DialogDraftConflict: Component<{
  onAccept: VoidFunction
  onDiscard: VoidFunction
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const accept = () => {
    dialog.close()
    props.onAccept()
  }

  const discard = () => {
    dialog.close()
    props.onDiscard()
  }

  return (
    <Dialog
      title={language.t("draft.conflict.title")}
      description={language.t("draft.conflict.description")}
      persistent
    >
      <div class="flex items-center justify-end gap-2 p-4">
        <Button variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="secondary" onClick={discard}>
          {language.t("draft.conflict.discard")}
        </Button>
        <Button onClick={accept}>{language.t("draft.conflict.accept")}</Button>
      </div>
    </Dialog>
  )
}
