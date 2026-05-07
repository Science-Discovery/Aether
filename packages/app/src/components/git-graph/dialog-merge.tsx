import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

interface DialogMergeProps {
  hash: string
  branch: string
  onAction: (opts: { noFastForward: boolean; squash: boolean; noCommit: boolean }) => void
}

export function DialogMerge(props: DialogMergeProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [noFastForward, setNoFastForward] = createSignal(true)
  const [squash, setSquash] = createSignal(false)
  const [noCommit, setNoCommit] = createSignal(false)

  const confirm = () => {
    dialog.close()
    props.onAction({
      noFastForward: noFastForward(),
      squash: squash(),
      noCommit: noCommit(),
    })
  }

  const t = (key: string) => language.t(key)

  return (
    <Dialog title={t("session.tab.gitGraph.mergeTitle")} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          {t("session.tab.gitGraph.mergeDescription")
            .replace("{hash}", props.hash.slice(0, 7))
            .replace("{branch}", props.branch)}
        </p>
        <Checkbox
          checked={noFastForward()}
          onChange={setNoFastForward}
          description={t("session.tab.gitGraph.mergeNoFastForward")}
        >
          {t("session.tab.gitGraph.mergeNoFastForward")}
        </Checkbox>
        <Checkbox
          checked={squash()}
          onChange={setSquash}
          description={t("session.tab.gitGraph.mergeSquashDescription")}
        >
          {t("session.tab.gitGraph.mergeSquash")}
        </Checkbox>
        <Checkbox
          checked={noCommit()}
          onChange={setNoCommit}
          description={t("session.tab.gitGraph.mergeNoCommitDescription")}
        >
          {t("session.tab.gitGraph.mergeNoCommit")}
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>{t("session.tab.gitGraph.mergeIntoCurrent")}</Button>
        </div>
      </div>
    </Dialog>
  )
}
