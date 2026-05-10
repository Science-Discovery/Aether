import type { Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import type { RevertProtectionReason } from "@/pages/session/helpers"

type DialogRevertConfirmProps = {
  reason?: RevertProtectionReason
  onRevert?: VoidFunction
  onFork?: VoidFunction
}

const reasonDescriptions: Record<RevertProtectionReason, { titleKey: string; descKey: string }> = {
  "inherited-prefix": {
    titleKey: "dialog.revert.protected.inheritedPrefix.title",
    descKey: "dialog.revert.protected.inheritedPrefix.description",
  },
  "descendant-branch": {
    titleKey: "dialog.revert.protected.descendantBranch.title",
    descKey: "dialog.revert.protected.descendantBranch.description",
  },
  "incomplete-turn-inherited-prefix": {
    titleKey: "dialog.revert.protected.incompleteTurnInheritedPrefix.title",
    descKey: "dialog.revert.protected.incompleteTurnInheritedPrefix.description",
  },
  "session-busy": {
    titleKey: "dialog.revert.protected.sessionBusy.title",
    descKey: "dialog.revert.protected.sessionBusy.description",
  },
}

export const DialogRevertConfirm: Component<DialogRevertConfirmProps> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const close = () => dialog.close()

  const revert = () => {
    dialog.close()
    props.onRevert?.()
  }

  const fork = () => {
    dialog.close()
    props.onFork?.()
  }

  const reasonInfo = () => (props.reason ? reasonDescriptions[props.reason] : undefined)

  return (
    <Dialog
      title={props.reason ? language.t(reasonInfo()!.titleKey) : language.t("dialog.revert.confirm.title")}
      fit
      persistent
      class="w-full max-w-[480px] mx-auto"
    >
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          {props.reason ? language.t(reasonInfo()!.descKey) : language.t("dialog.revert.confirm.description")}
        </p>
        {props.reason ? (
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {language.t("common.cancel")}
            </Button>
            {props.onFork ? (
              <Button variant="secondary" onClick={fork}>
                {language.t("dialog.revert.forkAction")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {language.t("common.cancel")}
            </Button>
            <Button onClick={revert}>{language.t("dialog.revert.confirmAction")}</Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
