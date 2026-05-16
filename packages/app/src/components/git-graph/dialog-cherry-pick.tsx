import { createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

interface ParentOption {
  hash: string
  message: string
  index: number
}

interface DialogCherryPickProps {
  hash: string
  parents: ParentOption[]
  onAction: (opts: { parentIndex?: number; recordOrigin: boolean; noCommit: boolean }) => void
}

export function DialogCherryPick(props: DialogCherryPickProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const isMerge = props.parents.length > 1
  const [selectedParentIndex, setSelectedParentIndex] = createSignal(1)
  const [recordOrigin, setRecordOrigin] = createSignal(false)
  const [noCommit, setNoCommit] = createSignal(false)

  const confirm = () => {
    dialog.close()
    props.onAction({
      parentIndex: isMerge ? selectedParentIndex() : undefined,
      recordOrigin: recordOrigin(),
      noCommit: noCommit(),
    })
  }

  const t = (key: string) => language.t(key)
  const parentLabel = (o: ParentOption) => `${o.hash.slice(0, 7)}: ${o.message}`
  const selectedParent = () => props.parents.find((p) => p.index === selectedParentIndex())

  return (
    <Dialog title={t("session.tab.gitGraph.cherryPickTitle")} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to cherry pick commit <b>{props.hash.slice(0, 7)}</b>?
        </p>
        <Show when={isMerge}>
          <p class="text-sm text-text-base">
            Choose the parent hash on the main branch, to cherry pick the commit relative to.
          </p>
          <Select
            options={props.parents}
            current={selectedParent()}
            value={(o) => String(o.index)}
            label={parentLabel}
            onSelect={(v) => setSelectedParentIndex(v ? v.index : 1)}
            variant="outline"
            size="small"
          />
        </Show>
        <Checkbox
          checked={recordOrigin()}
          onChange={setRecordOrigin}
          description={'Record that this commit was the origin of the cherry pick by appending a line to the original commit message that states "(cherry picked from commit ...)."'}
        >
          Record Origin
        </Checkbox>
        <Checkbox
          checked={noCommit()}
          onChange={setNoCommit}
          description="Cherry picked changes will be staged but not committed, so that you can select and commit specific parts of this commit."
        >
          No Commit
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>Yes, cherry pick</Button>
        </div>
      </div>
    </Dialog>
  )
}
