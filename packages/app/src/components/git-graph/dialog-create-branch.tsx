import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

interface DialogCreateBranchProps {
  hash: string
  onAction: (opts: { name: string; checkout: boolean }) => void
}

export function DialogCreateBranch(props: DialogCreateBranchProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [checkout, setCheckout] = createSignal(false)

  const confirm = () => {
    const n = name().trim()
    if (!n) return
    dialog.close()
    props.onAction({ name: n, checkout: checkout() })
  }

  const t = (key: string) => language.t(key)
  const error = () => (name().trim() === "" ? undefined : undefined)

  return (
    <Dialog title={t("session.tab.gitGraph.createBranchTitle")} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <TextField
          label={t("session.tab.gitGraph.createBranchName")}
          value={name()}
          onChange={setName}
          placeholder={t("session.tab.gitGraph.createBranchNamePlaceholder")}
        />
        <Checkbox checked={checkout()} onChange={setCheckout}>
          {t("session.tab.gitGraph.createBranchCheckout")}
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm} disabled={!name().trim()}>
            {t("session.tab.gitGraph.createBranch")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
