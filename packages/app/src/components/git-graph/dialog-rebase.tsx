import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

interface DialogRebaseProps {
  hash: string
  branch: string
  onAction: (opts: { ignoreDate: boolean }) => void
}

export function DialogRebase(props: DialogRebaseProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [ignoreDate, setIgnoreDate] = createSignal(true)

  const confirm = () => {
    dialog.close()
    props.onAction({ ignoreDate: ignoreDate() })
  }

  const t = (key: string) => language.t(key)

  return (
    <Dialog title={t("session.tab.gitGraph.rebaseTitle")} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          {t("session.tab.gitGraph.rebaseDescription")
            .replace("{hash}", props.hash.slice(0, 7))
            .replace("{branch}", props.branch)}
        </p>
        <Checkbox
          checked={ignoreDate()}
          onChange={setIgnoreDate}
          description={t("session.tab.gitGraph.rebaseIgnoreDateDescription")}
        >
          {t("session.tab.gitGraph.rebaseIgnoreDate")}
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>{t("session.tab.gitGraph.rebaseCurrent")}</Button>
        </div>
      </div>
    </Dialog>
  )
}
