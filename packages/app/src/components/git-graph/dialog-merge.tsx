import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"

interface DialogMergeProps {
  name: string
  branch: string
  actionOn: "Branch" | "Commit" | "Remote Tracking Branch"
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
    <Dialog title="Merge into Current Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to merge {props.actionOn.toLowerCase()} <b>{props.name}</b> into{" "}
          {props.branch ? (
            <>
              <b>{props.branch}</b> (the current branch)
            </>
          ) : (
            "the current branch"
          )}
          ?
        </p>
        <Checkbox
          checked={noFastForward()}
          onChange={setNoFastForward}
        >
          Create a new commit even if fast-forward is possible
        </Checkbox>
        <Checkbox
          checked={squash()}
          onChange={setSquash}
          description={`Create a single commit on the current branch whose effect is the same as merging this ${props.actionOn.toLowerCase()}.`}
        >
          Squash Commits
        </Checkbox>
        <Checkbox
          checked={noCommit()}
          onChange={setNoCommit}
          description="The changes of the merge will be staged but not committed, so that you can review and/or modify the merge result before committing."
        >
          No Commit
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button onClick={confirm}>Yes, merge</Button>
        </div>
      </div>
    </Dialog>
  )
}
