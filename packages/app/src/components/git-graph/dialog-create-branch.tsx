import { createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

interface DialogCreateBranchProps {
  hash: string
  branches: string[]
  initialName?: string
  initialCheckout?: boolean
  onAction: (opts: { name: string; checkout: boolean; force: boolean }) => void
}

export function DialogCreateBranch(props: DialogCreateBranchProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal(props.initialName ?? "")
  const [checkout, setCheckout] = createSignal(props.initialCheckout ?? false)
  const [conflict, setConflict] = createSignal(false)

  const submit = (force: boolean) => {
    const n = name().trim()
    if (!n) return
    dialog.close()
    props.onAction({ name: n, checkout: checkout(), force })
  }

  const confirm = () => {
    if (props.branches.includes(name().trim())) {
      setConflict(true)
      return
    }
    submit(false)
  }

  const t = (key: string) => language.t(key)

  return (
    <Dialog title="Create Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <Show
          when={conflict()}
          fallback={
            <>
              <p class="text-sm text-text-base">
                Create branch at commit <b>{props.hash.slice(0, 7)}</b>:
              </p>
              <TextField
                label="Name"
                value={name()}
                onChange={(value) => {
                  setName(value)
                  setConflict(false)
                }}
                placeholder={t("session.tab.gitGraph.createBranchNamePlaceholder")}
              />
              <Checkbox checked={checkout()} onChange={setCheckout}>
                Check out
              </Checkbox>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => dialog.close()}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={confirm} disabled={!name().trim()}>
                  Create Branch
                </Button>
              </div>
            </>
          }
        >
          <p class="text-sm text-text-base">
            A branch named <b>{name().trim()}</b> already exists, do you want to replace it with this new branch?
          </p>
          <div class="flex justify-end gap-2">
            <Button onClick={() => submit(true)}>Yes, replace the existing branch</Button>
            <Button variant="ghost" onClick={() => setConflict(false)}>
              No, choose another branch name
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
