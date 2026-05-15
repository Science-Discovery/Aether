import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

interface DialogRebaseProps {
  name: string
  branch: string
  actionOn: "Branch" | "Commit"
  onAction: (opts: { ignoreDate: boolean; interactive: boolean }) => void
}

export function DialogRebase(props: DialogRebaseProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [ignoreDate, setIgnoreDate] = createSignal(true)
  const [interactive, setInteractive] = createSignal(false)

  const confirm = () => {
    dialog.close()
    props.onAction({ ignoreDate: ignoreDate(), interactive: interactive() })
  }

  const t = (key: string) => language.t(key)

  return (
    <Dialog title="Rebase Current Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to rebase{" "}
          {props.branch ? (
            <>
              <b>{props.branch}</b> (the current branch)
            </>
          ) : (
            "the current branch"
          )}{" "}
          on {props.actionOn.toLowerCase()} <b>{props.name}</b>?
        </p>
        <Checkbox checked={interactive()} onChange={setInteractive}>
          Launch Interactive Rebase in new Terminal
        </Checkbox>
        <Checkbox
          checked={ignoreDate()}
          onChange={setIgnoreDate}
          description="Only applicable to a non-interactive rebase."
        >
          Ignore Date
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>Yes, rebase</Button>
        </div>
      </div>
    </Dialog>
  )
}
